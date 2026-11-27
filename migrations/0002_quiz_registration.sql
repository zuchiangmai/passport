-- Quiz-gated registration (packages/quiz-gate, src/quiz). Safe to apply with the flag off.

-- How the account was created ("quiz", "email-otp", "google", "github", "link:coliving", ...)
-- and when its owner last passed the quiz. createdAt is the registration time.
ALTER TABLE "user" ADD COLUMN "registrationMethod" TEXT;
ALTER TABLE "user" ADD COLUMN "quizPassedAt" DATE;

-- The bank lives here, seeded by scripts/seed-quiz-bank.mjs from a file outside git.
-- body is the full question JSON, answer included. It never leaves the Worker unscored.
CREATE TABLE quiz_question (
  id TEXT PRIMARY KEY NOT NULL,
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- subject is an HMAC of the email. No addresses are stored in these tables.
CREATE TABLE quiz_attempt (
  id TEXT PRIMARY KEY NOT NULL,
  subject TEXT NOT NULL,
  items TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX quiz_attempt_expires_idx ON quiz_attempt(expires_at);

CREATE TABLE quiz_pass (
  jti TEXT PRIMARY KEY NOT NULL,
  subject TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX quiz_pass_expires_idx ON quiz_pass(expires_at);

CREATE TABLE quiz_cooldown (
  subject TEXT PRIMARY KEY NOT NULL,
  until INTEGER NOT NULL
);

CREATE TABLE quiz_counter (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX quiz_counter_expires_idx ON quiz_counter(expires_at);
