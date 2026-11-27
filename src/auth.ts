import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP, jwt } from "better-auth/plugins";
import { checkResend, type OtpRow } from "./email/otp-policy.ts";
import { sendResendEmail } from "./email/resend.ts";
import { OTP_TTL_MINUTES, signInCodeEmail } from "./email/sign-in-code.ts";
import { passportLanguage, preferredLanguage } from "./locale.ts";
import { createQuizGate, type QuizGate } from "../packages/quiz-gate/src/index.ts";
import { loadBank } from "./quiz/bank.ts";
import { D1QuizStore } from "./quiz/d1-store.ts";
import { quizClients, quizMode, quizPostLogin, quizRegistration } from "./quiz/plugin.ts";

export const AUTH_PATH = "/api/auth";
export const SEND_OTP = "/email-otp/send-verification-otp";
export const SIGN_IN_OTP = "/sign-in/email-otp";

// Better Auth ignores basePath when baseURL already contains a path. The public
// issuer is https://4seas.xyz/passport, so the auth router must be told that
// its mount is /passport/api/auth and its baseURL is only the origin.
export function authRouteBase(issuer: string): { baseURL: string; basePath: string } {
  const url = new URL(issuer);
  const mount = url.pathname.replace(/\/+$/, "");
  return {
    baseURL: url.origin,
    basePath: `${mount === "/" ? "" : mount}${AUTH_PATH}`,
  };
}

// Returns the pathname the Better Auth router must see, or null when this
// request is one of our own routes. Accepts both /passport/api/auth/* and
// /api/auth/* so a proxy that already stripped the mount still matches.
export function authHandlerPath(pathname: string, issuer: string): string | null {
  const stripped = pathname === "/passport" || pathname.startsWith("/passport/")
    ? pathname.slice("/passport".length) || "/"
    : pathname;
  if (stripped !== AUTH_PATH && !stripped.startsWith(`${AUTH_PATH}/`)) return null;
  return `${authRouteBase(issuer).basePath}${stripped.slice(AUTH_PATH.length)}`;
}

export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  EMAIL_BACKEND: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  MAIL_FROM: string;
  RESEND_API_KEY?: string;
  COLIVING_CLIENT_SECRET?: string;
  CANTEEN_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  LINK_SERVICE_KEY?: string;
  /** Master switch, off by default. See src/quiz/plugin.ts. */
  QUIZ_REGISTRATION?: string;
  /** OAuth client IDs that require a passed quiz, comma separated. */
  QUIZ_CLIENTS?: string;
  QUIZ_QUESTIONS?: string;
  QUIZ_PASS_SCORE?: string;
  /** Where the bank's relative "learn" links point, e.g. https://topic-research.pages.dev/ */
  QUIZ_LEARN_BASE_URL?: string;
  /** Local development only: a loopback URL that captures mail instead of Resend. */
  RESEND_API_URL?: string;
}

