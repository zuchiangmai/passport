import assert from "node:assert/strict";
import { test } from "node:test";
import { isLikelyBot } from "./bots.ts";
import { createQuizGate, DEFAULT_POLICY } from "./gate.ts";
import { MemoryQuizStore } from "./memory-store.ts";
import type { QuizQuestion, StartResult } from "./types.ts";

const SECRET = "test-secret-test-secret-test-secret!";
const bank: QuizQuestion[] = ["A", "B", "C", "D"].map((topic, i) => ({
  id: `q${i}`, topic, q: `Question ${i}?`, options: ["w", "x", "y", "z"], answer: i % 4,
  explain: `because ${i}`, i18n: { en: { q: `EN ${i}?` } },
}));

function setup(policy = {}) {
  let clock = Date.UTC(2026, 10, 27, 5, 0, 0);
  const store = new MemoryQuizStore(() => clock);
  const gate = createQuizGate({ secret: SECRET, bank, store, policy, now: () => clock });
  return { gate, store, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

type Started = Extract<StartResult, { ok: true }>;

function answersFor(started: Started, store: MemoryQuizStore, correct: number) {
  // Tests read the server-side attempt to know the right shown index.
  const attempt = store.attempts.get(started.attemptId)!;
  return attempt.items.map((item, k) => {
    const right = item.perm.indexOf(bank.find((q) => q.id === item.id)!.answer);
    return k < correct ? right : (right + 1) % item.perm.length;
  });
}

async function started(gate: ReturnType<typeof setup>["gate"], email = "new@example.test", ip = "203.0.113.1") {
  const result = await gate.start({ email, ip });
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

test("start shows three questions without answers and keeps the attempt server side", async () => {
  const { gate, store } = setup();
  const result = await started(gate);
  assert.equal(result.questions.length, 3);
  assert.equal(result.passScore, 2);
  assert.equal(new Set(result.questions.map((q) => q.topic)).size, 3);
  assert.ok(!JSON.stringify(result).includes("\"answer\""));
  assert.ok(!JSON.stringify(result).includes("because"));
  assert.ok(store.attempts.has(result.attemptId));
});

test("questions follow the requested language with fallback", async () => {
  const { gate } = setup();
  const result = await gate.start({ email: "lang@example.test", language: "en" });
  assert.ok(result.ok);
  assert.ok(result.questions.every((q) => q.q.startsWith("EN ")));
});

test("two of three correct passes and returns a pass token bound to the email", async () => {
  const { gate, store } = setup();
  const attempt = await started(gate);
  const result = await gate.submit({ email: "NEW@example.test ", attemptId: attempt.attemptId, answers: answersFor(attempt, store, 2) });
  assert.ok(result.ok && result.passed);
  assert.equal(result.score, 2);
  assert.ok(result.pass);
  assert.equal(result.review?.filter((r) => r.ok).length, 2);
  assert.equal(await gate.checkPass(result.pass.token, "new@example.test"), true);
  assert.equal(await gate.checkPass(result.pass.token, "other@example.test"), false, "bound to the email");
});

test("a pass token is single use and cannot be replayed", async () => {
  const { gate, store } = setup();
  const attempt = await started(gate);
  const result = await gate.submit({ email: "new@example.test", attemptId: attempt.attemptId, answers: answersFor(attempt, store, 3) });
  assert.ok(result.ok && result.pass);
  const [first, second] = await Promise.all([
    gate.consumePass(result.pass.token, "new@example.test"),
    gate.consumePass(result.pass.token, "new@example.test"),
  ]);
  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(await gate.checkPass(result.pass.token, "new@example.test"), false);
});

test("a pass token expires and tampering breaks the signature", async () => {
  const { gate, store, advance } = setup();
  const attempt = await started(gate);
  const result = await gate.submit({ email: "new@example.test", attemptId: attempt.attemptId, answers: answersFor(attempt, store, 3) });
  assert.ok(result.ok && result.pass);
  const token = result.pass.token;
  const [prefix, jti, expiry, signature] = token.split(".");
  assert.equal(await gate.checkPass(`${prefix}.${jti}.${Number(expiry) + 60_000}.${signature}`, "new@example.test"), false);
  assert.equal(await gate.checkPass(`${prefix}.${jti}.${expiry}.${signature.slice(0, -1)}A`, "new@example.test"), false);
  assert.equal(await gate.checkPass("garbage", "new@example.test"), false);
  assert.equal(await gate.checkPass(undefined, "new@example.test"), false);
  advance(DEFAULT_POLICY.passTtlMs - 1);
  assert.equal(await gate.checkPass(token, "new@example.test"), true);
  advance(1);
  assert.equal(await gate.checkPass(token, "new@example.test"), false);
  assert.equal(await gate.consumePass(token, "new@example.test"), false);
});

test("a token signed with another secret is rejected", async () => {
  const { gate, store } = setup();
  const other = createQuizGate({ secret: "another-secret-another-secret-0000", bank, store });
  const attempt = await other.start({ email: "new@example.test" });
  assert.ok(attempt.ok);
  const result = await other.submit({ email: "new@example.test", attemptId: attempt.attemptId, answers: answersFor(attempt, store, 3) });
  assert.ok(result.ok && result.pass);
  assert.equal(await gate.checkPass(result.pass.token, "new@example.test"), false);
});

test("an attempt is scored once, whatever the outcome", async () => {
  const { gate, store } = setup();
  const attempt = await started(gate);
  const answers = answersFor(attempt, store, 3);
  const first = await gate.submit({ email: "new@example.test", attemptId: attempt.attemptId, answers });
  assert.ok(first.ok && first.passed);
  assert.deepEqual(
    await gate.submit({ email: "new@example.test", attemptId: attempt.attemptId, answers }),
    { ok: false, error: "attempt_invalid" },
  );
});

test("an attempt is bound to the email that started it", async () => {
  const { gate, store } = setup();
  const attempt = await started(gate);
  const answers = answersFor(attempt, store, 3);
  assert.deepEqual(
    await gate.submit({ email: "thief@example.test", attemptId: attempt.attemptId, answers }),
    { ok: false, error: "attempt_invalid" },
  );
  // The failed theft consumed the attempt too, so it cannot be retried with guesses.
  assert.deepEqual(
    await gate.submit({ email: "new@example.test", attemptId: attempt.attemptId, answers }),
    { ok: false, error: "attempt_invalid" },
  );
});

test("an attempt expires after 15 minutes", async () => {
  const { gate, store, advance } = setup();
  const attempt = await started(gate);
  const answers = answersFor(attempt, store, 3);
  advance(DEFAULT_POLICY.attemptTtlMs);
  assert.deepEqual(
    await gate.submit({ email: "new@example.test", attemptId: attempt.attemptId, answers }),
    { ok: false, error: "attempt_invalid" },
  );
});

test("one correct sets a 24 hour cooldown, zero sets 7 days", async () => {
  for (const [correct, wait] of [[1, DEFAULT_POLICY.nearMissCooldownMs], [0, DEFAULT_POLICY.failCooldownMs]] as const) {
    const { gate, store, advance, now } = setup();
    const attempt = await started(gate);
    const result = await gate.submit({ email: "new@example.test", attemptId: attempt.attemptId, answers: answersFor(attempt, store, correct) });
    assert.ok(result.ok && !result.passed && !result.pass);
    assert.equal(result.retryAt, now() + wait);
    const blocked = await gate.start({ email: "new@example.test" });
    assert.deepEqual(blocked, { ok: false, error: "cooldown", retryAt: now() + wait });
    advance(wait);
    assert.ok((await gate.start({ email: "new@example.test" })).ok, "allowed after cooldown");
  }
});

test("limits starts per email, per IP and overall per UTC day", async () => {
  const { gate, advance } = setup({ startsPerDay: 4 });
  for (let i = 0; i < 3; i++) await started(gate, "a@example.test", `198.51.100.${i}`);
  const email = await gate.start({ email: "a@example.test", ip: "198.51.100.9" });
  assert.ok(!email.ok && email.error === "email_limit" && email.retryAt);

  const ipGate = setup();
  for (let i = 0; i < 10; i++) await started(ipGate.gate, `p${i}@example.test`, "192.0.2.7");
  const ip = await ipGate.gate.start({ email: "p10@example.test", ip: "192.0.2.7" });
  assert.ok(!ip.ok && ip.error === "ip_limit");
  assert.ok((await ipGate.gate.start({ email: "p10@example.test", ip: "192.0.2.8" })).ok, "other IPs unaffected");

  await started(gate, "b@example.test", "198.51.100.20");
  const all = await gate.start({ email: "c@example.test", ip: "198.51.100.21" });
  assert.ok(!all.ok && all.error === "daily_limit");
  advance(24 * 60 * 60 * 1000);
  assert.ok((await gate.start({ email: "a@example.test", ip: "198.51.100.9" })).ok, "limits reset the next day");
});

test("invalid input is rejected before touching limits", async () => {
  const { gate, store } = setup();
  assert.deepEqual(await gate.start({ email: "not-an-email" }), { ok: false, error: "invalid_email" });
  assert.equal(store.counters.size, 0);
  assert.deepEqual(await gate.submit({ email: "x@example.test", attemptId: "../../etc", answers: [] }), { ok: false, error: "attempt_invalid" });
  assert.deepEqual(await gate.submit({ email: 5, attemptId: "a".repeat(32), answers: [] }), { ok: false, error: "invalid_email" });
});

test("a bank smaller than one attempt reports bank_empty", async () => {
  const gate = createQuizGate({ secret: SECRET, bank: bank.slice(0, 2), store: new MemoryQuizStore() });
  assert.deepEqual(await gate.start({ email: "x@example.test" }), { ok: false, error: "bank_empty" });
  const loader = createQuizGate({ secret: SECRET, bank: async () => [], store: new MemoryQuizStore() });
  assert.deepEqual(await loader.start({ email: "x@example.test" }), { ok: false, error: "bank_empty" });
});

test("configuration guards", () => {
  assert.throws(() => createQuizGate({ secret: "short", bank, store: new MemoryQuizStore() }));
  assert.throws(() => createQuizGate({ secret: SECRET, bank, store: new MemoryQuizStore(), policy: { passScore: 4 } }));
});

test("answers stay hidden when revealAnswers is off", async () => {
  const { gate, store } = setup({ revealAnswers: false });
  const attempt = await started(gate);
  const result = await gate.submit({ email: "new@example.test", attemptId: attempt.attemptId, answers: answersFor(attempt, store, 0) });
  assert.ok(result.ok && result.review === undefined);
});

test("known crawlers are flagged, browsers are not", () => {
  assert.equal(isLikelyBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), true);
  assert.equal(isLikelyBot("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)"), true);
  assert.equal(isLikelyBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15"), false);
});
