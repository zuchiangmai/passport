// End-to-end flows through the real Worker fetch handler and Better Auth on an in-memory
// SQLite D1. Resend is replaced by a capture. Covers the zero-impact guarantee with the
// switch off (on main's schema, without migration 0002) and per-client gating with it on.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import worker from "../index.ts";
import type { Env } from "../auth.ts";
import { SqliteD1 } from "../testing/sqlite-d1.ts";
import { bankSeedSql, clearBankCache } from "./bank.ts";

const SITE = "http://127.0.0.1:8788";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const bank = JSON.parse(readFileSync(new URL("../../quiz/bank.example.json", import.meta.url), "utf8")) as { id: string; answer: number }[];
// Columns of "user" and fields of a session user on main. The switch off must not add any.
const MAIN_USER_COLUMNS = ["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt"];
const MAIN_SESSION_USER_FIELDS = ["createdAt", "email", "emailVerified", "id", "image", "name", "updatedAt"];

type Mail = { to: string; text: string };
let mails: Mail[] = [];
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected network call to ${url}`);
    const body = JSON.parse(String(init?.body));
    mails.push({ to: body.to[0], text: body.text });
    return Response.json({ id: `test-${mails.length}` });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

let ipCounter = 0;

function setup(options: { mode?: "off" | "on"; schema?: "main" | "full"; clients?: string } = {}) {
  const { mode = "on", schema = "full" } = options;
  mails = [];
  clearBankCache();
  const d1 = SqliteD1.migrated(schema === "main" ? { before: "0002" } : {});
  if (schema === "full") d1.sqlite.exec(bankSeedSql(bank));
  const pending: Promise<unknown>[] = [];
  const env: Env = {
    DB: d1.asD1(),
    ENVIRONMENT: "test",
    EMAIL_BACKEND: "resend",
    RESEND_API_KEY: "re_test_not_a_real_key",
    BETTER_AUTH_URL: SITE,
    BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
    MAIL_FROM: "Passport Test <no-reply@example.test>",
    COLIVING_CLIENT_SECRET: "coliving-test-secret",
    LINK_SERVICE_KEY: "link-test-key",
    ...(mode === "on" ? { QUIZ_REGISTRATION: "on" } : {}),
    ...(options.clients !== undefined ? { QUIZ_CLIENTS: options.clients } : {}),
  };
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

  class Browser {
    readonly jar = new Map<string, string>();
    readonly ip = `198.51.100.${++ipCounter % 250}`;
    readonly userAgent: string;
    constructor(userAgent = UA) {
      this.userAgent = userAgent;
    }
    async request(path: string, body?: unknown, headers: Record<string, string> = {}) {
      const form = body instanceof URLSearchParams;
      const init: RequestInit = {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          Origin: SITE,
          "User-Agent": this.userAgent,
          "CF-Connecting-IP": this.ip,
          ...(body === undefined ? {} : { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" }),
          ...(this.jar.size ? { Cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: form ? body.toString() : JSON.stringify(body) }),
      };
      const response = await worker.fetch(new Request(SITE + path, init) as never, env, ctx);
      await Promise.all(pending.splice(0));
      for (const cookie of response.headers.getSetCookie()) {
        const [pair, ...attributes] = cookie.split(";");
        const index = pair.indexOf("=");
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (!value || attributes.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.jar.delete(name);
        else this.jar.set(name, value);
      }
      const text = await response.text();
      let json: Record<string, any> = {};
      try { json = JSON.parse(text); } catch {}
      return { status: response.status, json, text, headers: response.headers };
    }
  }

  const tables = () => (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  const userRow = (email: string) => d1.sqlite.prepare('SELECT * FROM "user" WHERE email = ?').get(email) as Record<string, unknown> | undefined;
  const quizRow = (userId: string) => d1.sqlite.prepare("SELECT * FROM quiz_registration WHERE user_id = ?").get(userId) as Record<string, any> | undefined;

  function codeFor(email: string) {
    const mail = mails.filter((m) => m.to === email).at(-1);
    assert.ok(mail, `a code was mailed to ${email}`);
    return /\b(\d{6})\b/.exec(mail.text)![1];
  }

  /** Any method of signing up or in. Email code here; social users are inserted with an account row. */
  async function signIn(email: string, browser = new Browser()) {
    d1.sqlite.prepare("DELETE FROM otp_send WHERE email = ?").run(email); // the 60 s resend cooldown
    const sent = await browser.request("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
    assert.equal(sent.status, 200, sent.text);
    const signedIn = await browser.request("/api/auth/sign-in/email-otp", { email, otp: codeFor(email) });
    assert.equal(signedIn.status, 200, signedIn.text);
    return { browser, user: signedIn.json.user as { id: string; email: string } };
  }

  /** Registers a confidential OIDC client the way an admin would, directly in D1. */
  async function createClient(name: string) {
    const secret = randomBytes(24).toString("base64url");
    const client = { client_id: `${name}-${randomBytes(4).toString("hex")}`, client_secret: secret, redirect_uris: [`https://${name}.example.test/auth/callback`] };
    const now = new Date().toISOString();
    d1.sqlite.prepare(`
      INSERT INTO "oauthClient" (id, clientId, clientSecret, skipConsent, scopes, redirectUris, tokenEndpointAuthMethod,
        grantTypes, responseTypes, applicationType, name, createdAt, updatedAt, disabled)
      VALUES (?, ?, ?, 1, ?, ?, 'client_secret_post', ?, ?, 'web', ?, ?, ?, 0)
    `).run(randomBytes(8).toString("hex"), client.client_id, createHash("sha256").update(secret).digest("base64url"),
      JSON.stringify(["openid", "email", "profile"]), JSON.stringify(client.redirect_uris),
      JSON.stringify(["authorization_code"]), JSON.stringify(["code"]), name, now, now);
    return client;
  }

  /** Starts an OIDC authorization. Returns the code, or where Passport sent the user instead. */
  async function authorize(browser: Browser, client: { client_id: string; redirect_uris: string[] }) {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: client.redirect_uris[0],
      scope: "openid email profile", state: "s-1", code_challenge: challenge, code_challenge_method: "S256",
    });
    const response = await browser.request(`/api/auth/oauth2/authorize?${params}`);
    const location = response.headers.get("location") ?? response.json.url;
    assert.ok(location, `authorize redirects: ${response.status} ${response.text}`);
    return { location: String(location), verifier, ...redirectResult(String(location), client) };
  }

  function redirectResult(location: string, client: { redirect_uris: string[] }) {
    const url = new URL(location, SITE);
    if (location.startsWith(client.redirect_uris[0])) return { code: url.searchParams.get("code") };
    return { code: null, page: url.pathname, query: url.search.slice(1) };
  }

  async function exchange(client: { client_id: string; client_secret: string; redirect_uris: string[] }, code: string, verifier: string) {
    const token = await new Browser().request("/api/auth/oauth2/token", new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: client.redirect_uris[0], code_verifier: verifier,
      client_id: client.client_id, client_secret: client.client_secret,
    }));
    assert.equal(token.status, 200, token.text);
    const userinfo = await new Browser().request("/api/auth/oauth2/userinfo", undefined, { Authorization: `Bearer ${token.json.access_token}` });
    assert.equal(userinfo.status, 200, userinfo.text);
    return { token: token.json, userinfo: userinfo.json };
  }

  async function answers(attemptId: string, correct: number) {
    const row = d1.sqlite.prepare("SELECT items FROM quiz_attempt WHERE id = ?").get(attemptId) as { items: string };
    return (JSON.parse(row.items) as { id: string; perm: number[] }[]).map((item, k) => {
      const right = item.perm.indexOf(bank.find((q) => q.id === item.id)!.answer);
      return k < correct ? right : (right + 1) % item.perm.length;
    });
  }

  async function takeQuiz(browser: Browser, correct: number) {
    const started = await browser.request("/api/auth/quiz/start", {});
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.status, "quiz");
    return browser.request("/api/auth/quiz/submit", { attemptId: started.json.attemptId, answers: await answers(started.json.attemptId, correct) });
  }

  return { d1, env, Browser, tables, userRow, quizRow, codeFor, signIn, createClient, authorize, redirectResult, exchange, takeQuiz };
}

