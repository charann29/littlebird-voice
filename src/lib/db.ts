/**
 * IndexedDB access layer for littlebird-voice, built on `idb`.
 *
 * Recordings (including their audio Blob) are stored directly in IndexedDB so
 * the app works fully offline: audio is captured and persisted locally, then
 * transcribed opportunistically once a network connection is available.
 *
 * v2 adds the `syncOutbox` store: every server-sync intent (upsert/delete) is
 * persisted as a SyncOp ATOMICALLY with the recording mutation — the
 * `*AndEnqueue` methods run ONE transaction spanning both stores, so a crash
 * can never persist a mutation without its sync op (or vice versa). Ops are
 * settled (deleted) only by lib/sync.ts after the server acknowledges.
 */

import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
} from "idb";
import type { Recording, SyncOp } from "../types";

const DB_NAME = "littlebird-voice";
const DB_VERSION = 2;
const STORE = "recordings";
const OUTBOX = "syncOutbox";

interface LittlebirdDB extends DBSchema {
  recordings: {
    key: string;
    value: Recording;
    indexes: {
      "by-createdAt": number;
      "by-status": string;
    };
  };
  syncOutbox: {
    key: string;
    value: SyncOp;
    indexes: {
      "by-recordingId": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<LittlebirdDB>> | null = null;

/** Open (or reuse) the singleton IndexedDB connection. */
export function getDB(): Promise<IDBPDatabase<LittlebirdDB>> {
  if (!dbPromise) {
    dbPromise = openDB<LittlebirdDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("by-createdAt", "createdAt");
          store.createIndex("by-status", "status");
        }
        if (oldVersion < 2) {
          const outbox = db.createObjectStore(OUTBOX, { keyPath: "opId" });
          outbox.createIndex("by-recordingId", "recordingId");
          // Backfill new Recording fields on existing rows.
          const store = tx.objectStore(STORE);
          void store.openCursor().then(function backfill(cursor): Promise<void> | void {
            if (!cursor) return;
            const rec = cursor.value;
            let dirty = false;
            if (rec.syncState === undefined) {
              rec.syncState = "local";
              dirty = true;
            }
            if (rec.segments === undefined) {
              rec.segments = null;
              dirty = true;
            }
            if (dirty) void cursor.update(rec);
            return cursor.continue().then(backfill);
          });
        }
      },
    });
  }
  return dbPromise;
}

/** TEST ONLY: reset the cached connection (fake-indexeddb per-test DBs). */
export function _resetDBForTests(): void {
  dbPromise = null;
}

function makeOp(recordingId: string, op: SyncOp["op"]): SyncOp {
  return {
    opId: crypto.randomUUID(),
    recordingId,
    op,
    enqueuedAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
}

// ---------------------------------------------------------------------------
// Plain reads + local-only writes (no sync side effects)
// ---------------------------------------------------------------------------

/** Fetch a single recording by id, or undefined if not found. */
export async function getRecording(id: string): Promise<Recording | undefined> {
  const db = await getDB();
  return db.get(STORE, id);
}

/** Fetch all recordings sorted newest-first by createdAt. */
export async function getAllRecordings(): Promise<Recording[]> {
  const db = await getDB();
  const all = await db.getAll(STORE);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * LOCAL-ONLY merge of a partial patch (no outbox op) — for transient state
 * that must not sync (e.g. status flips while transcribing). Returns the
 * updated recording, or undefined if the id no longer exists.
 */
export async function updateRecording(
  id: string,
  patch: Partial<Recording>,
): Promise<Recording | undefined> {
  const db = await getDB();
  const existing = await db.get(STORE, id);
  if (!existing) return undefined;
  const updated: Recording = { ...existing, ...patch, id: existing.id };
  await db.put(STORE, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Atomic mutate-and-enqueue (ONE transaction spanning recordings + syncOutbox)
// ---------------------------------------------------------------------------

/**
 * Remove queued UPSERT ops for a recording inside an open transaction
 * (coalescing: at most one queued upsert per recording; a delete supersedes
 * all of them).
 */
async function clearQueuedUpserts(
  tx: IDBPTransaction<
    LittlebirdDB,
    ("recordings" | "syncOutbox")[],
    "readwrite"
  >,
  recordingId: string,
): Promise<void> {
  const outbox = tx.objectStore(OUTBOX);
  const ops = await outbox.index("by-recordingId").getAll(recordingId);
  for (const op of ops) {
    if (op.op === "upsert") await outbox.delete(op.opId);
  }
}

/** Put a (new or full) recording + enqueue a coalesced upsert op atomically. */
export async function putRecordingAndEnqueue(
  recording: Recording,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([STORE, OUTBOX], "readwrite");
  await tx.objectStore(STORE).put({ ...recording, syncState: "dirty" });
  await clearQueuedUpserts(tx, recording.id);
  await tx.objectStore(OUTBOX).put(makeOp(recording.id, "upsert"));
  await tx.done;
}

/**
 * Merge a patch into an existing recording + enqueue a coalesced upsert op
 * atomically. Returns the updated recording, or undefined (no-op, nothing
 * enqueued) if the id no longer exists.
 */
export async function updateRecordingAndEnqueue(
  id: string,
  patch: Partial<Recording>,
): Promise<Recording | undefined> {
  const db = await getDB();
  const tx = db.transaction([STORE, OUTBOX], "readwrite");
  const store = tx.objectStore(STORE);
  const existing = await store.get(id);
  if (!existing) {
    await tx.done;
    return undefined;
  }
  const updated: Recording = {
    ...existing,
    ...patch,
    id: existing.id,
    syncState: "dirty",
  };
  await store.put(updated);
  await clearQueuedUpserts(tx, id);
  await tx.objectStore(OUTBOX).put(makeOp(id, "upsert"));
  await tx.done;
  return updated;
}

/**
 * Delete the recording row (audio blob included) + enqueue the remote-delete
 * tombstone atomically. Queued upserts for the id are superseded (removed) in
 * the same transaction; the delete op survives until the server acknowledges.
 */
export async function deleteRecordingAndEnqueue(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([STORE, OUTBOX], "readwrite");
  await tx.objectStore(STORE).delete(id);
  const outbox = tx.objectStore(OUTBOX);
  const ops = await outbox.index("by-recordingId").getAll(id);
  for (const op of ops) await outbox.delete(op.opId);
  await outbox.put(makeOp(id, "delete"));
  await tx.done;
}

// ---------------------------------------------------------------------------
// Outbox DAO — used ONLY by lib/sync.ts (drainOutbox)
// ---------------------------------------------------------------------------

/** All pending ops, oldest-first. */
export async function getOps(): Promise<SyncOp[]> {
  const db = await getDB();
  const all = await db.getAll(OUTBOX);
  return all.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

/** Settle (remove) an op after the server acknowledged it. */
export async function deleteOp(opId: string): Promise<void> {
  const db = await getDB();
  await db.delete(OUTBOX, opId);
}

/** Record a failed attempt (attempts + lastError) on a queued op. */
export async function updateOp(
  opId: string,
  patch: Partial<SyncOp>,
): Promise<void> {
  const db = await getDB();
  const existing = await db.get(OUTBOX, opId);
  if (!existing) return;
  await db.put(OUTBOX, { ...existing, ...patch, opId: existing.opId });
}

/** Number of pending ops (for the sync badge). */
export async function countOps(): Promise<number> {
  const db = await getDB();
  return db.count(OUTBOX);
}
