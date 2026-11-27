// End-to-end flows through the real Worker fetch handler, Better Auth and the quiz plugin,
// on an in-memory SQLite D1 with every migration applied. Resend is replaced by a capture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import worker from "../index.ts";
import type { Env } from "../auth.ts";
import { SqliteD1 } from "../testing/sqlite-d1.ts";
import { bankSeedSql, clearBankCache } from "./bank.ts";

const SITE = "http://127.0.0.1:8788";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const bank = JSON.parse(readFileSync(new URL("../../quiz/bank.example.json", import.meta.url), "utf8")) as { id: string; answer: number }[];

type Mail = { to: string; subject: string; text: string };
let mails: Mail[] = [];
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== "https://api.resend.com/emails") throw new Error(`unexpected network call to ${url}`);
    const body = JSON.parse(String(init?.body));
    mails.push({ to: body.to[0], subject: body.subject, text: body.text });
    return Response.json({ id: `test-${mails.length}` });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

let ipCounter = 0;

function setup(mode: "off" | "on" | "strict" = "on") {
  mails = [];
  clearBankCache();
  const d1 = SqliteD1.migrated();
  d1.sqlite.exec(bankSeedSql(bank));
  const pending: Promise<unknown>[] = [];
  const env: Env = {
    DB: d1.asD1(),
    ENVIRONMENT: "test",
    EMAIL_BACKEND: "resend",
    RESEND_API_KEY: "re_test_not_a_real_key",
    BETTER_AUTH_URL: SITE,
    BETTER_AUTH_SECRET: "integration-test-secret-0123456789abcdef",
    MAIL_FROM: "Passport Test <no-reply@example.test>",
    QUIZ_REGISTRATION: mode,
  };
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

  class Browser {
    readonly jar = new Map<string, string>();
    readonly ip = `198.51.100.${++ipCounter % 250}`;
    readonly userAgent: string;
    constructor(userAgent = UA) {
      this.userAgent = userAgent;
    }
    async request(path: string, body?: unknown, headers: Record<string, string> = {}) {
      const init: RequestInit = {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          Origin: SITE,
          "User-Agent": this.userAgent,
          "CF-Connecting-IP": this.ip,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.jar.size ? { Cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      };
      const response = await worker.fetch(new Request(SITE + path, init) as never, env, ctx);
      await Promise.all(pending.splice(0));
      for (const cookie of response.headers.getSetCookie()) {
        const [pair, ...attributes] = cookie.split(";");
        const index = pair.indexOf("=");
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (!value || attributes.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.jar.delete(name);
        else this.jar.set(name, value);
      }
      const text = await response.text();
      let json: Record<string, any> = {};
      try { json = JSON.parse(text); } catch {}
      return { status: response.status, json, text, headers: response.headers };
    }
  }

  const user = (email: string) => d1.sqlite.prepare(
    'SELECT id, email, emailVerified, registrationMethod, quizPassedAt FROM "user" WHERE email = ?',
  ).get(email) as Record<string, any> | undefined;

  /** Shown option indexes that answer `correct` of the attempt's questions right. */
  function answersFor(attemptId: string, correct: number) {
    const row = d1.sqlite.prepare("SELECT items FROM quiz_attempt WHERE id = ?").get(attemptId) as { items: string };
    return (JSON.parse(row.items) as { id: string; perm: number[] }[]).map((item, k) => {
      const right = item.perm.indexOf(bank.find((q) => q.id === item.id)!.answer);
      return k < correct ? right : (right + 1) % item.perm.length;
    });
  }

  function codeFor(email: string) {
    const mail = mails.filter((m) => m.to === email).at(-1);
    assert.ok(mail, `a code was mailed to ${email}`);
    return /\b(\d{6})\b/.exec(mail.text)![1];
  }

  async function passQuiz(browser: Browser, email: string, correct = 3) {
    const started = await browser.request("/api/auth/quiz/start", { email });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.status, "quiz");
    return browser.request("/api/auth/quiz/submit", {
      email, attemptId: started.json.attemptId, answers: answersFor(started.json.attemptId, correct),
    });
  }

  return { d1, env, Browser, user, answersFor, codeFor, passQuiz };
}

test("flag on: an unknown email gets no code and no mail until it passes the quiz", async () => {
  const { Browser } = setup();
  const browser = new Browser();
  const response = await browser.request("/api/auth/email-otp/send-verification-otp", { email: "new@example.test", type: "sign-in" });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, "QUIZ_REQUIRED");
  assert.equal(mails.length, 0);
});

