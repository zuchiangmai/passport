const TTL_MS = 15 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_WRONG_ATTEMPTS = 5;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CODE_PATTERN = /^[0-9]{6}$/;

export type OtpRow = Readonly<{
  email: string;
  codeHash: string | null;
  sentAt: number;
  expiresAt: number;
  wrongAttempts: number;
}>;

type ResendInput = { now: number; row?: OtpRow | null };
type ResendResult = { ok: true } | { ok: false; error: "cooldown" };
type IssueResult =
  | { ok: true; row: OtpRow }
  | { ok: false; error: "missing_fields" | "invalid_email" | "invalid_code" | "cooldown" };
type VerifyResult =
  | { ok: true; row: OtpRow }
  | { ok: false; error: "missing_fields" | "invalid_email" | "code_expired" }
  | { ok: false; error: "invalid_code" | "too_many_attempts"; row?: OtpRow };

async function hashCode(code: string, email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${code}:${email}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generateOtpCode(): string {
  const range = 900_000;
  const limit = Math.floor(2 ** 32 / range) * range;
  const sample = new Uint32Array(1);
  let value: number;
  do {
    [value] = crypto.getRandomValues(sample);
  } while (value >= limit);
  return String(100_000 + (value % range));
}

export function checkResend({ now, row }: ResendInput): ResendResult {
  if (row && now - row.sentAt < COOLDOWN_MS) {
    return { ok: false, error: "cooldown" };
  }
  return { ok: true };
}

export async function issueOtp({
  email: rawEmail,
  code: rawCode,
  now,
  row,
}: ResendInput & { email?: string | null; code?: string | null }): Promise<IssueResult> {
  const email = rawEmail?.trim().toLowerCase();
  const code = rawCode?.trim();
  if (!email || !code) return { ok: false, error: "missing_fields" };
  if (!EMAIL_PATTERN.test(email)) return { ok: false, error: "invalid_email" };
  if (!CODE_PATTERN.test(code)) return { ok: false, error: "invalid_code" };

  const resend = checkResend({ now, row: row?.email === email ? row : null });
  if (!resend.ok) return resend;

  return {
    ok: true,
    row: {
      email,
      codeHash: await hashCode(code, email),
      sentAt: now,
      expiresAt: now + TTL_MS,
      wrongAttempts: 0,
    },
  };
}

export async function verifyOtp({
  email: rawEmail,
  code: rawCode,
  now,
  row,
}: ResendInput & { email?: string | null; code?: string | null }): Promise<VerifyResult> {
  const email = rawEmail?.trim().toLowerCase();
  const code = rawCode?.trim();
  if (!email || !code) return { ok: false, error: "missing_fields" };
  if (!EMAIL_PATTERN.test(email)) return { ok: false, error: "invalid_email" };
  if (!row || row.email !== email) return { ok: false, error: "invalid_code" };
  if (row.wrongAttempts >= MAX_WRONG_ATTEMPTS) return { ok: false, error: "too_many_attempts" };
  if (!row.codeHash) return { ok: false, error: "invalid_code" };
  if (now >= row.expiresAt) return { ok: false, error: "code_expired" };

  if (CODE_PATTERN.test(code) && (await hashCode(code, email)) === row.codeHash) {
    return { ok: true, row: { ...row, codeHash: null } };
  }

  const wrongAttempts = row.wrongAttempts + 1;
  if (wrongAttempts === MAX_WRONG_ATTEMPTS) {
    return {
      ok: false,
      error: "too_many_attempts",
      row: { ...row, wrongAttempts, codeHash: null },
    };
  }
  return { ok: false, error: "invalid_code", row: { ...row, wrongAttempts } };
}
