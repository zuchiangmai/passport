import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BankError, localize, publicQuestion, validateBank } from "./bank.ts";

const valid = { id: "q1", topic: "T", q: "Question?", options: ["yes", "no"], answer: 1 };

test("accepts the committed example bank", () => {
  const raw = JSON.parse(readFileSync(new URL("../../../quiz/bank.example.json", import.meta.url), "utf8"));
  const bank = validateBank(raw);
  assert.ok(bank.length >= 3);
});

test("rejects malformed banks with the id and field, never the answer", () => {
  const cases: [unknown, RegExp][] = [
    [{}, /array/],
    [[{ ...valid, id: "" }], /id is required/],
    [[valid, valid], /q1: duplicate id/],
    [[{ ...valid, topic: " " }], /topic/],
    [[{ ...valid, options: ["only"] }], /options/],
    [[{ ...valid, answer: 2 }], /q1: answer must index/],
    [[{ ...valid, answer: "1" }], /answer/],
    [[{ ...valid, i18n: { en: { options: ["a"] } } }], /i18n.en.options/],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => validateBank(input), (error: unknown) => error instanceof BankError && message.test(error.message));
  }
});

test("localizes field by field and hides the answer from the public view", () => {
  const question = { ...valid, i18n: { en: { q: "English?" } } };
  assert.equal(localize(question, "en").q, "English?");
  assert.deepEqual(localize(question, "en").options, ["yes", "no"]);
  assert.equal(localize(question, "th").q, "Question?");
  const shown = publicQuestion(question, [1, 0], 1, "en");
  assert.deepEqual(shown, { n: 1, id: "q1", topic: "T", q: "English?", options: ["no", "yes"] });
  assert.ok(!("answer" in shown));
});