test("flag on: new email, quiz passed, email code, account created with method and time, signed in", async () => {
  const { Browser, user, codeFor, passQuiz, d1 } = setup();
  const browser = new Browser();
  const email = "fresh@example.test";

  const started = await browser.request("/api/auth/quiz/start", { email });
  assert.equal(started.json.questions.length, 3);
  assert.ok(!started.text.includes('"answer"'), "answers never reach the client before scoring");

  const submitted = await passQuiz(browser, email, 2);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.passed, true);
  assert.equal(submitted.json.score, 2);
  assert.equal(submitted.json.review.length, 3);
  assert.ok(browser.jar.has("passport_quiz_pass"), "the pass rides in an httpOnly cookie");
  assert.match(submitted.headers.getSetCookie().join("\n"), /passport_quiz_pass=[^;]+;.*HttpOnly/i);
  assert.equal(user(email), undefined, "no account before the email is proven");

  const sent = await browser.request("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, email);

  const before = Date.now();
  const signedIn = await browser.request("/api/auth/sign-in/email-otp", { email, otp: codeFor(email) });
  assert.equal(signedIn.status, 200, signedIn.text);
  const row = user(email)!;
  assert.equal(row.emailVerified, 1);
  assert.equal(row.registrationMethod, "quiz");
  assert.ok(new Date(row.quizPassedAt).getTime() >= before - 1000);
  assert.ok(!browser.jar.has("passport_quiz_pass"), "the pass cookie is cleared after use");
  const consumed = d1.sqlite.prepare("SELECT COUNT(*) AS n FROM quiz_pass WHERE consumed_at IS NOT NULL").get() as { n: number };
  assert.equal(consumed.n, 1);

  const session = await browser.request("/api/auth/get-session");
  assert.equal(session.json.user.email, email);
  assert.equal(session.json.user.registrationMethod, "quiz");
});

test("flag on: failing sets a cooldown, keeps codes blocked, and shows the review", async () => {
  const { Browser, passQuiz } = setup();
  const browser = new Browser();
  const email = "fail@example.test";
  const failed = await passQuiz(browser, email, 1);
  assert.equal(failed.json.passed, false);
  assert.ok(failed.json.retryAt - Date.now() > 23 * 3600_000, "one correct waits a day");
  assert.equal(failed.json.pass, undefined);
  assert.equal(failed.json.review.filter((r: { ok: boolean }) => r.ok).length, 1);
  assert.ok(!browser.jar.has("passport_quiz_pass"));
  const sent = await browser.request("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  assert.equal(sent.status, 403);
  const again = await browser.request("/api/auth/quiz/start", { email });
  assert.equal(again.status, 429);
  assert.equal(again.json.code, "QUIZ_COOLDOWN");
  assert.equal(again.json.retryAt, failed.json.retryAt);
});

test("flag on: zero correct waits seven days", async () => {
  const { Browser, passQuiz } = setup();
  const failed = await passQuiz(new Browser(), "zero@example.test", 0);
  assert.equal(failed.json.passed, false);
  assert.ok(failed.json.retryAt - Date.now() > 6.9 * 86_400_000);
});

test("flag on: a pass is bound to its email and cannot be replayed", async () => {
  const { Browser, passQuiz, codeFor, d1 } = setup();
  const browser = new Browser();
  const passed = await passQuiz(browser, "owner@example.test");
  const token = passed.json.pass.token as string;

  const other = new Browser();
  const stolen = await other.request("/api/auth/email-otp/send-verification-otp", { email: "thief@example.test", type: "sign-in" }, { "X-Quiz-Pass": token });
  assert.equal(stolen.status, 403, "a pass for one email does not unlock another");

  await browser.request("/api/auth/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" });
  const signedIn = await browser.request("/api/auth/sign-in/email-otp", { email: "owner@example.test", otp: codeFor("owner@example.test") });
  assert.equal(signedIn.status, 200);

  // Even with the account gone, the used token opens nothing.
  d1.sqlite.exec(`DELETE FROM "user" WHERE email = 'owner@example.test'`);
  const replay = await other.request("/api/auth/email-otp/send-verification-otp", { email: "owner@example.test", type: "sign-in" }, { "X-Quiz-Pass": token });
  assert.equal(replay.status, 403);
});

