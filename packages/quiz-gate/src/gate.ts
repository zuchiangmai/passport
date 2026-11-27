import { localize, publicQuestion } from "./bank.ts";
import { constantTimeEqual, hmac, randomId } from "./crypto.ts";
import { pickQuestions, score, shuffled, type RandomInt } from "./select.ts";
import type { QuizPolicy, QuizQuestion, QuizStore, ReviewItem, StartResult, SubmitResult } from "./types.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const DEFAULT_POLICY: QuizPolicy = {
  questions: 3,
  passScore: 2,
  attemptTtlMs: 15 * 60 * 1000,
  passTtlMs: 30 * 60 * 1000,
  nearMissCooldownMs: DAY,
  failCooldownMs: 7 * DAY,
  startsPerEmailPerDay: 3,
  startsPerIpPerDay: 10,
  startsPerDay: 1000,
  shuffleOptions: true,
  revealAnswers: true,
};

export type QuizGateOptions = {
  /** Keys HMACs for email subjects, IP keys and pass tokens. At least 32 characters. */
  secret: string;
  /** The question bank, or a loader called on each start/submit (cache inside it if needed). */
  bank: readonly QuizQuestion[] | (() => Promise<readonly QuizQuestion[]>);
  store: QuizStore;
  policy?: Partial<QuizPolicy>;
  now?: () => number;
  randomInt?: RandomInt;
};

