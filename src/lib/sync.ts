/**
 * Outbox-driven one-way sync (client → server).
 *
 * lib/db.ts enqueues ops ATOMICALLY with each recording mutation; this module
 * only READS and settles the outbox. `drainOutbox()` walks pending ops
 * oldest-first and pushes them to the Worker:
 *   - upsert ⇒ PUT /api/sessions/:id (+ PUT .../transcript when one exists)
 *   - delete ⇒ DELETE /api/sessions/:id (404 = already gone = acknowledged)
 *
 * Ops are removed only after a 2xx (or delete-404). On failure the op stays
 * queued with attempts+lastError; retries happen on the next drain trigger
 * (hydration, `online` event, token set/change) subject to attempt-count
 * backoff. No-ops silently when no API token is set — ops accumulate.
 */

import { apiFetch, ApiError, getApiToken, onApiTokenChange } from "./api";
import type {
  PutSessionBody,
  PutTranscriptBody,
  SegmentInput,
} from "./api-types";
import {
  countOps,
  deleteOp,
  getOps,
  getRecording,
  updateOp,
  updateRecording,
} from "./db";
import type { Recording, SyncOp } from "../types";

/** Base delay for attempt-count backoff (delay = BASE * 2^(attempts-1)). */
const BACKOFF_BASE_MS = 30_000;
/** Cap so an op is retried at least this often once triggers fire. */
const BACKOFF_MAX_MS = 15 * 60_000;

/** Notified after every drain (for pending-count badges). */
type DrainListener = () => void;
const drainListeners = new Set<DrainListener>();

export function onOutboxSettled(cb: DrainListener): () => void {
  drainListeners.add(cb);
  return () => drainListeners.delete(cb);
}

function notifySettled(): void {
  for (const cb of drainListeners) {
    try {
      cb();
    } catch {
      /* listener errors must not break the drain */
    }
  }
}

/** Number of pending outbox ops (for the badge). */
export function getPendingOpCount(): Promise<number> {
  return countOps();
}

function backoffElapsed(op: SyncOp, now: number): boolean {
  if (op.attempts === 0) return true;
  const delay = Math.min(
    BACKOFF_BASE_MS * 2 ** (op.attempts - 1),
    BACKOFF_MAX_MS,
  );
  return now - (op.lastAttemptAt ?? 0) >= delay;
}

function sessionBodyFor(rec: Recording): PutSessionBody {
  return {
    // Local rename (if any); the server keeps its own title when this is
    // empty, so an un-renamed client can never clobber a server-side title.
    title: rec.title ?? "",
    source: "mic",
    status: rec.status,
    created_at: rec.createdAt,
    updated_at: Date.now(),
    duration_ms: rec.durationMs,
    mime_type: rec.mimeType,
    blob_size: rec.blobSize,
    error: rec.error,
  };
}

function transcriptBodyFor(rec: Recording): PutTranscriptBody | null {
  if (rec.segments && rec.segments.length > 0) {
    const segments: SegmentInput[] = rec.segments.map((s) => ({
      speaker: s.speaker,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      text: s.text,
    }));
    return { segments };
  }
  if (rec.transcript) {
    return { segments: [{ text: rec.transcript }] };
  }
  return null;
}

async function pushUpsert(rec: Recording): Promise<void> {
  await apiFetch(`/sessions/${rec.id}`, {
    method: "PUT",
    body: JSON.stringify(sessionBodyFor(rec)),
  });
  const transcript = transcriptBodyFor(rec);
  if (transcript) {
    await apiFetch(`/sessions/${rec.id}/transcript`, {
      method: "PUT",
      body: JSON.stringify(transcript),
    });
  }
}

async function pushDelete(recordingId: string): Promise<void> {
  try {
    await apiFetch(`/sessions/${recordingId}`, { method: "DELETE" });
  } catch (err) {
    // 404 = the goal state already holds — treat as acknowledged.
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}

let draining = false;
let rerunRequested = false;

/**
 * Drain the outbox: serialized (single-flight — a call during an active
 * drain schedules exactly one follow-up pass), never throws, never blocks
 * the UI.
 */
export async function drainOutbox(): Promise<void> {
  if (draining) {
    rerunRequested = true;
    return;
  }
  draining = true;
  try {
    do {
      rerunRequested = false;
      await drainOnce();
    } while (rerunRequested);
  } finally {
    draining = false;
    notifySettled();
  }
}

async function drainOnce(): Promise<void> {
  if (!getApiToken()) return; // ops accumulate until a token is set

  let ops: SyncOp[];
  try {
    ops = await getOps();
  } catch {
    return;
  }
  if (ops.length === 0) return;

  // Coalesce per recording: a delete supersedes queued upserts (db.ts already
  // removes them at enqueue time; this guards ops enqueued before the delete
  // landed in a different tab or an older DB snapshot).
  const deleteIds = new Set(
    ops.filter((o) => o.op === "delete").map((o) => o.recordingId),
  );

  const now = Date.now();
  for (const op of ops) {
    if (op.op === "upsert" && deleteIds.has(op.recordingId)) {
      await deleteOp(op.opId).catch(() => {});
      continue;
    }
    if (!backoffElapsed(op, now)) continue;

    try {
      if (op.op === "delete") {
        await pushDelete(op.recordingId);
        await deleteOp(op.opId);
      } else {
        const rec = await getRecording(op.recordingId);
        if (!rec) {
          // Deleted mid-sync with no tombstone (superseded elsewhere) — drop.
          await deleteOp(op.opId);
          continue;
        }
        await pushUpsert(rec);
        await deleteOp(op.opId);
        // Mark synced ONLY if no newer op was enqueued for this id meanwhile.
        const remaining = (await getOps()).some(
          (o) => o.recordingId === op.recordingId,
        );
        if (!remaining) {
          await updateRecording(op.recordingId, { syncState: "synced" });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateOp(op.opId, {
        attempts: op.attempts + 1,
        lastError: message,
        lastAttemptAt: Date.now(),
      }).catch(() => {});
      if (err instanceof ApiError && err.status === 401) {
        // Token is wrong for every subsequent op too — stop this pass.
        return;
      }
    }
  }
}

let triggersInstalled = false;

/**
 * Install the drain triggers (idempotent): app hydration is the caller's
 * kick, plus window "online" and API-token set/change.
 */
export function installSyncTriggers(): void {
  if (triggersInstalled || typeof window === "undefined") return;
  triggersInstalled = true;
  window.addEventListener("online", () => void drainOutbox());
  onApiTokenChange(() => void drainOutbox());
}
