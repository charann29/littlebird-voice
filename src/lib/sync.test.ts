/**
 * Tests for the outbox drain (lib/sync): token gating, upsert/delete pushes,
 * delete-supersedes-upsert coalescing, 404-on-delete acknowledgment, failure
 * bookkeeping (attempts/lastError), 401 pass abort, and single-flight.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../types";
import { setApiToken } from "./api";
import {
  _resetDBForTests,
  getOps,
  getRecording,
  putRecordingAndEnqueue,
  updateOp,
} from "./db";
import { drainOutbox, getPendingOpCount } from "./sync";

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: crypto.randomUUID(),
    title: null,
    createdAt: Date.now(),
    durationMs: 1000,
    mimeType: "audio/webm;codecs=opus",
    blobSize: 3,
    blob: new Blob(["abc"], { type: "audio/webm" }),
    status: "done",
    transcript: "hello world",
    error: null,
    sonioxFileId: null,
    sonioxTranscriptionId: null,
    segments: null,
    syncState: "local",
    ...overrides,
  };
}

type FetchCall = { url: string; method: string; body: unknown };

/** Install a fetch stub; returns the recorded calls. */
function stubFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({
        url,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });
      return responder(url, init);
    }),
  );
  return calls;
}

const ok = (body: unknown = {}) =>
  new Response(JSON.stringify(body), { status: 200 });
const noContent = () => new Response(null, { status: 204 });
const errorRes = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: code } }), { status });

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  _resetDBForTests();
  setApiToken("test-token");
});

afterEach(async () => {
  setApiToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Let any stray drain pass settle so it can't leak into the next test.
  await drainOutbox();
});