export type QuizGate = ReturnType<typeof createQuizGate>;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TOKEN = /^qp1\.([0-9a-f]{32})\.([0-9]{1,15})\.([A-Za-z0-9_-]{43})$/;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export function createQuizGate(options: QuizGateOptions) {
  if (!options.secret || options.secret.length < 32) throw new Error("quiz gate secret must be at least 32 characters");
  const policy: QuizPolicy = { ...DEFAULT_POLICY, ...options.policy };
  if (policy.passScore < 1 || policy.passScore > policy.questions) throw new Error("passScore must be within 1..questions");
  const now = options.now ?? Date.now;
  const { store, secret } = options;
  const loadBank = typeof options.bank === "function" ? options.bank : async () => options.bank as readonly QuizQuestion[];

  const subjectOf = async (email: string) => (await hmac(secret, `quiz:email:${email}`)).slice(0, 32);
  const ipKeyOf = async (ip: string) => (await hmac(secret, `quiz:ip:${ip}`)).slice(0, 24);
  const signPass = (jti: string, expiresAt: number, subject: string) => hmac(secret, `qp1.${jti}.${expiresAt}.${subject}`);

  /** Parses and checks signature, expiry and email binding. Does not touch the store. */
  async function readPass(token: unknown, email: string): Promise<{ jti: string; subject: string } | null> {
    if (typeof token !== "string") return null;
    const match = TOKEN.exec(token);
    if (!match) return null;
    const [, jti, rawExpiry, signature] = match;
    const expiresAt = Number(rawExpiry);
    if (expiresAt <= now()) return null;
    const subject = await subjectOf(email);
    if (!constantTimeEqual(signature, await signPass(jti, expiresAt, subject))) return null;
    return { jti, subject };
  }

  return {
    policy,

    /** Starts an attempt for `email`. `ip` feeds the per-IP daily limit. */
    async start(input: { email: unknown; ip?: string | null; language?: string }): Promise<StartResult> {
      const email = normalizeEmail(input.email);
      if (!email) return { ok: false, error: "invalid_email" };
      const at = now();
      const subject = await subjectOf(email);
      const cooldown = await store.cooldownUntil(subject, at);
      if (cooldown !== null && cooldown > at) return { ok: false, error: "cooldown", retryAt: cooldown };

      const day = Math.floor(at / DAY);
      const dayEnd = (day + 1) * DAY;
      if (input.ip) {
        const count = await store.hit(`ip:${await ipKeyOf(input.ip)}:${day}`, dayEnd);
        if (count > policy.startsPerIpPerDay) return { ok: false, error: "ip_limit", retryAt: dayEnd };
      }
      if (await store.hit(`email:${subject}:${day}`, dayEnd) > policy.startsPerEmailPerDay) {
        return { ok: false, error: "email_limit", retryAt: dayEnd };
      }
      if (await store.hit(`all:${day}`, dayEnd) > policy.startsPerDay) {
        return { ok: false, error: "daily_limit", retryAt: dayEnd };
      }

      const bank = await loadBank();
      if (bank.length < policy.questions) return { ok: false, error: "bank_empty" };
      const picked = pickQuestions(bank, policy.questions, options.randomInt);
      const items = picked.map((question) => {
        const identity = question.options.map((_, i) => i);
        return { id: question.id, perm: policy.shuffleOptions ? shuffled(identity, options.randomInt) : identity };
      });
      const attempt = { id: randomId(16), subject, items, expiresAt: at + policy.attemptTtlMs };
      await store.saveAttempt(attempt);
      return {
        ok: true,
        attemptId: attempt.id,
        expiresAt: attempt.expiresAt,
        passScore: policy.passScore,
        questions: picked.map((question, k) => publicQuestion(question, items[k].perm, k + 1, input.language)),
      };
    },

    /**
     * Scores an attempt exactly once. The attempt must belong to `email` and be unexpired.
     * A pass issues a single-use token bound to `email`; a fail sets a cooldown.
     */
    async submit(input: { email: unknown; attemptId: unknown; answers: unknown; language?: string }): Promise<SubmitResult> {
      const email = normalizeEmail(input.email);
      if (!email) return { ok: false, error: "invalid_email" };
      if (typeof input.attemptId !== "string" || !/^[0-9a-f]{32}$/.test(input.attemptId)) {
        return { ok: false, error: "attempt_invalid" };
      }
      const at = now();
      const subject = await subjectOf(email);
      // Taken before any check: one submission per attempt id, whatever the outcome.
      const attempt = await store.takeAttempt(input.attemptId);
      if (!attempt || attempt.expiresAt <= at || !constantTimeEqual(attempt.subject, subject)) {
        return { ok: false, error: "attempt_invalid" };
      }
      const bank = await loadBank();
      const byId = new Map(bank.map((question) => [question.id, question]));
      const questions = attempt.items.map((item) => byId.get(item.id));
      if (questions.some((question) => !question)) return { ok: false, error: "attempt_invalid" };
      const asked = questions as QuizQuestion[];
      const perms = attempt.items.map((item) => item.perm);
      const answers = Array.isArray(input.answers) ? input.answers : [];
      const scored = score(asked, perms, answers);
      const passed = scored.score >= policy.passScore;

      const review: ReviewItem[] | undefined = policy.revealAnswers
        ? asked.map((question, k) => {
          const text = localize(question, input.language);
          return {
            ...publicQuestion(question, perms[k], k + 1, input.language),
            ...scored.results[k],
            explain: text.explain,
            context: text.context,
            source: question.source,
            learn: question.learn,
          };
        })
        : undefined;
      const base = { ok: true as const, passed, score: scored.score, total: asked.length, passScore: policy.passScore, review };

      if (passed) {
        const jti = randomId(16);
        const expiresAt = at + policy.passTtlMs;
        await store.savePass({ jti, subject, expiresAt });
        return { ...base, pass: { token: `qp1.${jti}.${expiresAt}.${await signPass(jti, expiresAt, subject)}`, expiresAt } };
      }
      const retryAt = at + (scored.score >= policy.passScore - 1 ? policy.nearMissCooldownMs : policy.failCooldownMs);
      await store.setCooldown(subject, retryAt);
      return { ...base, retryAt };
    },

    /** True when `token` is a valid, unexpired, unconsumed pass for `email`. */
    async checkPass(token: unknown, email: unknown): Promise<boolean> {
      const normalized = normalizeEmail(email);
      if (!normalized) return false;
      const pass = await readPass(token, normalized);
      return pass ? store.passActive(pass.jti, pass.subject, now()) : false;
    },

    /** Uses up the pass. Only one concurrent caller gets true. */
    async consumePass(token: unknown, email: unknown): Promise<boolean> {
      const normalized = normalizeEmail(email);
      if (!normalized) return false;
      const pass = await readPass(token, normalized);
      return pass ? store.consumePass(pass.jti, pass.subject, now()) : false;
    },
  };
}
