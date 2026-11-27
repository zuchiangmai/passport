/** Text a question may carry per language. Missing fields fall back to the default text. */
export type QuestionTranslation = {
  topic?: string;
  q?: string;
  options?: string[];
  explain?: string;
  context?: string;
};

/** One single-choice question. `answer` is the index into `options` and never leaves the server unscored. */
export type QuizQuestion = {
  id: string;
  topic: string;
  q: string;
  options: string[];
  answer: number;
  explain?: string;
  context?: string;
  source?: { url: string; date?: string };
  learn?: { t: string; u: string }[];
  i18n?: Record<string, QuestionTranslation>;
};

export type QuizPolicy = {
  /** Questions per attempt. */
  questions: number;
  /** Correct answers needed to pass. */
  passScore: number;
  /** An attempt must be submitted within this window. */
  attemptTtlMs: number;
  /** A pass token is valid for this long, and only once. */
  passTtlMs: number;
  /** Cooldown after scoring exactly passScore - 1. */
  nearMissCooldownMs: number;
  /** Cooldown after any lower score. */
  failCooldownMs: number;
  /** Quiz starts allowed per email per UTC day. */
  startsPerEmailPerDay: number;
  /** Quiz starts allowed per client IP per UTC day. */
  startsPerIpPerDay: number;
  /** Quiz starts allowed across all callers per UTC day. */
  startsPerDay: number;
  /** Show options in a random order per attempt. */
  shuffleOptions: boolean;
  /** Return the correct answers and explanations for the attempt just scored. */
  revealAnswers: boolean;
};

/** What the server keeps for an attempt. `perm[shown] = original option index`. */
export type StoredAttempt = {
  id: string;
  subject: string;
  items: { id: string; perm: number[] }[];
  expiresAt: number;
};

export type StoredPass = { jti: string; subject: string; expiresAt: number };

/**
 * Persistence the gate needs. Every method must be atomic on its own:
 * `hit` increments and returns the new count, `takeAttempt` deletes and returns
 * (so an attempt is scored once), and `consumePass` succeeds for one caller only.
 * `subject` is an HMAC of the email, never the address itself.
 */
export interface QuizStore {
  hit(key: string, expiresAt: number): Promise<number>;
  cooldownUntil(subject: string, now: number): Promise<number | null>;
  setCooldown(subject: string, until: number): Promise<void>;
  saveAttempt(attempt: StoredAttempt): Promise<void>;
  takeAttempt(id: string): Promise<StoredAttempt | null>;
  savePass(pass: StoredPass): Promise<void>;
  passActive(jti: string, subject: string, now: number): Promise<boolean>;
  consumePass(jti: string, subject: string, now: number): Promise<boolean>;
}

/** A question as shown to the person taking the quiz: no answer. */
export type PublicQuestion = {
  n: number;
  id: string;
  topic: string;
  q: string;
  options: string[];
};

export type ReviewItem = PublicQuestion & {
  /** Shown index the person picked, or -1. */
  chosen: number;
  /** Shown index of the correct option. */
  correct: number;
  ok: boolean;
  explain?: string;
  context?: string;
  source?: { url: string; date?: string };
  learn?: { t: string; u: string }[];
};

export type StartError = "invalid_email" | "cooldown" | "ip_limit" | "email_limit" | "daily_limit" | "bank_empty";

export type StartResult =
  | { ok: true; attemptId: string; expiresAt: number; passScore: number; questions: PublicQuestion[] }
  | { ok: false; error: StartError; retryAt?: number };

export type SubmitResult =
  | {
      ok: true;
      passed: boolean;
      score: number;
      total: number;
      passScore: number;
      review?: ReviewItem[];
      pass?: { token: string; expiresAt: number };
      retryAt?: number;
    }
  | { ok: false; error: "invalid_email" | "attempt_invalid" };
