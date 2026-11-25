import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP, jwt } from "better-auth/plugins";
import { checkResend, type OtpRow } from "./email/otp-policy.ts";
import { sendResendEmail } from "./email/resend.ts";

export const AUTH_PATH = "/api/auth";
export const SEND_OTP = "/email-otp/send-verification-otp";
export const SIGN_IN_OTP = "/sign-in/email-otp";

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
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

function provider(id?: string, secret?: string) {
  const clientId = id?.trim();
  const clientSecret = secret?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
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
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: AUTH_PATH,
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
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        allowDynamicClientRegistration: false,
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 900,
        allowedAttempts: 5,
        storeOTP: "hashed",
        disableSignUp: false,
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in" || env.EMAIL_BACKEND !== "resend" || !env.RESEND_API_KEY) return;
          const apiKey = env.RESEND_API_KEY;
          const from = env.MAIL_FROM;
          ctx.waitUntil((async () => {
            const result = await sendResendEmail({
              apiKey,
              from,
              to: email,
              subject: "4Seas Passport 登录验证码",
              text: `你的登录验证码是 ${otp}，15 分钟内有效。`,
              tag: "passport_otp",
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
