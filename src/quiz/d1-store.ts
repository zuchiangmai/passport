import type { QuizStore, StoredAttempt, StoredPass } from "../../packages/quiz-gate/src/index.ts";

/** QuizStore on D1. Each method is one statement, so each is atomic. */
export class D1QuizStore implements QuizStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async hit(key: string, expiresAt: number) {
    const now = Date.now();
    const count = await this.db.prepare(`
      INSERT INTO quiz_counter (key, count, expires_at) VALUES (?1, 1, ?2)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN quiz_counter.expires_at > ?3 THEN quiz_counter.count + 1 ELSE 1 END,
        expires_at = excluded.expires_at
      RETURNING count
    `).bind(key, expiresAt, now).first<number>("count");
    return count ?? 1;
  }

  async cooldownUntil(subject: string, now: number) {
    return this.db.prepare("SELECT until FROM quiz_cooldown WHERE subject = ?1 AND until > ?2")
      .bind(subject, now).first<number>("until");
  }

  async setCooldown(subject: string, until: number) {
    await this.db.prepare(`
      INSERT INTO quiz_cooldown (subject, until) VALUES (?1, ?2)
      ON CONFLICT(subject) DO UPDATE SET until = MAX(quiz_cooldown.until, excluded.until)
    `).bind(subject, until).run();
  }

  async saveAttempt(attempt: StoredAttempt) {
    const now = Date.now();
    await this.db.batch([
      // Opportunistic cleanup keeps the tables small without a cron.
      this.db.prepare("DELETE FROM quiz_attempt WHERE expires_at <= ?1").bind(now),
      this.db.prepare("DELETE FROM quiz_pass WHERE expires_at <= ?1").bind(now - 86_400_000),
      this.db.prepare("DELETE FROM quiz_counter WHERE expires_at <= ?1").bind(now),
      this.db.prepare("DELETE FROM quiz_cooldown WHERE until <= ?1").bind(now),
      this.db.prepare("INSERT INTO quiz_attempt (id, subject, items, expires_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(attempt.id, attempt.subject, JSON.stringify(attempt.items), attempt.expiresAt),
    ]);
  }

  async takeAttempt(id: string) {
    const row = await this.db.prepare("DELETE FROM quiz_attempt WHERE id = ?1 RETURNING subject, items, expires_at")
      .bind(id).first<{ subject: string; items: string; expires_at: number }>();
    if (!row) return null;
    return { id, subject: row.subject, items: JSON.parse(row.items), expiresAt: row.expires_at };
  }

  async savePass(pass: StoredPass) {
    await this.db.prepare("INSERT INTO quiz_pass (jti, subject, expires_at) VALUES (?1, ?2, ?3)")
      .bind(pass.jti, pass.subject, pass.expiresAt).run();
  }

  async passActive(jti: string, subject: string, now: number) {
    const row = await this.db.prepare(`
      SELECT 1 AS ok FROM quiz_pass WHERE jti = ?1 AND subject = ?2 AND consumed_at IS NULL AND expires_at > ?3
    `).bind(jti, subject, now).first<number>("ok");
    return row === 1;
  }

  async consumePass(jti: string, subject: string, now: number) {
    const row = await this.db.prepare(`
      UPDATE quiz_pass SET consumed_at = ?3
      WHERE jti = ?1 AND subject = ?2 AND consumed_at IS NULL AND expires_at > ?3
      RETURNING jti
    `).bind(jti, subject, now).first<string>("jti");
    return row === jti;
  }
}
