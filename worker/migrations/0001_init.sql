-- Migration 0001 — initial schema (users, sessions, transcript_segments,
-- summaries) + single MVP user seed.
PRAGMA defer_foreign_keys = false; -- D1 enforces FKs; keep ordering explicit

CREATE TABLE users (
  id          TEXT PRIMARY KEY,              -- uuid
  email       TEXT UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL               -- epoch ms
);
-- Seed the single MVP user (fixed id referenced by auth middleware):
INSERT INTO users (id, email, name, created_at)
VALUES ('00000000-0000-4000-8000-000000000001', NULL, 'Owner', 0);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,              -- client-generated uuid (= Recording.id)
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'mic'
              CHECK (source IN ('mic','tab','screen')),  -- 'tab'/'screen' used by section 40
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','transcribing','done','error')),
  created_at  INTEGER NOT NULL,              -- epoch ms (client clock)
  updated_at  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  mime_type   TEXT,
  blob_size   INTEGER,                       -- bytes; audio itself stays client-side (MVP)
  self_speaker TEXT,                         -- diarization label of the app user ("1","2",…) or NULL; set via PATCH, consumed by section 20
  transcript_revision INTEGER NOT NULL DEFAULT 0,  -- server-side monotonic counter; incremented atomically by saveTranscript()
  error       TEXT
);
CREATE INDEX idx_sessions_user_created ON sessions(user_id, created_at DESC);

CREATE TABLE transcript_segments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,              -- 0-based order within session
  speaker     TEXT,                          -- Soniox diarization label ("1","2",…) or NULL
  start_ms    INTEGER,
  end_ms      INTEGER,
  text        TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX idx_segments_session ON transcript_segments(session_id, seq);

CREATE TABLE summaries (
  id          TEXT PRIMARY KEY,              -- uuid
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'meeting_summary',  -- extension point for section 20
  payload_json TEXT NOT NULL,                -- opaque JSON payload
  model       TEXT,                          -- producing model id, set by section 20
  revision    INTEGER NOT NULL DEFAULT 0,    -- server-side monotonic counter; incremented by saveSummary() on each upsert
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, kind)                  -- one latest per kind; replace on regenerate
);
