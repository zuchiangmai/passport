-- Keep app_link aligned with src/policy/schema.sql.
CREATE TABLE IF NOT EXISTS app_link (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, app),
  UNIQUE(app, external_id)
);

CREATE TABLE auth_code (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX auth_code_user_id_idx ON auth_code(user_id);

CREATE TABLE otp_send (
  email TEXT PRIMARY KEY NOT NULL,
  sent_at INTEGER NOT NULL
);
