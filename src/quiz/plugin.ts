import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { isLikelyBot, normalizeEmail, type QuizGate } from "../../packages/quiz-gate/src/index.ts";
import { passportLanguage, preferredLanguage } from "../locale.ts";

/**
 * off     the quiz endpoints 404 and sign-up works as before.
 * on      a new account by email code needs a quiz pass for that email. Google and GitHub
 *         sign-up keep working (CoLiving, canteen) and record quizPassedAt only with a pass.
 * strict  a new account by any method, Google and GitHub included, needs a quiz pass.
 */
export type QuizMode = "off" | "on" | "strict";

export function quizMode(value: string | undefined): QuizMode {
  const mode = value?.trim().toLowerCase();
  return mode === "on" || mode === "strict" ? mode : "off";
}

export const QUIZ_PASS_COOKIE = "passport_quiz_pass";
export const QUIZ_PASS_HEADER = "x-quiz-pass";

type HeaderContext = {
  headers?: Headers;
  request?: Request;
  getCookie: (key: string) => string | null | undefined;
};

function header(ctx: { headers?: Headers; request?: Request }, name: string) {
  return ctx.headers?.get(name) ?? ctx.request?.headers.get(name) ?? null;
}

function passToken(ctx: HeaderContext): string | undefined {
  return header(ctx, QUIZ_PASS_HEADER) ?? ctx.getCookie(QUIZ_PASS_COOKIE) ?? undefined;
}

function language(ctx: { headers?: Headers; request?: Request }) {
  return passportLanguage(header(ctx, "x-passport-language")) ?? preferredLanguage(header(ctx, "accept-language"));
}

const quizRequired = () => new APIError("FORBIDDEN", {
  code: "QUIZ_REQUIRED",
  message: "Pass the registration quiz with this email first",
});

/**
 * Runs before a sign-in code is sent. An unknown email gets no code, and no mail is sent,
 * until it holds an unexpired pass. Call this before any cooldown is reserved.
 */
export async function guardSignInCode(
  ctx: HeaderContext & { context: { internalAdapter: { findUserByEmail(email: string): Promise<unknown> } } },
  gate: QuizGate,
  mode: QuizMode,
  email: string,
) {
  if (mode === "off") return;
  if (await ctx.context.internalAdapter.findUserByEmail(email)) return;
  if (await gate.checkPass(passToken(ctx), email)) return;
  throw quizRequired();
}

