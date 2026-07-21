-- Migration 0003 — integrations framework (section 40 Track B):
-- provider connections, encrypted token storage, single-use OAuth states,
-- and the calendar auto-create dedup ledger (decisions.md #4).

CREATE TABLE integration_connections (
  id            TEXT PRIMARY KEY,                -- uuid
  user_id       TEXT NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL,                   -- 'google-calendar'|'gmail'|'slack'|'notion'
  external_account_id TEXT NOT NULL,             -- google sub / slack team_id / notion workspace_id
  display_name  TEXT NOT NULL,                   -- email / workspace name shown in UI
  scopes        TEXT NOT NULL,                   -- space-separated granted scopes ('' for notion)
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','error','revoked')),
  metadata      TEXT,                            -- JSON: slack bot_user_id, notion workspace_icon, ...
  created_at    INTEGER NOT NULL,                -- epoch ms
  updated_at    INTEGER NOT NULL,
  UNIQUE (user_id, provider)                     -- MVP: one connection per provider per user
);
CREATE INDEX idx_integration_connections_user ON integration_connections(user_id);

-- Token rows live in a separate table so listing connections never selects
-- ciphertext columns. Values are AES-256-GCM: base64(iv || ciphertext || tag).
CREATE TABLE integration_tokens (
  connection_id     TEXT PRIMARY KEY
                    REFERENCES integration_connections(id) ON DELETE CASCADE,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT,                        -- NULL for notion + slack; set for google
  token_type        TEXT NOT NULL DEFAULT 'Bearer',
  expires_at        INTEGER,                     -- epoch ms; NULL = non-expiring
  updated_at        INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state_id    TEXT PRIMARY KEY,                  -- random 32-byte hex (HMAC travels in the param, not stored)
  user_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  redirect_to TEXT,                              -- app path to return the browser to after callback
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,                  -- created_at + 10 min
  used_at     INTEGER                            -- single-use marker
);
CREATE INDEX idx_oauth_states_expires ON oauth_states(expires_at); -- opportunistic cleanup on connect

-- Calendar auto-create dedup ledger (decisions.md #4). Deliberately NO foreign
-- key to sessions(id): if the user deletes an auto-created session, the ledger
-- row must survive so the cron does not recreate the session on the next run.
CREATE TABLE calendar_event_sessions (
  user_id    TEXT NOT NULL,
  event_id   TEXT NOT NULL,                      -- Google event id (singleEvents=true → unique per instance)
  session_id TEXT NOT NULL,                      -- sessions.id created for this event (may since be deleted)
  created_at INTEGER NOT NULL,                   -- epoch ms
  PRIMARY KEY (user_id, event_id)
);