// ---------- switch off: zero impact, on main's schema ----------

test("off, main schema: email sign-up and sign-in work and user rows and sessions match main", async () => {
  const { tables, userRow, signIn } = setup({ mode: "off", schema: "main" });
  assert.ok(!tables().some((name) => name.startsWith("quiz_")), "no quiz tables exist");
  const { browser, user } = await signIn("open@example.test");
  assert.deepEqual(Object.keys(userRow("open@example.test")!), MAIN_USER_COLUMNS);
  const session = await browser.request("/api/auth/get-session");
  assert.equal(session.json.user.id, user.id);
  assert.deepEqual(Object.keys(session.json.user).sort(), MAIN_SESSION_USER_FIELDS);
  assert.equal((await signIn("open@example.test")).user.id, user.id, "returning sign-in");
});

test("off, main schema: OIDC clients get codes and standard claims only, even if QUIZ_CLIENTS is set", async () => {
  const ctx = setup({ mode: "off", schema: "main" });
  const client = await ctx.createClient("topic-research");
  ctx.env.QUIZ_CLIENTS = client.client_id; // ignored while the switch is off
  const { browser } = await ctx.signIn("reader@example.test");
  const started = await ctx.authorize(browser, client);
  assert.ok(started.code, `code issued directly, got ${started.location}`);
  const { userinfo, token } = await ctx.exchange(client, started.code!, started.verifier);
  assert.deepEqual(Object.keys(userinfo).sort(), ["email", "email_verified", "name", "sub"]);
  const idClaims = JSON.parse(Buffer.from(String(token.id_token).split(".")[1], "base64url").toString());
  assert.ok(!Object.keys(idClaims).some((key) => key.includes("quiz") || key.includes("registration")));
});

