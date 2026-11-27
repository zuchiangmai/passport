import assert from "node:assert/strict";
import { test } from "node:test";
import { createQuizGate, MemoryQuizStore, type QuizQuestion } from "../../packages/quiz-gate/src/index.ts";
import { registrationClaims } from "../auth.ts";
import { resendEndpoint } from "../email/resend.ts";
import { SqliteD1 } from "../testing/sqlite-d1.ts";
import { bankSeedSql, clearBankCache, loadBank } from "./bank.ts";
import { D1QuizStore } from "./d1-store.ts";
import { QUIZ_PASS_COOKIE, quizMode, quizRegistration, registrationMethod, type QuizMode } from "./plugin.ts";

const bank: QuizQuestion[] = ["A", "B", "C"].map((topic, i) => ({ id: `q${i}`, topic, q: `${topic}?`, options: ["r", "w"], answer: 0 }));
const SECRET = "plugin-test-secret-plugin-test-secret";

async function passFor(gate: ReturnType<typeof createQuizGate>, store: MemoryQuizStore, email: string) {
  const started = await gate.start({ email });
  assert.ok(started.ok);
  const attempt = store.attempts.get(started.attemptId)!;
  const answers = attempt.items.map((item) => item.perm.indexOf(0));
  const result = await gate.submit({ email, attemptId: started.attemptId, answers });
  assert.ok(result.ok && result.pass);
  return result.pass.token;
}

function createHook(mode: QuizMode) {
  const store = new MemoryQuizStore();
  const gate = createQuizGate({ secret: SECRET, bank, store });
  const plugin = quizRegistration({ gate, mode, secureCookie: true });
  const before = plugin.init().options.databaseHooks.user.create.before;
  const call = (path: string, params: Record<string, string>, token?: string) => {
    const cookies: string[] = [];
    const context = {
      path, params,
      headers: new Headers(),
      getCookie: (name: string) => (name === QUIZ_PASS_COOKIE ? token ?? null : null),
      setCookie: (name: string) => { cookies.push(name); return name; },
    };
    const user = { id: "u", email: "social@example.test", emailVerified: true, name: "", createdAt: new Date(), updatedAt: new Date() };
    return { result: before(user, context as never), cookies };
  };
  return { gate, store, call };
}

test("quizMode defaults to off", () => {
  assert.equal(quizMode(undefined), "off");
  assert.equal(quizMode("yes"), "off");
  assert.equal(quizMode(" ON "), "on");
  assert.equal(quizMode("strict"), "strict");
});

test("registration method comes from the sign-up route", () => {
  assert.equal(registrationMethod({ path: "/callback/:id", params: { id: "google" } }), "google");
  assert.equal(registrationMethod({ path: "/callback/github" }), "github");
  assert.equal(registrationMethod({ path: "/sign-in/email-otp" }), "email-otp");
  assert.equal(registrationMethod(null), "server");
});

test("on: Google and GitHub sign-up keep working without a pass", async () => {
  const { call } = createHook("on");
  const { result } = call("/callback/:id", { id: "google" });
  const { data } = (await result) as { data: Record<string, unknown> };
  assert.equal(data.registrationMethod, "google");
  assert.equal(data.quizPassedAt, undefined);
});

test("on: a social sign-up carrying a pass for the same email records it", async () => {
  const { gate, store, call } = createHook("on");
  const token = await passFor(gate, store, "social@example.test");
  const { result, cookies } = call("/callback/:id", { id: "github" }, token);
  const { data } = (await result) as { data: Record<string, unknown> };
  assert.equal(data.registrationMethod, "quiz+github");
  assert.ok(data.quizPassedAt instanceof Date);
  assert.deepEqual(cookies, [QUIZ_PASS_COOKIE], "the used pass cookie is cleared");
  assert.equal(await gate.checkPass(token, "social@example.test"), false, "and consumed");
});

test("strict: social sign-up without a pass is refused", async () => {
  const { call } = createHook("strict");
  await assert.rejects(call("/callback/:id", { id: "google" }).result, (error: { body?: { code?: string } }) => error.body?.code === "QUIZ_REQUIRED");
});

