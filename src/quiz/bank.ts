import { validateBank, type QuizQuestion } from "../../packages/quiz-gate/src/index.ts";

const CACHE_MS = 60_000;
let cache: { db: D1Database; at: number; bank: QuizQuestion[] } | null = null;

/** Active questions from D1, cached per isolate for a minute. */
export async function loadBank(db: D1Database, now = Date.now()): Promise<QuizQuestion[]> {
  if (cache && cache.db === db && now - cache.at < CACHE_MS) return cache.bank;
  const { results } = await db.prepare("SELECT body FROM quiz_question WHERE active = 1 ORDER BY id")
    .all<{ body: string }>();
  const bank = validateBank(results.map((row) => JSON.parse(row.body)));
  cache = { db, at: now, bank };
  return bank;
}

export function clearBankCache() {
  cache = null;
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * SQL that makes the table match `bank`: upserts every question and deactivates the rest.
 * Used by scripts/seed-quiz-bank.mjs and by tests. The bank is validated first.
 */
export function bankSeedSql(input: unknown, now = Date.now()): string {
  const bank = validateBank(input);
  const lines = ["UPDATE quiz_question SET active = 0;"];
  for (const question of bank) {
    lines.push(
      `INSERT INTO quiz_question (id, topic, body, active, updated_at) VALUES (${quote(question.id)}, ${quote(question.topic)}, ${quote(JSON.stringify(question))}, 1, ${now}) ` +
      "ON CONFLICT(id) DO UPDATE SET topic = excluded.topic, body = excluded.body, active = 1, updated_at = excluded.updated_at;",
    );
  }
  return `${lines.join("\n")}\n`;
}