test("off, main schema: CoLiving link, legacy authorize and token exchange work", async () => {
  const { Browser, signIn, userRow } = setup({ mode: "off", schema: "main" });
  const linked = await new Browser().request("/v1/identity/links", { email: "resident@example.test", app: "coliving", external_id: "r-1" }, { "X-Service-Key": "link-test-key" });
  assert.equal(linked.status, 200, linked.text);
  assert.deepEqual(Object.keys(userRow("resident@example.test")!), MAIN_USER_COLUMNS);
  const { browser } = await signIn("resident@example.test");
  const authorized = await browser.request("/v1/connect/authorize", { client_id: "coliving", redirect_uri: "https://4seas.xyz/coliving/auth/callback", state: "st" });
  assert.equal(authorized.status, 200, authorized.text);
  const exchanged = await new Browser().request("/v1/connect/token", {
    client_id: "coliving", client_secret: "coliving-test-secret", code: authorized.json.code, redirect_uri: "https://4seas.xyz/coliving/auth/callback",
  });
  assert.equal(exchanged.status, 200, exchanged.text);
  assert.equal(exchanged.json.sub, authorized.json.sub);
});

test("off, main schema: legacy passcode API works", async () => {
  const { Browser, codeFor } = setup({ mode: "off", schema: "main" });
  const browser = new Browser();
  assert.equal((await browser.request("/v1/auth/passcode/request", { email: "app@example.test" })).status, 202);
  const verified = await browser.request("/v1/auth/passcode/verify", { email: "app@example.test", code: codeFor("app@example.test") });
  assert.equal(verified.status, 200, verified.text);
  assert.equal(verified.json.email, "app@example.test");
});

test("off: the quiz page and endpoints do not exist", async () => {
  const { Browser, signIn } = setup({ mode: "off", schema: "main" });
  const { browser } = await signIn("x@example.test");
  assert.equal((await browser.request("/api/auth/quiz/start", {})).status, 404);
  assert.equal((await new Browser().request("/passport/quiz")).status, 404);
});