test("flag on: a code requested without a pass cannot create an account", async () => {
  const { Browser, passQuiz, codeFor, user } = setup();
  const browser = new Browser();
  const email = "sneaky@example.test";
  await passQuiz(browser, email);
  await browser.request("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  // A second client with the code but no pass cookie.
  const other = new Browser();
  const attempt = await other.request("/api/auth/sign-in/email-otp", { email, otp: codeFor(email) });
  assert.equal(attempt.status, 403);
  assert.equal(attempt.json.code, "QUIZ_REQUIRED");
  assert.equal(user(email), undefined);
});

test("flag on: an attempt belongs to the email that started it and is scored once", async () => {
  const { Browser, answersFor } = setup();
  const browser = new Browser();
  const started = await browser.request("/api/auth/quiz/start", { email: "a@example.test" });
  const answers = answersFor(started.json.attemptId, 3);
  const wrongEmail = await browser.request("/api/auth/quiz/submit", { email: "b@example.test", attemptId: started.json.attemptId, answers });
  assert.equal(wrongEmail.status, 410);
  assert.equal(wrongEmail.json.code, "QUIZ_ATTEMPT_INVALID");
  const retried = await browser.request("/api/auth/quiz/submit", { email: "a@example.test", attemptId: started.json.attemptId, answers });
  assert.equal(retried.status, 410);
});

test("flag on: existing users sign in normally and skip the quiz", async () => {
  const { Browser, d1, codeFor, user } = setup();
  d1.sqlite.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u-old', 'Old', 'old@example.test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  const browser = new Browser();
  const start = await browser.request("/api/auth/quiz/start", { email: "old@example.test" });
  assert.deepEqual(start.json, { status: "existing" });
  const sent = await browser.request("/api/auth/email-otp/send-verification-otp", { email: "old@example.test", type: "sign-in" });
  assert.equal(sent.status, 200);
  const signedIn = await browser.request("/api/auth/sign-in/email-otp", { email: "old@example.test", otp: codeFor("old@example.test") });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.json.user.id, "u-old");
  assert.equal(user("old@example.test")!.registrationMethod, null, "existing rows are not rewritten");
});

