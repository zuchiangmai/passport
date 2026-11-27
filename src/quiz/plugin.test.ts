import assert from "node:assert/strict";
import { test } from "node:test";
import { resendEndpoint } from "../email/resend.ts";
import { SqliteD1 } from "../testing/sqlite-d1.ts";
import { bankSeedSql, clearBankCache, loadBank } from "./bank.ts";
import { D1QuizStore } from "./d1-store.ts";
import { quizClients, quizMode } from "./plugin.ts";
import type { QuizQuestion } from "../../packages/quiz-gate/src/index.ts";

const bank: QuizQuestion[] = ["A", "B", "C"].map((topic, i) => ({ id: `q${i}`, topic, q: `${topic}?`, options: ["r", "w"], answer: 0 }));

test("the master switch is off unless exactly on", () => {
  assert.equal(quizMode(undefined), "off");
  assert.equal(quizMode(""), "off");
  assert.equal(quizMode("true"), "off");
  assert.equal(quizMode("strict"), "off");
  assert.equal(quizMode(" ON "), "on");
});

test("QUIZ_CLIENTS parses a comma separated allowlist", () => {
  assert.deepEqual([...quizClients(undefined)], []);
  assert.deepEqual([...quizClients(" topic-research, other ,,")], ["topic-research", "other"]);
});

test("the mail endpoint override only accepts loopback capture servers", () => {
  assert.equal(resendEndpoint(undefined), "https://api.resend.com/emails");
  assert.equal(resendEndpoint("http://127.0.0.1:8799/emails"), "http://127.0.0.1:8799/emails");
  assert.equal(resendEndpoint("http://localhost:8799/"), "http://localhost:8799/");
  assert.equal(resendEndpoint("https://evil.example/emails"), "https://api.resend.com/emails");
  assert.equal(resendEndpoint("not a url"), "https://api.resend.com/emails");
});

test("migration 0002 only adds new tables and leaves Better Auth tables untouched", () => {
  const columns = (d1: SqliteD1, table: string) =>
    (d1.sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
  const main = SqliteD1.migrated({ before: "0002" });
  const full = SqliteD1.migrated();
  for (const table of ["user", "session", "account", "verification", "oauthClient", "app_link", "auth_code", "otp_send"]) {
    assert.deepEqual(columns(full, table), columns(main, table), table);
  }
  const added = (full.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
    .map((r) => r.name).filter((name) => !columns(main, name).length);
  assert.deepEqual(added.sort(), ["quiz_attempt", "quiz_cooldown", "quiz_counter", "quiz_pass", "quiz_preapproved", "quiz_question", "quiz_registration"]);
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
