import assert from "node:assert/strict";
import { test } from "node:test";
import { randomInt } from "./crypto.ts";
import { pickQuestions, score, shuffled } from "./select.ts";
import type { QuizQuestion } from "./types.ts";

const question = (id: string, topic: string, answer = 0): QuizQuestion =>
  ({ id, topic, q: `q ${id}`, options: ["a", "b", "c", "d"], answer });

const bank = [
  question("a1", "A"), question("a2", "A"), question("a3", "A"),
  question("b1", "B"), question("b2", "B"), question("c1", "C"),
];

test("randomInt stays in range and covers every value", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const value = randomInt(4);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 4);
    seen.add(value);
  }
  assert.equal(seen.size, 4);
  assert.throws(() => randomInt(0), RangeError);
});

test("shuffled returns a permutation and leaves the input alone", () => {
  const input = [1, 2, 3, 4, 5];
  for (let i = 0; i < 50; i++) {
    const output = shuffled(input);
    assert.deepEqual([...output].sort(), input);
  }
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
});

test("picks distinct questions, one per topic while topics remain", () => {
  for (let i = 0; i < 200; i++) {
    const picked = pickQuestions(bank, 3);
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked.map((q) => q.id)).size, 3);
    assert.deepEqual(new Set(picked.map((q) => q.topic)), new Set(["A", "B", "C"]));
  }
});

test("fills from repeated topics when there are fewer topics than questions", () => {
  for (let i = 0; i < 100; i++) {
    const picked = pickQuestions(bank, 5);
    assert.equal(new Set(picked.map((q) => q.id)).size, 5);
  }
  assert.equal(pickQuestions(bank, 10).length, bank.length);
});

test("selection is uniform enough across the bank", () => {
  const counts = new Map<string, number>();
  const flat = Array.from({ length: 10 }, (_, i) => question(`q${i}`, "same"));
  for (let i = 0; i < 5000; i++) for (const q of pickQuestions(flat, 3)) counts.set(q.id, (counts.get(q.id) ?? 0) + 1);
  for (const count of counts.values()) assert.ok(count > 1200 && count < 1800, `count ${count} near 1500`);
});

test("scores shown indexes through the attempt permutation", () => {
  const asked = [question("x", "X", 2), question("y", "Y", 0), question("z", "Z", 3)];
  // perm[shown] = original index
  const perms = [[2, 0, 1, 3], [1, 2, 3, 0], [0, 1, 2, 3]];
  const result = score(asked, perms, [0, 3, 1]);
  assert.equal(result.score, 2);
  assert.deepEqual(result.results.map((r) => r.ok), [true, true, false]);
  assert.deepEqual(result.results.map((r) => r.correct), [0, 3, 3]);
});

test("malformed answers count as unanswered, never as correct", () => {
  const asked = [question("x", "X", 0), question("y", "Y", 0), question("z", "Z", 0)];
  const perms = [[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]];
  for (const answers of [[], ["0", "0", "0"], [-1, 4, 0.5], [null, undefined, NaN], [{}, [], true]]) {
    const result = score(asked, perms, answers);
    assert.equal(result.score, 0, JSON.stringify(answers));
    assert.ok(result.results.every((r) => r.chosen === -1));
  }
});