describe("drainOutbox", () => {
  it("no-ops silently when no token is set (ops accumulate)", async () => {
    setApiToken(null);
    const calls = stubFetch(() => ok());
    await putRecordingAndEnqueue(makeRecording());

    await drainOutbox();

    expect(calls).toHaveLength(0);
    expect(await getPendingOpCount()).toBe(1);
  });

  it("pushes an upsert as PUT session + PUT transcript, settles the op, marks synced", async () => {
    const rec = makeRecording({
      segments: [
        { speaker: "1", start_ms: 0, end_ms: 500, text: "hello" },
        { speaker: "2", start_ms: 500, end_ms: 900, text: "world" },
      ],
    });
    const calls = stubFetch(() => ok());
    await putRecordingAndEnqueue(rec);

    await drainOutbox();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT /api/sessions/${rec.id}`,
      `PUT /api/sessions/${rec.id}/transcript`,
    ]);
    // Segments preferred over the single full-text fallback.
    expect(calls[1].body).toEqual({
      segments: [
        { speaker: "1", start_ms: 0, end_ms: 500, text: "hello" },
        { speaker: "2", start_ms: 500, end_ms: 900, text: "world" },
      ],
    });
    expect(await getPendingOpCount()).toBe(0);
    expect((await getRecording(rec.id))?.syncState).toBe("synced");
  });

  it("includes the local rename title in the session PUT body", async () => {
    const rec = makeRecording({ title: "Renamed locally", segments: null, transcript: null });
    const calls = stubFetch(() => ok());
    await putRecordingAndEnqueue(rec);

    await drainOutbox();

    expect(calls[0].body).toMatchObject({ title: "Renamed locally" });
  });

  it("sends an empty title when never renamed (server keeps its own)", async () => {
    const rec = makeRecording({ title: null, segments: null, transcript: null });
    const calls = stubFetch(() => ok());
    await putRecordingAndEnqueue(rec);

    await drainOutbox();

    expect(calls[0].body).toMatchObject({ title: "" });
  });

  it("falls back to one full-text segment when no diarized segments exist", async () => {
    const rec = makeRecording({ segments: null, transcript: "full text" });
    const calls = stubFetch(() => ok());
    await putRecordingAndEnqueue(rec);

    await drainOutbox();

    expect(calls[1].body).toEqual({ segments: [{ text: "full text" }] });
  });

  it("skips the transcript PUT when there is no transcript at all", async () => {
    const rec = makeRecording({
      status: "pending",
      transcript: null,
      segments: null,
    });
    const calls = stubFetch(() => ok());
    await putRecordingAndEnqueue(rec);

    await drainOutbox();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT /api/sessions/${rec.id}`,
    ]);
    expect(await getPendingOpCount()).toBe(0);
  });

  it("delete supersedes a queued upsert for the same id (upsert dropped unsent)", async () => {
    const rec = makeRecording();
    const calls = stubFetch((_url, init) =>
      init.method === "DELETE" ? noContent() : ok(),
    );
    await putRecordingAndEnqueue(rec);
    // Simulate an upsert queued before the delete landed elsewhere: enqueue a
    // delete op directly alongside the pending upsert.
    const { deleteRecordingAndEnqueue } = await import("./db");
    // deleteRecordingAndEnqueue removes queued upserts; recreate one after to
    // exercise the DRAIN-TIME guard.
    await deleteRecordingAndEnqueue(rec.id);
    await putRecordingAndEnqueueRaw(rec.id);

    await drainOutbox();

    // Only the DELETE hit the network; the upsert op was dropped.
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(await getPendingOpCount()).toBe(0);
  });

  it("treats DELETE 404 as acknowledged (op settled)", async () => {
    const rec = makeRecording();
    stubFetch(() => errorRes(404, "not_found"));
    await putRecordingAndEnqueue(rec);
    const { deleteRecordingAndEnqueue } = await import("./db");
    await deleteRecordingAndEnqueue(rec.id);

    await drainOutbox();

    expect(await getPendingOpCount()).toBe(0);
  });

  it("drops an upsert op whose recording no longer exists (no tombstone)", async () => {
    const rec = makeRecording();
    const calls = stubFetch(() => ok());
    await putRecordingAndEnqueue(rec);
    // Remove the row WITHOUT the atomic delete (simulates superseded state).
    const { getDB } = await import("./db");
    const db = await getDB();
    await db.delete("recordings", rec.id);

    await drainOutbox();

    expect(calls).toHaveLength(0);
    expect(await getPendingOpCount()).toBe(0);
  });

  it("keeps a failed op queued with attempts+lastError", async () => {
    const rec = makeRecording();
    stubFetch(() => errorRes(500, "internal_error"));
    await putRecordingAndEnqueue(rec);

    await drainOutbox();

    const ops = await getOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].attempts).toBe(1);
    expect(ops[0].lastError).toBeTruthy();
    expect(ops[0].lastAttemptAt).toBeTypeOf("number");
  });

  it("respects attempt-count backoff (recently-failed op is skipped)", async () => {
    const rec = makeRecording();
    const calls = stubFetch(() => ok());
    await putRecordingAndEnqueue(rec);
    const [op] = await getOps();
    await updateOp(op.opId, {
      attempts: 1,
      lastAttemptAt: Date.now(), // just failed — 30s backoff not elapsed
      lastError: "x",
    });

    await drainOutbox();

    expect(calls).toHaveLength(0);
    expect(await getPendingOpCount()).toBe(1);
  });

  it("aborts the pass on 401 (remaining ops untouched this pass)", async () => {
    const a = makeRecording();
    const b = makeRecording();
    const calls = stubFetch(() => errorRes(401, "unauthorized"));
    await putRecordingAndEnqueue(a);
    await new Promise((r) => setTimeout(r, 2));
    await putRecordingAndEnqueue(b);

    await drainOutbox();

    // Only the first (oldest) op was attempted.
    expect(calls).toHaveLength(1);
    expect(await getPendingOpCount()).toBe(2);
    const ops = await getOps();
    expect(ops[0].attempts).toBe(1);
    expect(ops[1].attempts).toBe(0);
  });

  it("is single-flight: a drain during a drain schedules ONE follow-up pass", async () => {
    const rec = makeRecording();
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => (resolveFirst = r));
    let sessionPuts = 0;
    stubFetch(async (url, init) => {
      if (init.method === "PUT" && !url.includes("/transcript")) {
        sessionPuts += 1;
        if (sessionPuts === 1) await gate; // hold the first pass open
      }
      return ok();
    });
    await putRecordingAndEnqueue(rec);

    const first = drainOutbox();
    // Re-entrant calls while the first pass is blocked:
    const second = drainOutbox();
    const third = drainOutbox();
    resolveFirst();
    await Promise.all([first, second, third]);

    // First pass pushed the op; the single follow-up pass found an empty
    // outbox — so exactly one session PUT total.
    expect(sessionPuts).toBe(1);
    expect(await getPendingOpCount()).toBe(0);
  });
});

/** Enqueue a bare upsert op for an id (bypasses the atomic API) — test rig. */
async function putRecordingAndEnqueueRaw(recordingId: string): Promise<void> {
  const { getDB } = await import("./db");
  const db = await getDB();
  await db.put("syncOutbox", {
    opId: crypto.randomUUID(),
    recordingId,
    op: "upsert",
    enqueuedAt: Date.now(),
    attempts: 0,
    lastError: null,
  });
}