test("flag on: a signed-in user can pass the quiz to record it on their account", async () => {
  const { Browser, d1, codeFor, passQuiz, user } = setup();
  d1.sqlite.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, registrationMethod) VALUES ('u-gh', 'G', 'gh@example.test', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'github')`).run();
  const browser = new Browser();
  await browser.request("/api/auth/email-otp/send-verification-otp", { email: "gh@example.test", type: "sign-in" });
  await browser.request("/api/auth/sign-in/email-otp", { email: "gh@example.test", otp: codeFor("gh@example.test") });
  const result = await passQuiz(browser, "gh@example.test");
  assert.equal(result.json.recorded, true);
  assert.equal(result.json.pass, undefined);
  assert.ok(user("gh@example.test")!.quizPassedAt);
  assert.equal(user("gh@example.test")!.registrationMethod, "github");
});

test("flag on: starts are limited per email per day", async () => {
  const { Browser } = setup();
  const browsers = [new Browser(), new Browser(), new Browser(), new Browser()];
  for (const browser of browsers.slice(0, 3)) {
    assert.equal((await browser.request("/api/auth/quiz/start", { email: "busy@example.test" })).status, 200);
  }
  const fourth = await browsers[3].request("/api/auth/quiz/start", { email: "busy@example.test" });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.json.code, "QUIZ_LIMIT");
});

test("flag on: starts are limited per IP per day", async () => {
  const { Browser, d1 } = setup();
  const browser = new Browser();
  const results = [];
  for (let i = 0; i < 11; i++) {
    // Clear Better Auth's own 10 per minute window so only the daily quiz limit applies.
    d1.sqlite.exec("DELETE FROM rateLimit");
    results.push(await browser.request("/api/auth/quiz/start", { email: `ip${i}@example.test` }));
  }
  assert.deepEqual(results.slice(0, 10).map((r) => r.status), Array(10).fill(200));
  assert.equal(results[10].status, 429);
  assert.equal(results[10].json.code, "QUIZ_LIMIT");
  const elsewhere = await new Browser().request("/api/auth/quiz/start", { email: "ip10@example.test" });
  assert.equal(elsewhere.status, 200, "another IP is unaffected");
});

test("flag on: Better Auth also throttles bursts on the quiz endpoints", async () => {
  const { Browser } = setup();
  const browser = new Browser();
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await browser.request("/api/auth/quiz/start", { email: "x@" })).status);
  assert.ok(statuses.includes(429), statuses.join(","));
});

test("flag on: crawlers cannot start a quiz", async () => {
  const { Browser } = setup();
  const bot = new Browser("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
  const response = await bot.request("/api/auth/quiz/start", { email: "bot@example.test" });
  assert.equal(response.status, 403);
});

test("flag on: legacy passcode API asks for the quiz and accepts quiz_pass", async () => {
  const { Browser, passQuiz, codeFor, user } = setup();
  const browser = new Browser();
  const email = "legacy@example.test";
  const blocked = await browser.request("/v1/auth/passcode/request", { email });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, "quiz_required");
  const passed = await passQuiz(new Browser(), email);
  const token = passed.json.pass.token;
  const requested = await browser.request("/v1/auth/passcode/request", { email, quiz_pass: token });
  assert.equal(requested.status, 202);
  const verified = await browser.request("/v1/auth/passcode/verify", { email, code: codeFor(email), quiz_pass: token });
  assert.equal(verified.status, 200, verified.text);
  assert.equal(verified.json.email, email);
  assert.equal(user(email)!.registrationMethod, "quiz");
});

test("flag on: an empty bank reports the quiz as unavailable", async () => {
  const { Browser, d1 } = setup();
  d1.sqlite.exec("UPDATE quiz_question SET active = 0");
  clearBankCache();
  const response = await new Browser().request("/api/auth/quiz/start", { email: "x@example.test" });
  assert.equal(response.status, 503);
  assert.equal(response.json.code, "QUIZ_UNAVAILABLE");
});

test("flag off: sign-up by email code works as before and the quiz endpoints 404", async () => {
  const { Browser, codeFor, user } = setup("off");
  const browser = new Browser();
  const email = "open@example.test";
  assert.equal((await browser.request("/api/auth/quiz/start", { email })).status, 404);
  assert.equal((await browser.request("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" })).status, 200);
  assert.equal((await browser.request("/api/auth/sign-in/email-otp", { email, otp: codeFor(email) })).status, 200);
  assert.equal(user(email)!.registrationMethod, "email-otp");
  assert.equal(user(email)!.quizPassedAt, null);
});

test("sign-in pages show the quiz only when the flag is on", async () => {
  for (const [mode, expected] of [["on", true], ["strict", true], ["off", false]] as const) {
    const { Browser } = setup(mode);
    for (const language of ["en", "zh", "th"]) {
      const page = await new Browser().request(`/passport/${language}/login`);
      assert.equal(page.status, 200);
      assert.equal(page.text.includes('id="quiz"'), expected, `${mode} ${language}`);
      assert.match(page.text, /data-provider="google"/);
      assert.match(page.text, /data-provider="github"/);
    }
  }
});

test("linked CoLiving and canteen users are recorded with their link method", async () => {
  const { Browser, env, user } = setup();
  env.LINK_SERVICE_KEY = "link-key-for-tests";
  const response = await new Browser().request("/v1/identity/links", { email: "resident@example.test", app: "coliving", external_id: "r-1" }, { "X-Service-Key": "link-key-for-tests" });
  assert.equal(response.status, 200, response.text);
  assert.equal(user("resident@example.test")!.registrationMethod, "link:coliving");
});
