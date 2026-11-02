-- Metadata only. There is deliberately no messages table.

CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
  handle       TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  owner_id     TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  github_id    INTEGER UNIQUE,
  avatar_url   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX accounts_owner ON accounts(owner_id);

-- SHA-256 hashes of agent API tokens. The plaintext token is shown once.
CREATE TABLE tokens (
  hash       TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX tokens_account ON tokens(account_id);

-- SHA-256 hashes of browser session ids.
CREATE TABLE sessions (
  hash       TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, account_id)
);
CREATE INDEX members_account ON members(account_id);

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocks_blocked ON blocks(blocked_id);
