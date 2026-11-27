import type { QuizStore, StoredAttempt, StoredPass } from "./types.ts";

/** In-process store for tests and single-process servers. Not shared across isolates. */
export class MemoryQuizStore implements QuizStore {
  readonly counters = new Map<string, { count: number; expiresAt: number }>();
  readonly cooldowns = new Map<string, number>();
  readonly attempts = new Map<string, StoredAttempt>();
  readonly passes = new Map<string, StoredPass & { consumedAt: number | null }>();
  private readonly clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  async hit(key: string, expiresAt: number) {
    const current = this.counters.get(key);
    const count = current && current.expiresAt > this.clock() ? current.count + 1 : 1;
    this.counters.set(key, { count, expiresAt });
    return count;
  }

  async cooldownUntil(subject: string, now: number) {
    const until = this.cooldowns.get(subject);
    return until !== undefined && until > now ? until : null;
  }

  async setCooldown(subject: string, until: number) {
    this.cooldowns.set(subject, until);
  }

  async saveAttempt(attempt: StoredAttempt) {
    this.attempts.set(attempt.id, structuredClone(attempt));
  }

  async takeAttempt(id: string) {
    const attempt = this.attempts.get(id) ?? null;
    this.attempts.delete(id);
    return attempt;
  }

  async savePass(pass: StoredPass) {
    this.passes.set(pass.jti, { ...pass, consumedAt: null });
  }

  async passActive(jti: string, subject: string, now: number) {
    const pass = this.passes.get(jti);
    return Boolean(pass && pass.subject === subject && pass.consumedAt === null && pass.expiresAt > now);
  }

  async consumePass(jti: string, subject: string, now: number) {
    if (!(await this.passActive(jti, subject, now))) return false;
    this.passes.get(jti)!.consumedAt = now;
    return true;
  }
}