test("strict: social sign-up with a pass for another email is refused", async () => {
  const { gate, store, call } = createHook("strict");
  const token = await passFor(gate, store, "someone-else@example.test");
  await assert.rejects(call("/callback/:id", { id: "google" }, token).result);
});

test("strict: social sign-up with a matching pass succeeds", async () => {
  const { gate, store, call } = createHook("strict");
  const token = await passFor(gate, store, "social@example.test");
  const { data } = (await call("/callback/:id", { id: "google" }, token).result) as { data: Record<string, unknown> };
  assert.equal(data.registrationMethod, "quiz+google");
});

test("off: nothing is gated and the method is still recorded", async () => {
  const { call } = createHook("off");
  const { data } = (await call("/sign-in/email-otp", {}).result) as { data: Record<string, unknown> };
  assert.equal(data.registrationMethod, "email-otp");
});

test("OIDC claims expose the method and the quiz time in seconds", () => {
  assert.deepEqual(registrationClaims({ registrationMethod: "quiz", quizPassedAt: new Date("2026-11-27T05:00:00Z") }), {
    registration_method: "quiz", quiz_passed_at: 1795755600,
  });
  assert.deepEqual(registrationClaims({ registrationMethod: "google", quizPassedAt: null }), {
    registration_method: "google", quiz_passed_at: null,
  });
  assert.deepEqual(registrationClaims({}), { registration_method: null, quiz_passed_at: null });
});

test("the mail endpoint override only accepts loopback capture servers", () => {
  assert.equal(resendEndpoint(undefined), "https://api.resend.com/emails");
  assert.equal(resendEndpoint("http://127.0.0.1:8799/emails"), "http://127.0.0.1:8799/emails");
  assert.equal(resendEndpoint("http://localhost:8799/"), "http://localhost:8799/");
  assert.equal(resendEndpoint("https://evil.example/emails"), "https://api.resend.com/emails");
  assert.equal(resendEndpoint("not a url"), "https://api.resend.com/emails");
});

test("seeding upserts, deactivates removed questions and escapes quotes", async () => {
  const d1 = SqliteD1.migrated();
  const tricky = { ...bank[0], q: "It's a 'quoted' question; DROP TABLE user; --" };
  d1.sqlite.exec(bankSeedSql([tricky, bank[1], bank[2]]));
  clearBankCache();
  assert.equal((await loadBank(d1.asD1())).find((q) => q.id === "q0")!.q, tricky.q);
  d1.sqlite.exec(bankSeedSql([bank[1], bank[2], { ...bank[0], id: "q9" }]));
  clearBankCache();
  assert.deepEqual((await loadBank(d1.asD1())).map((q) => q.id), ["q1", "q2", "q9"]);
  assert.throws(() => bankSeedSql([{ id: "bad" }]), /bad/);
});

test("the D1 store scores an attempt once and consumes a pass once", async () => {
  const d1 = SqliteD1.migrated();
  const store = new D1QuizStore(d1.asD1());
  const now = Date.now();
  await store.saveAttempt({ id: "a".repeat(32), subject: "s", items: [{ id: "q0", perm: [1, 0] }], expiresAt: now + 1000 });
  assert.deepEqual(await store.takeAttempt("a".repeat(32)), { id: "a".repeat(32), subject: "s", items: [{ id: "q0", perm: [1, 0] }], expiresAt: now + 1000 });
  assert.equal(await store.takeAttempt("a".repeat(32)), null);

  await store.savePass({ jti: "j", subject: "s", expiresAt: now + 1000 });
  assert.equal(await store.passActive("j", "other", now), false);
  assert.equal(await store.passActive("j", "s", now + 1000), false, "expired");
  assert.equal(await store.passActive("j", "s", now), true);
  assert.equal(await store.consumePass("j", "s", now), true);
  assert.equal(await store.consumePass("j", "s", now), false);

  assert.equal(await store.hit("k", now + 1000), 1);
  assert.equal(await store.hit("k", now + 1000), 2);
  await store.setCooldown("s", now + 5000);
  await store.setCooldown("s", now + 10);
  assert.equal(await store.cooldownUntil("s", now), now + 5000, "a shorter cooldown never shortens a longer one");
});
