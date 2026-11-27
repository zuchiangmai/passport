import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import { APIError, createAuthEndpoint, getOAuthState, sessionMiddleware } from "better-auth/api";
import { isLikelyBot, type QuizGate } from "../../packages/quiz-gate/src/index.ts";
import { passportLanguage, preferredLanguage } from "../locale.ts";

/**
 * Master switch. `off` (default): the plugin is not registered, no quiz table is read or
 * written, and Passport behaves exactly like main. `on`: clients in QUIZ_CLIENTS require
 * a passed quiz before they get an authorization code. Every other client is unaffected.
 */
export type QuizMode = "off" | "on";

export function quizMode(value: string | undefined): QuizMode {
  return value?.trim().toLowerCase() === "on" ? "on" : "off";
}

/** QUIZ_CLIENTS=topic-research,other-site */
export function quizClients(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

export type QuizRecord = { registrationMethod: string; quizPassedAt: number; score: number; total: number };

export async function quizRecord(db: D1Database, userId: string): Promise<QuizRecord | null> {
  const row = await db.prepare(
    "SELECT registration_method, quiz_passed_at, score, total FROM quiz_registration WHERE user_id = ?1",
  ).bind(userId).first<{ registration_method: string; quiz_passed_at: number; score: number; total: number }>();
  return row && { registrationMethod: row.registration_method, quizPassedAt: row.quiz_passed_at, score: row.score, total: row.total };
}

/** How the account was created: its first linked provider, otherwise email. */
async function registrationMethod(db: D1Database, userId: string): Promise<string> {
  const provider = await db.prepare(
    'SELECT "providerId" AS provider FROM "account" WHERE "userId" = ?1 ORDER BY "createdAt" ASC LIMIT 1',
  ).bind(userId).first<string>("provider");
  return provider ?? "email";
}

function header(ctx: { headers?: Headers; request?: Request }, name: string) {
  return ctx.headers?.get(name) ?? ctx.request?.headers.get(name) ?? null;
}

function language(ctx: { headers?: Headers; request?: Request }) {
  return passportLanguage(header(ctx, "x-passport-language")) ?? preferredLanguage(header(ctx, "accept-language"));
}

function clientIdIn(query: unknown): string | null {
  if (typeof query !== "string" || !query) return null;
  return new URLSearchParams(query).get("client_id") || null;
}

/**
 * client_id of the authorization request being processed: the authorize query, a signed
 * oauth_query in the body (email code and passkey sign-in, /oauth2/continue), or the
 * request state oauthProvider keeps across a Google or GitHub callback.
 */
export async function currentClientId(): Promise<string | null> {
  const ctx = tryGetCurrentAuthEndpointContext() as { query?: Record<string, unknown>; body?: Record<string, unknown> } | undefined;
  const fromQuery = ctx?.query?.client_id;
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  const fromBody = clientIdIn(ctx?.body?.oauth_query);
  if (fromBody) return fromBody;
  const providerState = await Promise.resolve().then(() => getOAuthProviderState()).catch(() => null);
  const fromProvider = clientIdIn(providerState?.query);
  if (fromProvider) return fromProvider;
  const socialState = await Promise.resolve().then(() => getOAuthState()).catch(() => null);
  return clientIdIn((socialState as { serverContext?: { query?: unknown } } | null)?.serverContext?.query);
}

/**
 * The oauthProvider `postLogin` option. After sign-in (by any method) and before a code is
 * issued, a quiz client sends users without a recorded pass to the quiz page. Other clients
 * never redirect. The check reads the database again on continuation, so skipping the page
 * does not help.
 */
export function quizPostLogin(options: { db: D1Database; clients: Set<string>; page: string }) {
  return {
    page: options.page,
    consentReferenceId: () => undefined,
    async shouldRedirect({ user }: { user: { id: string } }) {
      const clientId = await currentClientId();
      // If a quiz client is configured but the client cannot be identified, fail closed.
      if (clientId === null) return options.clients.size > 0 && !(await quizRecord(options.db, user.id));
      if (!options.clients.has(clientId)) return false;
      return !(await quizRecord(options.db, user.id));
    },
  };
}

/** Quiz endpoints for the signed-in user. Registered only when QUIZ_REGISTRATION=on. */
export function quizRegistration(options: { gate: QuizGate; db: D1Database }) {
  const { gate, db } = options;
  const notBot = (ctx: { headers?: Headers; request?: Request }) => {
    if (isLikelyBot(header(ctx, "user-agent"))) throw new APIError("FORBIDDEN", { code: "BOT", message: "Forbidden" });
  };

  return {
    id: "quiz-registration",
    rateLimit: [{ pathMatcher: (path: string) => path.startsWith("/quiz/"), window: 60, max: 10 }],
    endpoints: {
      quizStatus: createAuthEndpoint("/quiz/status", { method: "GET", use: [sessionMiddleware] }, async (ctx) => {
        const record = await quizRecord(db, ctx.context.session.user.id);
        return ctx.json({ passed: Boolean(record), ...(record ?? {}) });
      }),
      quizStart: createAuthEndpoint("/quiz/start", { method: "POST", use: [sessionMiddleware] }, async (ctx) => {
        notBot(ctx);
        const { user } = ctx.context.session;
        if (await quizRecord(db, user.id)) return ctx.json({ status: "passed" });
        const ip = header(ctx, "cf-connecting-ip") ?? header(ctx, "x-forwarded-for")?.split(",")[0].trim() ?? null;
        const result = await gate.start({ email: user.email, ip, language: language(ctx) });
        if (!result.ok) {
          if (result.error === "bank_empty" || result.error === "invalid_email") {
            throw new APIError("SERVICE_UNAVAILABLE", { code: "QUIZ_UNAVAILABLE", message: "The quiz is not available" });
          }
          throw new APIError("TOO_MANY_REQUESTS", {
            code: result.error === "cooldown" ? "QUIZ_COOLDOWN" : "QUIZ_LIMIT",
            message: result.error === "cooldown" ? "Retry the quiz later" : "Too many quiz attempts today",
            retryAt: result.retryAt,
          });
        }
        return ctx.json({
          status: "quiz",
          attemptId: result.attemptId,
          expiresAt: result.expiresAt,
          passScore: result.passScore,
          questions: result.questions,
        });
      }),
      quizSubmit: createAuthEndpoint("/quiz/submit", { method: "POST", use: [sessionMiddleware] }, async (ctx) => {
        notBot(ctx);
        const { user } = ctx.context.session;
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const result = await gate.submit({ email: user.email, attemptId: body.attemptId, answers: body.answers, language: language(ctx) });
        if (!result.ok) {
          throw new APIError("GONE", { code: "QUIZ_ATTEMPT_INVALID", message: "This quiz expired or was already submitted" });
        }
        let recorded = false;
        if (result.pass && await gate.consumePass(result.pass.token, user.email)) {
          await db.prepare(`
            INSERT INTO quiz_registration (user_id, registration_method, quiz_passed_at, score, total)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(user_id) DO NOTHING
          `).bind(user.id, await registrationMethod(db, user.id), Date.now(), result.score, result.total).run();
          recorded = true;
        }
        return ctx.json({
          passed: result.passed,
          score: result.score,
          total: result.total,
          passScore: result.passScore,
          review: result.review,
          retryAt: result.retryAt,
          recorded,
        });
      }),
    },
  } satisfies BetterAuthPlugin;
}
