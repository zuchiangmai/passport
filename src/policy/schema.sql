CREATE TABLE IF NOT EXISTS app_link (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, app),
  UNIQUE(app, external_id)
);
