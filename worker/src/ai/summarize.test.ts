import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env";
import type { IngestMessage } from "../services/ingest-message";
import { MockProvider } from "../../test/mock-provider";
import { api, sessionBody, testEnv } from "../../test/helpers";
import { setTestProvider } from "./provider";
import {
  generateSummary,
  handleTranscriptAutoSummary,
  loadStoredSummary,
  MEETING_SUMMARY_KIND,
  SessionNotFoundError,
  TranscriptNotReadyError,
  type SummarizeQueueMessage,
} from "./summarize";
import { isSummaryV1 } from "./types";

const USER_ID = "00000000-0000-4000-8000-000000000001";

let mock: MockProvider;
let env: Env;
let sent: IngestMessage[];

beforeEach(() => {
  mock = new MockProvider();
  setTestProvider(mock);
  ({ env, sent } = testEnv());
});

afterEach(() => setTestProvider(null));

/** Seed a session (default status done) + transcript segments. */
async function seedSession(
  opts: { status?: string; segments?: string[]; revision?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const res = await api(`/api/sessions/${id}`, {
    method: "PUT",
    body: sessionBody({ status: opts.status ?? "done" }),
    env,
  });
  expect(res.status).toBe(201);
  const segments = opts.segments ?? ["hello there", "quick sync about pricing"];
  for (let i = 0; i < segments.length; i++) {
    await env.DB.prepare(
      `INSERT INTO transcript_segments (session_id, seq, speaker, start_ms, end_ms, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, i, String((i % 2) + 1), i * 1000, (i + 1) * 1000, segments[i])
      .run();
  }
  if (opts.revision !== undefined) {
    await env.DB.prepare(
      "UPDATE sessions SET transcript_revision = ? WHERE id = ?",
    )
      .bind(opts.revision, id)
      .run();
  }
  return id;
}

describe("generateSummary", () => {
  it("generates, persists via saveSummary (row + ingest message), returns SummaryV1", async () => {
    const id = await seedSession({ revision: 3 });
    const summary = await generateSummary(env, USER_ID, id);

    expect(isSummaryV1(summary)).toBe(true);
    expect(summary.model).toBe("mock-model");
    expect(summary.source_revision).toBe(3);
    expect(summary.request_id).toBeNull();

    // Persisted through the canonical path: row exists…
    const row = await env.DB.prepare(
      "SELECT kind, model, revision FROM summaries WHERE session_id = ?",
    )
      .bind(id)
      .first<{ kind: string; model: string; revision: number }>();
    expect(row?.kind).toBe(MEETING_SUMMARY_KIND);
    expect(row?.model).toBe("mock-model");
    expect(row?.revision).toBe(1);
    // …AND the saveSummary post-save hook published a summary IngestMessage
    // (this only happens inside saveSummary, proving no direct DB write).
    const summaryMsgs = sent.filter((m) => m.kind === "summary" && m.parentId === id);
    expect(summaryMsgs).toHaveLength(1);
  });

  it("passes the JSON schema to the provider (JSON mode)", async () => {
    const id = await seedSession();
    await generateSummary(env, USER_ID, id);
    expect(mock.completeCalls[0].json).toBeDefined();
    expect(mock.completeCalls[0].system).toContain("Never invent content");
  });

  it("throws TranscriptNotReadyError when status is not 'done'", async () => {
    const id = await seedSession({ status: "transcribing" });
    await expect(generateSummary(env, USER_ID, id)).rejects.toBeInstanceOf(
      TranscriptNotReadyError,
    );
  });

  it("throws TranscriptNotReadyError when there are no segments", async () => {
    const id = await seedSession({ segments: [] });
    await expect(generateSummary(env, USER_ID, id)).rejects.toBeInstanceOf(
      TranscriptNotReadyError,
    );
  });

  it("throws SessionNotFoundError for unknown session", async () => {
    await expect(
      generateSummary(env, USER_ID, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("repairs malformed JSON once, then succeeds", async () => {
    const id = await seedSession();
    mock.respondWith("{not json!!", mock.defaultSummaryJson);
    const summary = await generateSummary(env, USER_ID, id);
    expect(summary.overview).toBe("Mock overview.");
    expect(mock.completeCalls).toHaveLength(2);
    expect(mock.completeCalls[1].user).toContain("invalid JSON");
  });

  it("throws ai_bad_output after the repair retry also fails", async () => {
    const id = await seedSession();
    mock.respondWith("{bad", "{still bad");
    await expect(generateSummary(env, USER_ID, id)).rejects.toMatchObject({
      code: "ai_bad_output",
    });
  });

  it("map-reduces long transcripts (multiple map calls + one reduce)", async () => {
    // ~40k tokens total → multiple 10k chunks.
    const id = await seedSession({
      segments: Array.from({ length: 20 }, (_, i) => `${i} ${"x".repeat(8000)}`),
    });
    await generateSummary(env, USER_ID, id);
    expect(mock.completeCalls.length).toBeGreaterThan(2);
    const reduce = mock.completeCalls[mock.completeCalls.length - 1];
    expect(reduce.user).toContain("Partial summaries of consecutive segments");
    expect(reduce.user).toContain("Merge into one summary");
  });
});

describe("handleTranscriptAutoSummary (queue idempotency)", () => {
  function msg(
    sessionId: string,
    overrides: Partial<SummarizeQueueMessage> = {},
  ): SummarizeQueueMessage {
    return {
      userId: USER_ID,
      kind: "transcript",
      parentId: sessionId,
      sourceRevision: 1,
      jobs: ["summarize"],
      ...overrides,
    };
  }

  it("generates on first delivery and records source_revision", async () => {
    const id = await seedSession({ revision: 1 });
    const result = await handleTranscriptAutoSummary(env, msg(id));
    expect(result).toBe("generated");
    const stored = await loadStoredSummary(env, id);
    expect(stored?.payload.source_revision).toBe(1);
  });

  it("redelivered message with matching source_revision is a no-op", async () => {
    const id = await seedSession({ revision: 1 });
    await handleTranscriptAutoSummary(env, msg(id));
    const callsAfterFirst = mock.completeCalls.length;

    const result = await handleTranscriptAutoSummary(env, msg(id));
    expect(result).toBe("skipped");
    expect(mock.completeCalls.length).toBe(callsAfterFirst); // no model call
  });

  it("stale sourceRevision (≠ current transcript_revision) is dropped", async () => {
    const id = await seedSession({ revision: 5 });
    const result = await handleTranscriptAutoSummary(
      env,
      msg(id, { sourceRevision: 2 }),
    );
    expect(result).toBe("skipped");
    expect(mock.completeCalls).toHaveLength(0);
    expect(await loadStoredSummary(env, id)).toBeNull();
  });

  it("forceSummary bypasses the revision short-circuit", async () => {
    const id = await seedSession({ revision: 1 });
    await handleTranscriptAutoSummary(env, msg(id)); // summary @ rev 1
    const callsAfterFirst = mock.completeCalls.length;

    const result = await handleTranscriptAutoSummary(
      env,
      msg(id, { forceSummary: true, requestId: "req-1" }),
    );
    expect(result).toBe("generated");
    expect(mock.completeCalls.length).toBeGreaterThan(callsAfterFirst);
    const stored = await loadStoredSummary(env, id);
    expect(stored?.payload.request_id).toBe("req-1");
  });

  it("duplicate forced requestId is a no-op", async () => {
    const id = await seedSession({ revision: 1 });
    await handleTranscriptAutoSummary(
      env,
      msg(id, { forceSummary: true, requestId: "req-dup" }),
    );
    const callsAfterFirst = mock.completeCalls.length;

    const result = await handleTranscriptAutoSummary(
      env,
      msg(id, { forceSummary: true, requestId: "req-dup" }),
    );
    expect(result).toBe("skipped");
    expect(mock.completeCalls.length).toBe(callsAfterFirst);
  });

  it("skips non-transcript messages and deleted sessions", async () => {
    const id = await seedSession();
    expect(
      await handleTranscriptAutoSummary(env, {
        ...msg(id),
        kind: "summary",
      }),
    ).toBe("skipped");
    expect(
      await handleTranscriptAutoSummary(env, msg(crypto.randomUUID())),
    ).toBe("skipped");
  });

  it("drops (skips) when the session is no longer 'done'", async () => {
    const id = await seedSession({ status: "transcribing", revision: 1 });
    expect(await handleTranscriptAutoSummary(env, msg(id))).toBe("skipped");
  });

  it("rethrows provider errors so the queue can retry", async () => {
    const id = await seedSession({ revision: 1 });
    mock.respondWith(new Error("capacity"));
    await expect(handleTranscriptAutoSummary(env, msg(id))).rejects.toThrow(
      "capacity",
    );
  });
});
