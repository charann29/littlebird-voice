-- Migration 0002 — memory & semantic search (section 30).
--
-- Tables: memory_documents (external docs ingested via POST /api/memory/documents),
-- memory_chunks (one row per vector; canonical chunk text + registry of which
-- vector IDs belong to which session/document), memory_chunks_fts (FTS5
-- keyword index) + sync triggers, memory_vectors_dev (LOCAL-DEV-ONLY vector
-- store used when DEV_LOCAL_VECTOR=1 — Vectorize has no local simulator).
--
-- CAVEAT: `wrangler d1 export` fails on databases containing FTS5 virtual
-- tables. To export, DROP TABLE memory_chunks_fts (and its triggers), export,
-- then recreate the virtual table + triggers and run
-- INSERT INTO memory_chunks_fts(memory_chunks_fts) VALUES('rebuild');

CREATE TABLE memory_documents (
  id           TEXT PRIMARY KEY,             -- uuid
  user_id      TEXT NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'upload', -- e.g. "notion", "web", "upload"
  external_id  TEXT,                         -- caller's stable id (e.g. Notion page id); NULL for one-off uploads
  text         TEXT NOT NULL,                -- canonical document text (queue messages carry no text; the consumer re-reads from here)
  metadata_json TEXT,                        -- JSON blob: { url?, author?, ... }
  revision     INTEGER NOT NULL DEFAULT 0,   -- bumped on every upsert; sent as sourceRevision
  chunk_count  INTEGER NOT NULL DEFAULT 0,   -- persisted by the queue consumer after ingest
  created_at   INTEGER NOT NULL,             -- epoch ms
  updated_at   INTEGER NOT NULL
);
-- Idempotency: one document per (user, source, external_id).
CREATE UNIQUE INDEX idx_memory_documents_external
  ON memory_documents(user_id, source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE memory_chunks (
  id           TEXT PRIMARY KEY,             -- == vector id: ${parentId}:${kind}:${chunkIndex}
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('transcript','summary','document')),
  session_id   TEXT,                         -- sessions.id when kind IN ('transcript','summary')
  document_id  TEXT,                         -- memory_documents.id when kind = 'document'
  chunk_index  INTEGER NOT NULL,
  text         TEXT NOT NULL,
  speaker      TEXT,                         -- set when the chunk is single-speaker, else NULL
  start_ms     INTEGER,
  end_ms       INTEGER,
  content_hash TEXT NOT NULL,                -- sha-256 of text; skip re-embed when unchanged
  source_revision INTEGER NOT NULL DEFAULT 0,-- revision of the parent content this chunk came from
  embedding_model TEXT,
  embedded_at  INTEGER,                      -- NULL = not yet in the vector index
  created_at   INTEGER NOT NULL              -- epoch ms of the PARENT (session/document) created_at
);
CREATE INDEX idx_memory_chunks_session ON memory_chunks(session_id);
CREATE INDEX idx_memory_chunks_document ON memory_chunks(document_id);
CREATE INDEX idx_memory_chunks_user ON memory_chunks(user_id, created_at);

-- FTS5 keyword index (external-content table over memory_chunks.text).
-- D1 supports fts5 (lowercase required). unicode61 default tokenizer handles
-- Hindi/Telugu (whitespace-separated scripts).
CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
  text, content='memory_chunks', content_rowid='rowid'
);

CREATE TRIGGER memory_chunks_fts_ai AFTER INSERT ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER memory_chunks_fts_ad AFTER DELETE ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER memory_chunks_fts_au AFTER UPDATE OF text ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO memory_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- LOCAL-DEV-ONLY vector store (used when DEV_LOCAL_VECTOR=1; see
-- worker/src/memory/index-store.ts). Vectorize has no local simulator in
-- `wrangler dev`, so dev stores vectors here and does cosine in JS. Harmless
-- (empty) in production, where the real Vectorize index is used.
CREATE TABLE memory_vectors_dev (
  id            TEXT PRIMARY KEY,            -- == vector id
  namespace     TEXT NOT NULL,               -- == user_id
  vector_json   TEXT NOT NULL,               -- JSON number[]
  metadata_json TEXT
);
CREATE INDEX idx_memory_vectors_dev_ns ON memory_vectors_dev(namespace);