test("the sign-in page is byte-identical with the switch on and off", async () => {
  const strip = (html: string) => html.replace(/nonce-?[="]?[A-Za-z0-9-]{36}"?/g, "NONCE").replace(/nonce="[^"]+"/g, "NONCE");
  for (const language of ["en", "zh", "th"]) {
    const off = await new (setup({ mode: "off", schema: "main" }).Browser)().request(`/passport/${language}/login`);
    const on = await new (setup({ mode: "on", clients: "topic-research" }).Browser)().request(`/passport/${language}/login`);
    assert.equal(off.status, 200);
    assert.equal(strip(on.text), strip(off.text), language);
  }
});

// ---------- switch on: only listed clients are gated ----------

test("on: a quiz client sends a new user to the quiz after sign-in, then issues a code once passed", async () => {
  const ctx = setup();
  const client = await ctx.createClient("topic-research");
  ctx.env.QUIZ_CLIENTS = client.client_id;
  const { browser, user } = await ctx.signIn("newbie@example.test");

  const first = await ctx.authorize(browser, client);
  assert.equal(first.code, null);
  assert.equal(first.page, "/quiz");
  const page = await browser.request(`/quiz?${first.query}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="quiz-form"/);

  // Skipping the quiz does not help: continuing re-checks the database.
  const skipped = await browser.request("/api/auth/oauth2/continue", { postLogin: true, oauth_query: first.query });
  assert.equal(ctx.redirectResult(skipped.json.url, client).page, "/quiz");

  const submitted = await ctx.takeQuiz(browser, 2);
  assert.equal(submitted.json.passed, true);
  assert.equal(submitted.json.recorded, true);
  const row = ctx.quizRow(user.id)!;
  assert.equal(row.registration_method, "email");
  assert.equal(row.score, 2);
  assert.ok(row.quiz_passed_at > Date.now() - 60_000);

  const continued = await browser.request("/api/auth/oauth2/continue", { postLogin: true, oauth_query: first.query });
  const result = ctx.redirectResult(continued.json.url, client);
  assert.ok(result.code, continued.text);
  const { userinfo } = await ctx.exchange(client, result.code!, first.verifier);
  assert.equal(userinfo.email, "newbie@example.test");

  const again = await ctx.authorize(browser, client);
  assert.ok(again.code, "a passed user goes straight through next time");
  assert.deepEqual(Object.keys(ctx.userRow("newbie@example.test")!), MAIN_USER_COLUMNS, "the user table is unchanged");
});

test("on: failing keeps the quiz client closed and sets a cooldown", async () => {
  const ctx = setup();
  const client = await ctx.createClient("topic-research");
  ctx.env.QUIZ_CLIENTS = client.client_id;
  const { browser, user } = await ctx.signIn("fail@example.test");
  const first = await ctx.authorize(browser, client);
  const failed = await ctx.takeQuiz(browser, 1);
  assert.equal(failed.json.passed, false);
  assert.equal(failed.json.recorded, false);
  assert.ok(failed.json.retryAt - Date.now() > 23 * 3600_000);
  assert.equal(failed.json.review.length, 3);
  assert.equal(ctx.quizRow(user.id), undefined);
  const continued = await browser.request("/api/auth/oauth2/continue", { postLogin: true, oauth_query: first.query });
  assert.equal(ctx.redirectResult(continued.json.url, client).page, "/quiz");
  const retry = await browser.request("/api/auth/quiz/start", {});
  assert.equal(retry.status, 429);
  assert.equal(retry.json.code, "QUIZ_COOLDOWN");
});

test("on: users who signed up with Google or GitHub take the same quiz, and the method is recorded", async () => {
  const ctx = setup();
  const client = await ctx.createClient("topic-research");
  ctx.env.QUIZ_CLIENTS = client.client_id;
  const now = new Date().toISOString();
  ctx.d1.sqlite.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u-gh', 'G', 'gh@example.test', 1, '${now}', '${now}');
    INSERT INTO "account" (id, accountId, providerId, userId, createdAt, updatedAt) VALUES ('a-gh', '123', 'github', 'u-gh', '${now}', '${now}');
  `);
  const { browser } = await ctx.signIn("gh@example.test");
  assert.equal((await ctx.authorize(browser, client)).page, "/quiz");
  await ctx.takeQuiz(browser, 3);
  assert.equal(ctx.quizRow("u-gh")!.registration_method, "github");
  assert.ok((await ctx.authorize(browser, client)).code);
});

test("on: other OIDC clients are unaffected for users who never took the quiz", async () => {
  const ctx = setup();
  const topic = await ctx.createClient("topic-research");
  const other = await ctx.createClient("other-app");
  ctx.env.QUIZ_CLIENTS = topic.client_id;
  const { browser, user } = await ctx.signIn("someone@example.test");
  const started = await ctx.authorize(browser, other);
  assert.ok(started.code, `no quiz for other clients, got ${started.location}`);
  const { userinfo } = await ctx.exchange(other, started.code!, started.verifier);
  assert.deepEqual(Object.keys(userinfo).sort(), ["email", "email_verified", "name", "sub"]);
  assert.equal(ctx.quizRow(user.id), undefined);
});

test("on: imported members (quiz_preapproved) reach a quiz client without the quiz", async () => {
  const ctx = setup();
  const topic = await ctx.createClient("topic-research");
  ctx.env.QUIZ_CLIENTS = topic.client_id;
  ctx.d1.sqlite.prepare("INSERT INTO quiz_preapproved (email, source, created_at) VALUES (?, 'topic-research', ?)").run("member@example.test", Date.now());
  const { browser, user } = await ctx.signIn("member@example.test");
  const started = await ctx.authorize(browser, topic);
  assert.ok(started.code, `preapproved member gets a code, got ${started.location}`);
  assert.equal(ctx.quizRow(user.id)?.total, 0, "recorded as preapproved (0 of 0)");
  const { browser: stranger } = await ctx.signIn("stranger@example.test");
  assert.equal((await ctx.authorize(stranger, topic)).page, "/quiz", "others still take the quiz");
});

test("on with an empty QUIZ_CLIENTS: no client is gated", async () => {
  const ctx = setup({ clients: "" });
  const client = await ctx.createClient("topic-research");
  const { browser } = await ctx.signIn("free@example.test");
  assert.ok((await ctx.authorize(browser, client)).code);
});

test("on: CoLiving, canteen links and the legacy passcode API are unaffected", async () => {
  const { Browser, signIn, codeFor } = setup({ clients: "topic-research" });
  const linked = await new Browser().request("/v1/identity/links", { email: "resident@example.test", app: "coliving", external_id: "r-1" }, { "X-Service-Key": "link-test-key" });
  assert.equal(linked.status, 200);
  const { browser } = await signIn("resident@example.test");
  const authorized = await browser.request("/v1/connect/authorize", { client_id: "coliving", redirect_uri: "https://4seas.xyz/coliving/auth/callback", state: "st" });
  assert.equal(authorized.status, 200, authorized.text);
  const exchanged = await new Browser().request("/v1/connect/token", {
    client_id: "coliving", client_secret: "coliving-test-secret", code: authorized.json.code, redirect_uri: "https://4seas.xyz/coliving/auth/callback",
  });
  assert.equal(exchanged.status, 200);
  const api = new Browser();
  assert.equal((await api.request("/v1/auth/passcode/request", { email: "brand-new@example.test" })).status, 202, "sign-up stays open");
  assert.equal((await api.request("/v1/auth/passcode/verify", { email: "brand-new@example.test", code: codeFor("brand-new@example.test") })).status, 200);
});

test("on: quiz endpoints need a session, refuse bots, and report an empty bank", async () => {
  const ctx = setup({ clients: "topic-research" });
  assert.equal((await new ctx.Browser().request("/api/auth/quiz/start", {})).status, 401);
  const { browser } = await ctx.signIn("x@example.test");
  const bot = new ctx.Browser("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
  for (const [k, v] of browser.jar) bot.jar.set(k, v);
  assert.equal((await bot.request("/api/auth/quiz/start", {})).status, 403);
  ctx.d1.sqlite.exec("UPDATE quiz_question SET active = 0");
  clearBankCache();
  const empty = await browser.request("/api/auth/quiz/start", {});
  assert.equal(empty.status, 503);
  assert.equal(empty.json.code, "QUIZ_UNAVAILABLE");
});

test("on: an attempt is scored once and already-passed users skip the quiz", async () => {
  const ctx = setup({ clients: "topic-research" });
  const { browser } = await ctx.signIn("once@example.test");
  const started = await browser.request("/api/auth/quiz/start", {});
  const body = { attemptId: started.json.attemptId, answers: [0, 0, 0] };
  await browser.request("/api/auth/quiz/submit", body);
  const replay = await browser.request("/api/auth/quiz/submit", body);
  assert.equal(replay.status, 410);
  const other = await ctx.signIn("passer@example.test");
  await ctx.takeQuiz(other.browser, 3);
  assert.deepEqual((await other.browser.request("/api/auth/quiz/start", {})).json, { status: "passed" });
  const status = await other.browser.request("/api/auth/quiz/status");
  assert.equal(status.json.passed, true);
});

test("on: the quiz page needs a signed query and a session, in every language", async () => {
  const ctx = setup();
  const client = await ctx.createClient("topic-research");
  ctx.env.QUIZ_CLIENTS = client.client_id;
  const { browser } = await ctx.signIn("pages@example.test");
  const { query } = await ctx.authorize(browser, client);
  assert.equal((await browser.request("/quiz?client_id=x")).status, 400, "unsigned query");
  assert.equal((await new ctx.Browser().request(`/quiz?${query}`)).status, 401, "no session");
  for (const language of ["en", "zh", "th"]) {
    const page = await browser.request(`/passport/${language}/quiz?${query}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /id="quiz-form"/);
  }
});

test("on: signing in on Passport's login page during an OIDC request goes to the quiz only for quiz clients", async () => {
  const ctx = setup();
  const topic = await ctx.createClient("topic-research");
  const other = await ctx.createClient("other-app");
  ctx.env.QUIZ_CLIENTS = topic.client_id;
  for (const [client, gated] of [[topic, true], [other, false]] as const) {
    const browser = new ctx.Browser();
    const email = `login-${gated}@example.test`;
    const start = await ctx.authorize(browser, client);
    assert.equal(start.page, "/sign-in", "not signed in yet");
    await browser.request("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
    const signedIn = await browser.request("/api/auth/sign-in/email-otp", { email, otp: ctx.codeFor(email), oauth_query: start.query });
    assert.equal(signedIn.status, 200, signedIn.text);
    assert.equal(signedIn.json.redirect, true);
    const next = ctx.redirectResult(signedIn.json.url, client);
    if (gated) assert.equal(next.page, "/quiz");
    else assert.ok(next.code, `other client gets a code, got ${signedIn.json.url}`);
  }
});
