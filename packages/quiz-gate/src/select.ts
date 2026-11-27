import { randomInt as cryptoRandomInt } from "./crypto.ts";
import type { QuizQuestion } from "./types.ts";

export type RandomInt = (n: number) => number;

export function shuffled<T>(items: readonly T[], randomInt: RandomInt = cryptoRandomInt): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Picks `count` distinct questions at random, one per topic first so a single
 * gap in knowledge does not sink the attempt, then fills from the rest.
 */
export function pickQuestions(bank: readonly QuizQuestion[], count: number, randomInt: RandomInt = cryptoRandomInt): QuizQuestion[] {
  const order = shuffled(bank, randomInt);
  const picked: QuizQuestion[] = [];
  const topics = new Set<string>();
  for (const question of order) {
    if (picked.length >= count) break;
    if (topics.has(question.topic)) continue;
    picked.push(question);
    topics.add(question.topic);
  }
  for (const question of order) {
    if (picked.length >= count) break;
    if (!picked.includes(question)) picked.push(question);
  }
  return picked;
}

export type Scored = { score: number; results: { chosen: number; correct: number; ok: boolean }[] };

/**
 * Scores answers given as shown option indexes against the attempt's permutations.
 * Anything that is not an in-range integer counts as unanswered.
 */
export function score(questions: readonly QuizQuestion[], perms: readonly number[][], answers: readonly unknown[]): Scored {
  let total = 0;
  const results = questions.map((question, k) => {
    const perm = perms[k];
    const raw = answers[k];
    const chosen = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < perm.length ? raw : -1;
    const correct = perm.indexOf(question.answer);
    const ok = chosen !== -1 && perm[chosen] === question.answer;
    if (ok) total += 1;
    return { chosen, correct, ok };
  });
  return { score: total, results };
}
