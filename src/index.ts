import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
  verifyOAuthQueryParams,
} from "@better-auth/oauth-provider";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AUTH_PATH, createAuth, normalizeEmail, SEND_OTP, SIGN_IN_OTP, socialProviders, type Env } from "./auth.ts";
import { consentPage, signInPage } from "./pages.ts";
import { checkRedirect, client_secret_ok, PolicyError } from "./policy/clients.ts";
import { authorizeGate, ensureLink, snapshot, type AppLink } from "./policy/links.ts";

type Auth = ReturnType<typeof createAuth>;
type PassportUser = Parameters<typeof snapshot>[0];

const error = (status: number, code: string) =>
  Response.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });

function stripPassport(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname === "/passport" || url.pathname.startsWith("/passport/")) {
    url.pathname = url.pathname.slice("/passport".length) || "/";
    return new Request(url, request);
  }
  return request;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest();
}

function serviceKeyOk(presented: string | null, expected?: string): boolean {
  return Boolean(presented?.trim() && expected?.trim() && timingSafeEqual(sha256(presented), sha256(expected)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function jsonObject(request: Request) {
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const value: unknown = await request.json().catch(() => null);
  return isObject(value) ? value : null;
}

function otpRequest(auth: Auth, request: Request, endpoint: string, body: object) {
  const url = new URL(request.url);
  url.pathname = AUTH_PATH + endpoint;
  url.search = "";
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" });
  for (const name of ["cf-connecting-ip", "origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return auth.handler(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function passcode(auth: Auth, request: Request, body: Record<string, unknown>, send: boolean) {
  const email = normalizeEmail(body.email);
  if (!email) return error(400, "invalid_email");

  if (send) {
    const response = await otpRequest(auth, request, SEND_OTP, { email, type: "sign-in" });
    if (response.status === 429) return error(429, "cooldown");
    if (response.ok) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
    return error(response.status, response.status === 400 ? "invalid_email" : "request_failed");
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return error(401, "invalid_code");
  const response = await otpRequest(auth, request, SIGN_IN_OTP, { email, otp: code });
  if (response.status === 429) return error(429, "rate_limited");
  if (response.status >= 500) return error(500, "internal_error");
  if (!response.ok) return error(401, "invalid_code");

  const result: unknown = await response.json();
  if (!isObject(result) || !isObject(result.user) || typeof result.user.id !== "string" ||
      typeof result.user.email !== "string") {
    return error(500, "internal_error");
  }
  return Response.json(
    { sub: result.user.id, email: result.user.email },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function appLinks(db: D1Database, sub: string) {
  const { results } = await db.prepare(
    "SELECT user_id, app, external_id FROM app_link WHERE user_id = ?",
  ).bind(sub).all<AppLink>();
  return results;
}

interface UserRow {
  id: string;
  email: string;
  emailVerified: number;
  name: string;
}

function passportUser(row: UserRow): PassportUser {
  return { id: row.id, email: row.email, emailVerified: Boolean(row.emailVerified), name: row.name || null };
}

async function linkIdentity(db: D1Database, body: Record<string, unknown>) {
  const email = normalizeEmail(body.email);
  if (!email) return error(400, "invalid_email");
  const { app, external_id: externalId, display_name: name } = body;
  if (app !== "coliving" && app !== "canteen") return error(404, "not_found");
  if (typeof externalId !== "string" || !externalId.trim() ||
      (name !== undefined && name !== null && typeof name !== "string")) {
    return error(400, "invalid_request");
  }
  let user = await db.prepare("SELECT id, email, emailVerified, name FROM user WHERE email = ?")
    .bind(email).first<UserRow>();
  if (!user) {
    authorizeGate(app, []);
    const now = new Date().toISOString();
    // An existing external ID may not provision a second user.
    await db.prepare(`
      INSERT INTO user (id, email, emailVerified, name, createdAt, updatedAt)
      SELECT ?1, ?2, 1, ?3, ?4, ?4
      WHERE NOT EXISTS (SELECT 1 FROM app_link WHERE app = ?5 AND external_id = ?6)
      ON CONFLICT(email) DO NOTHING
    `).bind(crypto.randomUUID(), email, name?.trim() ?? "", now, app, externalId.trim()).run();
    user = await db.prepare("SELECT id, email, emailVerified, name FROM user WHERE email = ?")
      .bind(email).first<UserRow>();
    if (!user) return error(409, "conflict");
  }

  await ensureLink(db, { sub: user.id, app, externalId });
  const displayName = name?.trim() || "";
  if ((app === "coliving" && !user.emailVerified) || (displayName && !user.name)) {
    user = await db.prepare(`
      UPDATE user SET
        emailVerified = CASE WHEN ?1 = 'coliving' THEN 1 ELSE emailVerified END,
        name = CASE WHEN name = '' THEN ?2 ELSE name END,
        updatedAt = ?3
      WHERE id = ?4 RETURNING id, email, emailVerified, name
    `).bind(app, displayName, new Date().toISOString(), user.id).first<UserRow>();
    if (!user) return error(404, "not_found");
  }
  return Response.json(snapshot(passportUser(user), await appLinks(db, user.id)), {
    headers: { "Cache-Control": "no-store" },
  });
}

async function authorize(auth: Auth, env: Env, request: Request, body: Record<string, unknown>) {
  const { client_id: clientId, redirect_uri: redirectUri, state } = body;
  if (typeof clientId !== "string" || typeof redirectUri !== "string" ||
      typeof state !== "string" || !state || state.length > 500) {
    return error(400, "invalid_request");
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(env.BETTER_AUTH_URL).origin) return error(403, "forbidden");
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error(401, "unauthorized");
  checkRedirect(clientId, redirectUri);

  const sub = session.user.id;
  authorizeGate(clientId, await appLinks(env.DB, sub));
  const code = randomBytes(32).toString("hex");
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO auth_code (id, user_id, client_id, redirect_uri, code_hash, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), sub, clientId, redirectUri, sha256(code).toString("hex"), now + 300_000).run();

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", state);
  return Response.json(
    { code, redirect_to: redirect.href, sub },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function exchange(env: Env, body: Record<string, unknown>) {
  const { client_id: clientId, client_secret: secret, code, redirect_uri: redirectUri } = body;
  const expected = clientId === "coliving" ? env.COLIVING_CLIENT_SECRET
    : clientId === "canteen" ? env.CANTEEN_CLIENT_SECRET : undefined;
  if (typeof secret !== "string" || !client_secret_ok(secret, expected)) return error(401, "invalid_client");
  if (typeof clientId !== "string" || typeof code !== "string" || !code ||
      typeof redirectUri !== "string") return error(400, "invalid_request");
  checkRedirect(clientId, redirectUri);

  const hash = sha256(code).toString("hex");
  const row = await env.DB.prepare(`
    SELECT id, user_id, expires_at FROM auth_code
    WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND consumed_at IS NULL
  `).bind(hash, clientId, redirectUri).first<{ id: string; user_id: string; expires_at: number }>();
  if (!row) return error(401, "invalid_code");
  if (row.expires_at <= Date.now()) return error(410, "code_expired");

  const user = await env.DB.prepare("SELECT id, email, emailVerified, name FROM user WHERE id = ?")
    .bind(row.user_id).first<UserRow>();
  if (!user) return error(401, "invalid_code");
  const links = await appLinks(env.DB, user.id);
  authorizeGate(clientId, links);

  // The conditional update allows only one exchange, including concurrent requests.
  const now = Date.now();
  const consumed = await env.DB.prepare(`
    UPDATE auth_code SET consumed_at = ?1
    WHERE id = ?2 AND consumed_at IS NULL AND expires_at > ?1
      AND (?3 <> 'canteen' OR EXISTS (
        SELECT 1 FROM app_link WHERE user_id = ?4 AND app = 'coliving'
      ))
    RETURNING id
  `).bind(now, row.id, clientId, user.id).first();
  if (!consumed) {
    if (row.expires_at <= now) return error(410, "code_expired");
    if (clientId === "canteen") authorizeGate(clientId, await appLinks(env.DB, user.id));
    return error(401, "invalid_code");
  }
  return Response.json(snapshot(passportUser(user), links), { headers: { "Cache-Control": "no-store" } });
}

async function handle(request: Request, env: Env, ctx: ExecutionContext) {
  request = stripPassport(request);
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/healthz") {
    return Response.json({ status: "ok", service: "passport", stack: "better-auth" });
  }

  if (request.method === "GET") {
    if (path === "/.well-known/oauth-authorization-server" ||
        path === "/.well-known/oauth-authorization-server/api/auth") {
      return oauthProviderAuthServerMetadata(createAuth(env, ctx))(request);
    }
    if (path === "/.well-known/openid-configuration" || path === AUTH_PATH + "/.well-known/openid-configuration") {
      return oauthProviderOpenIdConfigMetadata(createAuth(env, ctx))(request);
    }
    if (path === "/sign-in" || path === "/consent") {
      const auth = createAuth(env, ctx);
      const query = url.searchParams.toString();
      const signed = url.searchParams.has("sig");
      if ((signed || path === "/consent") &&
          !(await verifyOAuthQueryParams(query, (await auth.$context).secret))) {
        return error(400, "invalid_oauth_query");
      }
      if (path === "/sign-in") return signInPage(signed ? query : "", socialProviders(env));
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return error(401, "unauthorized");
      return consentPage(query, url.searchParams.get("client_id") ?? "", url.searchParams.get("scope") ?? "");
    }
  }
  if (path.startsWith(AUTH_PATH + "/")) return createAuth(env, ctx).handler(request);

  if (request.method === "POST") {
    switch (path) {
      case "/v1/auth/passcode/request":
      case "/v1/auth/passcode/verify":
      case "/v1/identity/links":
      case "/v1/connect/authorize":
      case "/v1/connect/token": {
        if (path === "/v1/identity/links" && !serviceKeyOk(request.headers.get("X-Service-Key"), env.LINK_SERVICE_KEY)) {
          return error(401, "unauthorized");
        }
        const body = await jsonObject(request);
        if (!body) return error(400, "invalid_request");
        if (path === "/v1/identity/links") return linkIdentity(env.DB, body);
        if (path === "/v1/connect/token") return exchange(env, body);
        const auth = createAuth(env, ctx);
        if (path === "/v1/connect/authorize") return authorize(auth, env, request, body);
        return passcode(auth, request, body, path === "/v1/auth/passcode/request");
      }
    }
  }
  return error(404, "not_found");
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (cause) {
      if (cause instanceof PolicyError) {
        const statuses = { forbidden: 403, canteen_requires_coliving: 403, not_found: 404, conflict: 409 };
        return error(statuses[cause.code], cause.code);
      }
      return error(500, "internal_error");
    }
  },
} satisfies ExportedHandler<Env>;
