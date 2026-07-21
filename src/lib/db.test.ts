/**
 * Tests for the v2 IndexedDB layer: atomic mutate-and-enqueue transactions
 * (recordings + syncOutbox) and the outbox DAO — against fake-indexeddb.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../types";
import {
  _resetDBForTests,
  countOps,
  deleteOp,
  deleteRecordingAndEnqueue,
  getAllRecordings,
  getOps,
  getRecording,
  putRecordingAndEnqueue,
  updateOp,
  updateRecording,
  updateRecordingAndEnqueue,
} from "./db";

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: crypto.randomUUID(),
    title: null,
    createdAt: Date.now(),
    durationMs: 1000,
    mimeType: "audio/webm;codecs=opus",
    blobSize: 3,
    blob: new Blob(["abc"], { type: "audio/webm" }),
    status: "pending",
    transcript: null,
    error: null,
    sonioxFileId: null,
    sonioxTranscriptionId: null,
    segments: null,
    syncState: "local",
    ...overrides,
  };
}

beforeEach(() => {
  // Fresh IndexedDB universe + fresh cached connection per test.
  globalThis.indexedDB = new IDBFactory();
  _resetDBForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("putRecordingAndEnqueue", () => {
  it("persists the recording (syncState dirty) and enqueues one upsert op", async () => {
    const rec = makeRecording();
    await putRecordingAndEnqueue(rec);

    const stored = await getRecording(rec.id);
    expect(stored?.syncState).toBe("dirty");

    const ops = await getOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      recordingId: rec.id,
      op: "upsert",
      attempts: 0,
      lastError: null,
    });
  });

  it("coalesces: replaces any queued upsert for the same id", async () => {
    const rec = makeRecording();
    await putRecordingAndEnqueue(rec);
    await putRecordingAndEnqueue(rec);

    const ops = await getOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("upsert");
  });

  it("is atomic: a mid-transaction failure leaves NEITHER store changed", async () => {
    const rec = makeRecording();
    // makeOp() calls crypto.randomUUID INSIDE the open transaction — throwing
    // there simulates a mid-transaction crash after the recording was put.
    const spy = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(putRecordingAndEnqueue(rec)).rejects.toThrow("boom");
    spy.mockRestore();

    expect(await getRecording(rec.id)).toBeUndefined();
    expect(await countOps()).toBe(0);
  });
});

describe("updateRecordingAndEnqueue", () => {
  it("merges the patch, marks dirty, and enqueues a coalesced upsert", async () => {
    const rec = makeRecording();
    await putRecordingAndEnqueue(rec);

    const updated = await updateRecordingAndEnqueue(rec.id, {
      status: "done",
      transcript: "hello",
    });
    expect(updated?.status).toBe("done");
    expect(updated?.transcript).toBe("hello");
    expect(updated?.syncState).toBe("dirty");

    const ops = await getOps();
    expect(ops).toHaveLength(1); // coalesced with the put's op
    expect(ops[0].op).toBe("upsert");
  });

  it("returns undefined and enqueues NOTHING when the id is gone", async () => {
    const result = await updateRecordingAndEnqueue("missing-id", {
      status: "done",
    });
    expect(result).toBeUndefined();
    expect(await countOps()).toBe(0);
  });
});

describe("deleteRecordingAndEnqueue", () => {
  it("deletes the row, removes queued ops for the id, enqueues one delete op", async () => {
    const rec = makeRecording();
    await putRecordingAndEnqueue(rec);
    await updateRecordingAndEnqueue(rec.id, { transcript: "x" });

    await deleteRecordingAndEnqueue(rec.id);

    expect(await getRecording(rec.id)).toBeUndefined();
    const ops = await getOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ recordingId: rec.id, op: "delete" });
  });

  it("does not touch ops for OTHER recordings", async () => {
    const a = makeRecording();
    const b = makeRecording();
    await putRecordingAndEnqueue(a);
    await putRecordingAndEnqueue(b);

    await deleteRecordingAndEnqueue(a.id);

    const ops = await getOps();
    expect(ops).toHaveLength(2);
    expect(
      ops.find((o) => o.recordingId === b.id)?.op,
    ).toBe("upsert");
    expect(
      ops.find((o) => o.recordingId === a.id)?.op,
    ).toBe("delete");
  });
});

describe("local-only updateRecording", () => {
  it("does NOT enqueue an outbox op", async () => {
    const rec = makeRecording();
    await putRecordingAndEnqueue(rec);
    const before = await countOps();

    await updateRecording(rec.id, { status: "transcribing" });

    expect(await countOps()).toBe(before);
    expect((await getRecording(rec.id))?.status).toBe("transcribing");
  });
});

describe("v3 upgrade (title backfill)", () => {
  it("backfills title: null on pre-v3 rows and persists renames", async () => {
    // Build a v2 database by hand: same stores, a row WITHOUT `title`.
    const legacy = { ...makeRecording() } as Record<string, unknown>;
    delete legacy.title;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("littlebird-voice", 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.createObjectStore("recordings", { keyPath: "id" });
        store.createIndex("by-createdAt", "createdAt");
        store.createIndex("by-status", "status");
        const outbox = db.createObjectStore("syncOutbox", { keyPath: "opId" });
        outbox.createIndex("by-recordingId", "recordingId");
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("recordings", "readwrite");
        tx.objectStore("recordings").put(legacy);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    // Opening through getDB() runs the v3 upgrade + backfill.
    const stored = await getRecording(legacy.id as string);
    expect(stored).toBeDefined();
    expect(stored?.title).toBeNull();

    // A rename persists durably (survives "reload" = fresh read).
    await updateRecordingAndEnqueue(legacy.id as string, {
      title: "Renamed offline",
    });
    const renamed = await getRecording(legacy.id as string);
    expect(renamed?.title).toBe("Renamed offline");
  });
});

describe("outbox DAO", () => {
  it("getOps returns oldest-first; deleteOp settles; updateOp patches", async () => {
    const a = makeRecording();
    const b = makeRecording();
    await putRecordingAndEnqueue(a);
    await new Promise((r) => setTimeout(r, 2)); // distinct enqueuedAt
    await putRecordingAndEnqueue(b);

    let ops = await getOps();
    expect(ops.map((o) => o.recordingId)).toEqual([a.id, b.id]);

    await updateOp(ops[0].opId, { attempts: 3, lastError: "err" });
    ops = await getOps();
    expect(ops[0]).toMatchObject({ attempts: 3, lastError: "err" });

    await deleteOp(ops[0].opId);
    expect(await countOps()).toBe(1);
  });

  it("getAllRecordings sorts newest-first", async () => {
    const older = makeRecording({ createdAt: 100 });
    const newer = makeRecording({ createdAt: 200 });
    await putRecordingAndEnqueue(older);
    await putRecordingAndEnqueue(newer);

    const all = await getAllRecordings();
    expect(all.map((r) => r.id)).toEqual([newer.id, older.id]);
  });
});
