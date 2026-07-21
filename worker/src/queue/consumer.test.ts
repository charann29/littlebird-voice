import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../env";
import type { IngestMessage } from "../services/ingest-message";
import { dispatchIngestMessage, queueHandler } from "./consumer";
import {
  RecordingIndex,
  RecordingProvider,
  SINGLE_USER_ID,
  chunkCount,
  seedSegments,
  seedSession,
} from "../../test/memory-helpers";

function deps() {
  return {
    provider: new RecordingProvider(),
    index: new RecordingIndex(),
    handleTranscriptAutoSummary: vi.fn().mockResolvedValue("generated"),
  };
}

function transcriptMsg(
  parentId: string,
  overrides: Partial<IngestMessage> = {},
): IngestMessage {
  return {
    userId: SINGLE_USER_ID,
    kind: "transcript",
    parentId,
    sourceRevision: 1,
    ...overrides,
  };
}

describe("dispatchIngestMessage", () => {
  it("runs ALL applicable jobs (index + summarize) for jobless transcript messages", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "dispatch me" }]);

    const d = deps();
    const message = transcriptMsg(sessionId); // jobs omitted → all applicable
    await dispatchIngestMessage(env as Env, message, d);
    expect(await chunkCount(sessionId, "transcript")).toBe(1);
    // Regression: omitted jobs used to default to ["index"], silently
    // skipping auto-summary on transcript completion.
    expect(d.handleTranscriptAutoSummary).toHaveBeenCalledTimes(1);
    expect(d.handleTranscriptAutoSummary).toHaveBeenCalledWith(env, message);
  });

  it("honors explicit jobs: ['index'] on transcripts (no auto-summary)", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "index only" }]);

    const d = deps();
    await dispatchIngestMessage(
      env as Env,
      transcriptMsg(sessionId, { jobs: ["index"] }),
      d,
    );
    expect(await chunkCount(sessionId, "transcript")).toBe(1);
    expect(d.handleTranscriptAutoSummary).not.toHaveBeenCalled();
  });

  it("routes document messages to ingestMemory even without jobs", async () => {
    const docId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO memory_documents (id, user_id, title, source, text, revision, created_at, updated_at)
       VALUES (?, ?, 'D', 'upload', 'document body text', 1, ?, ?)`,
    )
      .bind(docId, SINGLE_USER_ID, Date.now(), Date.now())
      .run();

    await dispatchIngestMessage(
      env as Env,
      { userId: SINGLE_USER_ID, kind: "document", parentId: docId, sourceRevision: 1 },
      deps(),
    );
    expect(await chunkCount(docId, "document")).toBe(1);
  });

  it("invokes handleTranscriptAutoSummary for transcript messages with jobs including summarize", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "summarize this" }]);

    const d = deps();
    const message = transcriptMsg(sessionId, { jobs: ["index", "summarize"] });
    await dispatchIngestMessage(env as Env, message, d);
    expect(await chunkCount(sessionId, "transcript")).toBe(1); // index ran too
    expect(d.handleTranscriptAutoSummary).toHaveBeenCalledTimes(1);
    expect(d.handleTranscriptAutoSummary).toHaveBeenCalledWith(env, message);
  });

  it("does NOT auto-summarize summary-kind messages (even with summarize job)", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    const d = deps();
    await dispatchIngestMessage(
      env as Env,
      { userId: SINGLE_USER_ID, kind: "summary", parentId: sessionId, sourceRevision: 1, jobs: ["summarize", "index"] },
      d,
    );
    expect(d.handleTranscriptAutoSummary).not.toHaveBeenCalled();
  });

  it("jobless non-transcript kinds default to index only (no auto-summary)", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    const d = deps();
    await dispatchIngestMessage(
      env as Env,
      { userId: SINGLE_USER_ID, kind: "summary", parentId: sessionId, sourceRevision: 1 },
      d,
    );
    expect(d.handleTranscriptAutoSummary).not.toHaveBeenCalled();
  });

  it("summarize-only jobs skip indexing", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "no index for me" }]);
    const d = deps();
    await dispatchIngestMessage(
      env as Env,
      transcriptMsg(sessionId, { jobs: ["summarize"] }),
      d,
    );
    expect(await chunkCount(sessionId, "transcript")).toBe(0);
    expect(d.handleTranscriptAutoSummary).toHaveBeenCalledTimes(1);
  });

  it("propagates job failures (queue retry semantics)", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    const d = deps();
    d.handleTranscriptAutoSummary.mockRejectedValueOnce(new Error("llm down"));
    await expect(
      dispatchIngestMessage(env as Env, transcriptMsg(sessionId, { jobs: ["summarize"] }), d),
    ).rejects.toThrow("llm down");
  });

  it("drops terminal ai_bad_output summarize failures without throwing", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    const d = deps();
    const err = Object.assign(new Error("bad json"), { code: "ai_bad_output" });
    d.handleTranscriptAutoSummary.mockRejectedValueOnce(err);
    await expect(
      dispatchIngestMessage(env as Env, transcriptMsg(sessionId, { jobs: ["summarize"] }), d),
    ).resolves.toBeUndefined();
  });
});

describe("queueHandler (retry/ack semantics)", () => {
  interface FakeMessage {
    body: unknown;
    attempts: number;
    acked: boolean;
    retried: boolean;
    ack(): void;
    retry(): void;
  }

  function fakeMessage(body: unknown, attempts = 1): FakeMessage {
    return {
      body,
      attempts,
      acked: false,
      retried: false,
      ack() {
        this.acked = true;
      },
      retry() {
        this.retried = true;
      },
    };
  }

  function fakeBatch(messages: FakeMessage[]): MessageBatch<unknown> {
    return {
      queue: "littlebird-ingest",
      messages: messages as unknown as Message<unknown>[],
      ackAll() {
        for (const m of messages) m.ack();
      },
      retryAll() {
        for (const m of messages) m.retry();
      },
    } as unknown as MessageBatch<unknown>;
  }

  it("acks processed messages and retries failing ones independently", async () => {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "batch item" }]);

    // Good message (valid session; DEV seams active via test bindings) and a
    // failing one: transcript for a session that exists but whose ingest
    // throws — simulate by pointing at a session while the summarize handler
    // is unavailable... simpler: a message whose kind is valid but whose
    // ingest throws is hard to fake here, so use a malformed message (acked)
    // plus a good one, and separately verify retry() on a poisoned message.
    const good = fakeMessage(transcriptMsg(sessionId));
    const malformed = fakeMessage({ nope: true });
    await queueHandler(fakeBatch([good, malformed]), env as Env);
    expect(good.acked).toBe(true);
    expect(good.retried).toBe(false);
    expect(malformed.acked).toBe(true); // malformed forever → ack, not retry
    expect(await chunkCount(sessionId, "transcript")).toBe(1);
  });

  it("retries a message whose job throws (→ DLQ after max_retries)", async () => {
    // Force a throw inside dispatch: DEV_LOCAL_VECTOR off makes
    // getMemoryIndex demand the (absent) VECTORIZE binding.
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId);
    await seedSegments(sessionId, [{ speaker: "1", text: "will fail" }]);
    const brokenEnv = { ...env, DEV_LOCAL_VECTOR: undefined, VECTORIZE: undefined } as unknown as Env;

    const message = fakeMessage(transcriptMsg(sessionId), 1);
    await queueHandler(fakeBatch([message]), brokenEnv);
    expect(message.retried).toBe(true);
    expect(message.acked).toBe(false);

    // wrangler.jsonc declares max_retries 3 + DLQ littlebird-ingest-dlq; the
    // queue runtime moves the message there after the 3rd retry — our
    // contract is simply to call retry() every time it fails.
    const again = fakeMessage(transcriptMsg(sessionId), 3);
    await queueHandler(fakeBatch([again]), brokenEnv);
    expect(again.retried).toBe(true);
  });
});