/** The sign-up route as a short method name stored on the user. */
export function registrationMethod(ctx: { path?: string; params?: Record<string, string | undefined> } | null | undefined): string {
  const path = ctx?.path ?? "";
  if (path.startsWith("/callback/")) return ctx?.params?.id || path.split("/").pop() || "social";
  if (path === "/sign-in/email-otp") return "email-otp";
  if (path.startsWith("/oauth2/callback/")) return ctx?.params?.providerId || "oauth2";
  return path ? path.replace(/^\//, "") : "server";
}

export function quizRegistration(options: { gate: QuizGate; mode: QuizMode; secureCookie: boolean }) {
  const { gate, mode } = options;

  const enabled = () => {
    if (mode === "off") throw new APIError("NOT_FOUND", { code: "NOT_FOUND", message: "Not found" });
  };
  const notBot = (ctx: { headers?: Headers; request?: Request }) => {
    if (isLikelyBot(header(ctx, "user-agent"))) throw new APIError("FORBIDDEN", { code: "BOT", message: "Forbidden" });
  };
  const bodyEmail = (body: unknown) => {
    const email = normalizeEmail((body as Record<string, unknown> | undefined)?.email);
    if (!email) throw new APIError("BAD_REQUEST", { code: "INVALID_EMAIL", message: "Invalid email" });
    return email;
  };

  return {
    id: "quiz-registration",
    schema: {
      user: {
        fields: {
          registrationMethod: { type: "string", required: false, input: false },
          quizPassedAt: { type: "date", required: false, input: false },
        },
      },
    },
    rateLimit: [{ pathMatcher: (path: string) => path.startsWith("/quiz/"), window: 60, max: 10 }],
    init() {
      return {
        options: {
          databaseHooks: {
            user: {
              create: {
                async before(user, context) {
                  const method = registrationMethod(context);
                  const data: Record<string, unknown> = { ...user, registrationMethod: method };
                  if (!context || mode === "off") return { data };
                  const social = method !== "email-otp" && (context.path?.startsWith("/callback/") || context.path?.startsWith("/oauth2/callback/"));
                  const gated = method === "email-otp" || (mode === "strict" && social);
                  const token = passToken(context);
                  // Consume even when not required, so a Google sign-up right after a pass is recorded.
                  const passed = (gated || token) ? await gate.consumePass(token, user.email) : false;
                  if (gated && !passed) throw quizRequired();
                  if (passed) {
                    context.setCookie(QUIZ_PASS_COOKIE, "", { maxAge: 0, path: "/", httpOnly: true, secure: options.secureCookie, sameSite: "lax" });
                    data.registrationMethod = method === "email-otp" ? "quiz" : `quiz+${method}`;
                    data.quizPassedAt = new Date();
                  }
                  return { data: data as typeof user };
                },
              },
            },
          },
        },
      };
    },
    endpoints: {
      quizStart: createAuthEndpoint("/quiz/start", { method: "POST" }, async (ctx) => {
        enabled();
        notBot(ctx);
        const email = bodyEmail(ctx.body);
        const session = await getSessionFromCtx(ctx).catch(() => null);
        const existing = await ctx.context.internalAdapter.findUserByEmail(email);
        // Existing accounts just sign in. A signed-in user may take the quiz for their own email.
        const self = Boolean(session && existing && session.user.id === existing.user.id);
        if (existing && !self) return ctx.json({ status: "existing" });
        const ip = header(ctx, "cf-connecting-ip") ?? header(ctx, "x-forwarded-for")?.split(",")[0].trim() ?? null;
        const result = await gate.start({ email, ip, language: language(ctx) });
        if (!result.ok) {
          if (result.error === "bank_empty") {
            throw new APIError("SERVICE_UNAVAILABLE", { code: "QUIZ_UNAVAILABLE", message: "The quiz is not available" });
          }
          if (result.error === "invalid_email") throw new APIError("BAD_REQUEST", { code: "INVALID_EMAIL", message: "Invalid email" });
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
      quizSubmit: createAuthEndpoint("/quiz/submit", { method: "POST" }, async (ctx) => {
        enabled();
        notBot(ctx);
        const email = bodyEmail(ctx.body);
        const body = ctx.body as Record<string, unknown>;
        const result = await gate.submit({ email, attemptId: body.attemptId, answers: body.answers, language: language(ctx) });
        if (!result.ok) {
          throw new APIError("GONE", { code: "QUIZ_ATTEMPT_INVALID", message: "This quiz expired or was already submitted" });
        }
        let recorded = false;
        if (result.pass) {
          const session = await getSessionFromCtx(ctx).catch(() => null);
          if (session && session.user.email.toLowerCase() === email && await gate.consumePass(result.pass.token, email)) {
            await ctx.context.internalAdapter.updateUser(session.user.id, { quizPassedAt: new Date() });
            recorded = true;
          } else {
            ctx.setCookie(QUIZ_PASS_COOKIE, result.pass.token, {
              maxAge: Math.floor((result.pass.expiresAt - Date.now()) / 1000),
              path: "/",
              httpOnly: true,
              secure: options.secureCookie,
              sameSite: "lax",
            });
          }
        }
        return ctx.json({
          passed: result.passed,
          score: result.score,
          total: result.total,
          passScore: result.passScore,
          review: result.review,
          retryAt: result.retryAt,
          recorded,
          // Also returned for clients without cookies. Send it back as the X-Quiz-Pass header.
          pass: result.pass && !recorded ? result.pass : undefined,
        });
      }),
    },
  } satisfies BetterAuthPlugin;
}
