import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { checkResend, generateOtpCode, issueOtp, verifyOtp } from "./otp-policy.ts";

const email = "member@example.test";
const code = generateOtpCode();
const wrongCode = code.replace(/^[0-9]/, (digit) => String((Number(digit) + 1) % 10));

async function issueRow() {
  const issued = await issueOtp({ email: "  MEMBER@EXAMPLE.TEST  ", code, now: 0 });
  assert.ok(issued.ok, "issuance succeeds");
  return issued.row;
}

test("resend is blocked until 60 seconds after issuance", async () => {
  const row = await issueRow();
  assert.deepEqual(checkResend({ row, now: 59_999 }), { ok: false, error: "cooldown" });
  assert.deepEqual(await issueOtp({ email, code, row, now: 59_999 }), { ok: false, error: "cooldown" });
  assert.deepEqual(checkResend({ row, now: 60_000 }), { ok: true });
  const reissued = await issueOtp({ email, code, row, now: 60_000 });
  assert.ok(reissued.ok, "issuance succeeds after cooldown");
});

test("a code expires at 15 minutes", async () => {
  const row = await issueRow();
  const beforeExpiry = await verifyOtp({ email, code, row, now: 899_999 });
  assert.ok(beforeExpiry.ok, "the code is valid before expiry");
  assert.deepEqual(await verifyOtp({ email, code, row, now: 900_000 }), { ok: false, error: "code_expired" });
});

test("a wrong code fails and records one attempt", async () => {
  const row = await issueRow();
  const result = await verifyOtp({ email, code: wrongCode, row, now: 1 });
  assert.ok(!result.ok && result.error === "invalid_code");
  assert.equal(result.row?.wrongAttempts, 1);
  assert.equal(row.wrongAttempts, 0);
});

test("the fifth wrong attempt locks the code even if the next attempt is correct", async () => {
  let row = await issueRow();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await verifyOtp({ email, code: wrongCode, row, now: attempt });
    assert.ok(!result.ok && "row" in result && result.row);
    assert.equal(result.error, attempt === 5 ? "too_many_attempts" : "invalid_code");
    assert.equal(result.row.wrongAttempts, attempt);
    row = result.row;
  }
  assert.ok(row.codeHash === null, "the locked code hash is cleared");
  assert.deepEqual(await verifyOtp({ email, code, row, now: 6 }), { ok: false, error: "too_many_attempts" });
});

test("the correct code consumes the stored hash", async () => {
  const row = await issueRow();
  const expectedHash = createHash("sha256").update(`${code}:${email}`).digest("hex");
  assert.ok(row.codeHash === expectedHash, "only the email-bound code hash is stored");
  assert.ok(!("code" in row), "the row has no raw code field");
  const result = await verifyOtp({ email, code, row, now: 1 });
  assert.ok(result.ok, "the code matches the normalized email");
  assert.ok(result.row.codeHash === null, "the consumed code hash is cleared");
  assert.deepEqual(await verifyOtp({ email, code, row: result.row, now: 2 }), { ok: false, error: "invalid_code" });
});

test("missing fields and invalid emails are rejected", async () => {
  const row = await issueRow();
  assert.deepEqual(await issueOtp({ code, now: 0 }), { ok: false, error: "missing_fields" });
  assert.deepEqual(await issueOtp({ email: "invalid", code, now: 0 }), { ok: false, error: "invalid_email" });
  assert.deepEqual(await verifyOtp({ email, row, now: 1 }), { ok: false, error: "missing_fields" });
  assert.deepEqual(await verifyOtp({ email: "invalid", code, row, now: 1 }), { ok: false, error: "invalid_email" });
});
