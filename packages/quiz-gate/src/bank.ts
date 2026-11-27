import type { PublicQuestion, QuizQuestion } from "./types.ts";

export class BankError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Checks a bank loaded from outside the code (D1, a file, a secret) and returns it typed.
 * Error messages name the question id and field, never the answer.
 */
export function validateBank(input: unknown): QuizQuestion[] {
  if (!Array.isArray(input)) throw new BankError("bank must be an array");
  const ids = new Set<string>();
  return input.map((raw, index) => {
    if (!isRecord(raw)) throw new BankError(`question #${index} is not an object`);
    const where = nonEmpty(raw.id) ? `question ${raw.id}` : `question #${index}`;
    if (!nonEmpty(raw.id)) throw new BankError(`${where}: id is required`);
    if (ids.has(raw.id)) throw new BankError(`${where}: duplicate id`);
    ids.add(raw.id);
    if (!nonEmpty(raw.topic)) throw new BankError(`${where}: topic is required`);
    if (!nonEmpty(raw.q)) throw new BankError(`${where}: q is required`);
    const options = raw.options;
    if (!Array.isArray(options) || options.length < 2 || !options.every(nonEmpty)) {
      throw new BankError(`${where}: options must be at least two non-empty strings`);
    }
    if (!Number.isInteger(raw.answer) || (raw.answer as number) < 0 || (raw.answer as number) >= options.length) {
      throw new BankError(`${where}: answer must index into options`);
    }
    if (raw.i18n !== undefined) {
      if (!isRecord(raw.i18n)) throw new BankError(`${where}: i18n must be an object`);
      for (const [language, translation] of Object.entries(raw.i18n)) {
        if (!isRecord(translation)) throw new BankError(`${where}: i18n.${language} must be an object`);
        const translated = translation.options;
        if (translated !== undefined &&
            (!Array.isArray(translated) || translated.length !== options.length || !translated.every(nonEmpty))) {
          throw new BankError(`${where}: i18n.${language}.options must match options`);
        }
      }
    }
    return raw as QuizQuestion;
  });
}

/** Text for one language, falling back to the bank's default text field by field. */
export function localize(question: QuizQuestion, language?: string) {
  const translation = (language && question.i18n?.[language]) || {};
  return {
    topic: translation.topic ?? question.topic,
    q: translation.q ?? question.q,
    options: translation.options ?? question.options,
    explain: translation.explain ?? question.explain,
    context: translation.context ?? question.context,
  };
}

export function publicQuestion(question: QuizQuestion, perm: number[], n: number, language?: string): PublicQuestion {
  const text = localize(question, language);
  return { n, id: question.id, topic: text.topic, q: text.q, options: perm.map((original) => text.options[original]) };
}