function positiveInt(value: string | undefined): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export function createGate(env: Env): QuizGate {
  const questions = positiveInt(env.QUIZ_QUESTIONS);
  const passScore = positiveInt(env.QUIZ_PASS_SCORE);
  return createQuizGate({
    // A separate key per purpose, derived from the one Better Auth secret.
    secret: `quiz-gate:v1:${env.BETTER_AUTH_SECRET}`,
    bank: () => loadBank(env.DB),
    store: new D1QuizStore(env.DB),
    policy: { ...(questions ? { questions } : {}), ...(passScore ? { passScore } : {}) },
  });
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

function provider(id?: string, secret?: string) {
  const clientId = id?.trim();
  const clientSecret = secret?.trim();
  return clientId && clientSecret ? {
    clientId,
    clientSecret,
    requireEmailVerification: true,
    getAccountFields(_tokens: unknown, userInfo: { emailVerified: boolean }) {
      if (!userInfo.emailVerified) throw new APIError("FORBIDDEN", { code: "email_not_verified" });
      return undefined;
    },
  } : undefined;
}

export function socialProviders(env: Env) {
  return {
    google: provider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    github: provider(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
  };
}

async function reserveOtpSend(db: D1Database, email: string) {
  const now = Date.now();
  const prior = await db.prepare("SELECT sent_at FROM otp_send WHERE email = ?")
    .bind(email).first<number>("sent_at");
  const row: OtpRow | null = prior === null
    ? null
    : { email, sentAt: prior, codeHash: null, expiresAt: 0, wrongAttempts: 0 };

  if (checkResend({ now, row }).ok) {
    // A concurrent sender can claim the same email only once.
    const result = await db.prepare(`
      INSERT INTO otp_send (email, sent_at) VALUES (?1, ?2)
      ON CONFLICT(email) DO UPDATE SET sent_at = excluded.sent_at WHERE sent_at = ?3
    `).bind(email, now, prior).run();
    if (result.meta.changes === 1) return;
  }
  throw new APIError("TOO_MANY_REQUESTS", { code: "COOLDOWN", message: "Wait before requesting another code" });
}

export function createAuth(env: Env, ctx: ExecutionContext) {
  if (!env.BETTER_AUTH_SECRET?.trim()) throw new Error("BETTER_AUTH_SECRET is required");
  const url = new URL(env.BETTER_AUTH_URL);
  const routes = authRouteBase(env.BETTER_AUTH_URL);
  const issuer = env.BETTER_AUTH_URL.replace(/\/+$/, "");
  // With the switch off nothing quiz-related is configured, so behavior and schema match main.
  const quiz = quizMode(env.QUIZ_REGISTRATION) === "on";
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: routes.baseURL,
    basePath: routes.basePath,
    logger: { disabled: true },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      backgroundTasks: { handler: (task) => ctx.waitUntil(task) },
    },
    emailAndPassword: { enabled: false },
    socialProviders: socialProviders(env),
    rateLimit: { enabled: true, storage: "database" },
    hooks: {
      before: createAuthMiddleware(async (request) => {
        if (request.path !== SEND_OTP) return;
        const email = normalizeEmail(request.body?.email);
        if (!email) throw new APIError("BAD_REQUEST", { code: "INVALID_EMAIL", message: "Invalid email" });
        if (request.body?.type !== "sign-in") {
          throw new APIError("BAD_REQUEST", { code: "UNSUPPORTED_OTP_TYPE", message: "Use a sign-in code" });
        }
        await reserveOtpSend(env.DB, email);
        return { context: { body: { ...request.body, email } } };
      }),
    },
    plugins: [
      jwt({ disableSettingJwtHeader: true, jwt: { issuer, audience: issuer } }),
      oauthProvider({
        loginPage: `${issuer}/sign-in`,
        consentPage: `${issuer}/consent`,
        allowDynamicClientRegistration: false,
        clientPrivileges: () => false,
        ...(quiz ? {
          postLogin: quizPostLogin({ db: env.DB, clients: quizClients(env.QUIZ_CLIENTS), page: `${issuer}/quiz` }),
        } : {}),
      }),
      ...(quiz ? [quizRegistration({ gate: createGate(env), db: env.DB })] : []),
      emailOTP({
        otpLength: 6,
        expiresIn: OTP_TTL_MINUTES * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        disableSignUp: false,
        async sendVerificationOTP({ email, otp, type }, request) {
          if (type !== "sign-in" || env.EMAIL_BACKEND !== "resend" || !env.RESEND_API_KEY) return;
          const apiKey = env.RESEND_API_KEY;
          const from = env.MAIL_FROM;
          const headers = request?.headers;
          const language = passportLanguage(headers?.get("x-passport-language")) ??
            preferredLanguage(headers?.get("accept-language"));
          ctx.waitUntil((async () => {
            const result = await sendResendEmail({
              apiKey,
              from,
              to: email,
              ...signInCodeEmail(language, otp),
              tag: "passport_otp",
              endpoint: env.RESEND_API_URL,
            });
            if (!result.ok) console.error("passport mail failed", result.error);
          })());
        },
      }),
      passkey({ rpID: url.hostname, origin: url.origin, rpName: "4Seas Passport" }),
    ],
    disabledPaths: [
      "/token",
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
      "/email-otp/reset-password",
    ],
  });
}
