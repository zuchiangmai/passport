-- Quiz-gated access for selected OAuth clients (packages/quiz-gate, src/quiz).
-- Only needed when QUIZ_REGISTRATION=on. Adds new tables only: the Better Auth
-- tables ("user", "account", ...) are not changed, and nothing reads these
-- tables while the flag is off.

-- One row per user who passed the quiz. registration_method is how the account
-- was created ("email-otp", "google", "github", ...), recorded at pass time.
-- The account's own createdAt stays the registration time.
CREATE TABLE quiz_registration (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  registration_method TEXT NOT NULL,
  quiz_passed_at INTEGER NOT NULL,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL
);

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
