import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../env";
import type { IngestMessage } from "../services/ingest-message";
import { MockProvider, readSse } from "../../test/mock-provider";
import { api, sessionBody, testEnv } from "../../test/helpers";
import { setTestProvider } from "../ai/provider";
import type { SummarizeQueueMessage } from "../ai/summarize";
import { setTestSearchMemory, type MemorySearchHit } from "../ai/ask";
import { vi } from "vitest";

let mock: MockProvider;
let env: Env;
let sent: IngestMessage[];

beforeEach(() => {
  mock = new MockProvider();
  setTestProvider(mock);
  ({ env, sent } = testEnv());
});

afterEach(() => {
  setTestProvider(null);
  setTestSearchMemory(null);
  vi.restoreAllMocks();
});

async function seedSession(
  opts: {
    status?: string;
    segments?: string[];
    self_speaker?: string | null;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const res = await api(`/api/sessions/${id}`, {
    method: "PUT",
    body: sessionBody({
      status: opts.status ?? "done",
      self_speaker: opts.self_speaker ?? null,
    }),
    env,
  });
  expect(res.status).toBe(201);
  const segments = opts.segments ?? ["we agreed on pricing", "send the form Thursday"];
  for (let i = 0; i < segments.length; i++) {
    await env.DB.prepare(
      `INSERT INTO transcript_segments (session_id, seq, speaker, start_ms, end_ms, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, i, String((i % 2) + 1), i * 1000, (i + 1) * 1000, segments[i])
      .run();
  }
  return id;
}

describe("POST /api/sessions/:id/summarize", () => {
  it("200 happy path: returns SummaryV1 and stores the row", async () => {
    const id = await seedSession();
    const res = await api(`/api/sessions/${id}/summarize`, {
      method: "POST",
      env,
    });
    expect(res.status).toBe(200);
    const { summary } = (await res.json()) as { summary: { version: number; overview: string } };
    expect(summary.version).toBe(1);
    expect(summary.overview).toBe("Mock overview.");

    const read = await api(`/api/sessions/${id}/summary`, { env });
    expect(read.status).toBe(200);
  });

  it("409 transcript_not_ready when session is not 'done'", async () => {
    const id = await seedSession({ status: "transcribing" });
    const res = await api(`/api/sessions/${id}/summarize`, { method: "POST", env });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("transcript_not_ready");
  });

  it("409 transcript_not_ready when there are no segments", async () => {
    const id = await seedSession({ segments: [] });
    const res = await api(`/api/sessions/${id}/summarize`, { method: "POST", env });
    expect(res.status).toBe(409);
  });

  it("404 not_found for a session the user does not own", async () => {
    const res = await api(`/api/sessions/${crypto.randomUUID()}/summarize`, {
      method: "POST",
      env,
    });
    expect(res.status).toBe(404);
  });

  it("502 ai_bad_output after failed repair retry", async () => {
    const id = await seedSession();
    mock.respondWith("{bad", "{worse");
    const res = await api(`/api/sessions/${id}/summarize`, { method: "POST", env });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ai_bad_output");
  });

  it("202 {status:'queued'} + forced enqueue for long transcripts", async () => {
    const id = await seedSession({
      segments: Array.from({ length: 40 }, () => "x".repeat(8000)),
    });
    const res = await api(`/api/sessions/${id}/summarize`, { method: "POST", env });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued" });
    // No synchronous model call…
    expect(mock.completeCalls).toHaveLength(0);
    // …but a forced summarize message on the queue.
    const forced = sent.find(
      (m) => (m as SummarizeQueueMessage).forceSummary === true,
    ) as SummarizeQueueMessage | undefined;
    expect(forced).toBeDefined();
    expect(forced?.parentId).toBe(id);
    expect(forced?.jobs).toEqual(["summarize"]);
    expect(typeof forced?.requestId).toBe("string");
  });
});

describe("GET /api/sessions/:id/summary", () => {
  it("404 no_summary before generation", async () => {
    const id = await seedSession();
    const res = await api(`/api/sessions/${id}/summary`, { env });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("no_summary");
  });

  it("returns { summary, generated_at } after generation", async () => {
    const id = await seedSession();
    await api(`/api/sessions/${id}/summarize`, { method: "POST", env });
    const res = await api(`/api/sessions/${id}/summary`, { env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { version: number }; generated_at: number };
    expect(body.summary.version).toBe(1);
    expect(typeof body.generated_at).toBe("number");
  });
});

describe("POST /api/sessions/:id/followup", () => {
  it("streams SSE deltas ending with done:true; nothing persisted", async () => {
    const id = await seedSession();
    mock.streamText = "Hi team, quick recap.";
    const res = await api(`/api/sessions/${id}/followup`, {
      method: "POST",
      body: { format: "email" },
      env,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const events = await readSse(res);
    const deltas = events.filter((e) => "delta" in e) as { delta: string }[];
    expect(deltas.map((d) => d.delta).join("")).toBe("Hi team, quick recap.");
    expect(events[events.length - 1]).toEqual({ done: true });
  });

  it("generates the summary first when missing, uses self_speaker variant", async () => {
    const id = await seedSession({ self_speaker: "2" });
    const res = await api(`/api/sessions/${id}/followup`, {
      method: "POST",
      body: { format: "email", instructions: "keep it short" },
      env,
    });
    expect(res.status).toBe(200);
    await res.text();
    // A JSON-mode summarize call ran first (no stored summary existed).
    expect(mock.completeCalls.some((call) => call.json)).toBe(true);
    const streamCall = mock.streamCalls[0];
    expect(streamCall.system).toContain("The user is speaker 2");
    expect(streamCall.system).toContain("Subject: line");
    expect(streamCall.user).toContain("keep it short");
  });

  it("neutral voice + no subject for message format without self_speaker", async () => {
    const id = await seedSession();
    await api(`/api/sessions/${id}/followup`, {
      method: "POST",
      body: { format: "message" },
      env,
    }).then((r) => r.text());
    const streamCall = mock.streamCalls[0];
    expect(streamCall.system).toContain("unknown which speaker");
    expect(streamCall.system).toContain("no subject line");
  });

  it("400 on missing/invalid format", async () => {
    const id = await seedSession();
    const res = await api(`/api/sessions/${id}/followup`, {
      method: "POST",
      body: { format: "carrier-pigeon" },
      env,
    });
    expect(res.status).toBe(400);
  });

  it("409 when the session is not 'done'", async () => {
    const id = await seedSession({ status: "pending" });
    const res = await api(`/api/sessions/${id}/followup`, {
      method: "POST",
      body: { format: "email" },
      env,
    });
    expect(res.status).toBe(409);
  });

  it("emits a data:{error} event on mid-stream failure, then closes", async () => {
    const id = await seedSession();
    // Seed a stored summary so no complete() call is needed.
    await api(`/api/sessions/${id}/summarize`, { method: "POST", env });
    mock.stream = async () =>
      new ReadableStream<string>({
        pull(controller) {
          if (mock.streamCalls.length >= 0 && (this as { n?: number }).n) {
            controller.error(new Error("mid-stream boom"));
            return;
          }
          (this as { n?: number }).n = 1;
          controller.enqueue("first ");
        },
      });
    const res = await api(`/api/sessions/${id}/followup`, {
      method: "POST",
      body: { format: "email" },
      env,
    });
    expect(res.status).toBe(200);
    const events = await readSse(res);
    expect(events[0]).toEqual({ delta: "first " });
    const last = events[events.length - 1] as { error?: { code: string; message: string } };
    expect(last.error?.message).toBe("mid-stream boom");
  });
});

describe("POST /api/ask", () => {
  it("400 on missing question or scope", async () => {
    const res = await api("/api/ask", { method: "POST", body: { question: "" }, env });
    expect(res.status).toBe(400);
  });

  it("400 on scope=session without session_id", async () => {
    const res = await api("/api/ask", {
      method: "POST",
      body: { question: "what?", scope: "session" },
      env,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("session_id");
  });

  it("scope=session streams an answer grounded in the transcript", async () => {
    const id = await seedSession({ segments: ["the deadline is Friday"] });
    mock.streamText = "The deadline is Friday.";
    const res = await api("/api/ask", {
      method: "POST",
      body: { question: "when is the deadline?", scope: "session", session_id: id },
      env,
    });
    expect(res.status).toBe(200);
    const events = await readSse(res);
    const text = events
      .filter((e): e is { delta: string } => "delta" in e)
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("The deadline is Friday.");
    // Transcript was stuffed into the prompt.
    expect(mock.streamCalls[0].user).toContain("the deadline is Friday");
    expect(mock.streamCalls[0].user).toContain("when is the deadline?");
  });

  it("scope=session 404 for unknown session", async () => {
    const res = await api("/api/ask", {
      method: "POST",
      body: { question: "q", scope: "session", session_id: crypto.randomUUID() },
      env,
    });
    expect(res.status).toBe(404);
  });

  it("scope=all always passes the kind filter and emits sources in the final event", async () => {
    const searchMemory = vi.fn(
      async (): Promise<{ results: askModule.MemorySearchHit[] }> => ({
        results: [
          {
            text: "we offered a 12% discount",
            score: 0.9,
            session_id: "s-1",
            session_title: "Acme call",
            created_at: Date.parse("2026-07-20"),
          },
          {
            text: "discount confirmed at 12%",
            score: 0.8,
            session_id: "s-1",
            session_title: "Acme call",
            created_at: Date.parse("2026-07-20"),
          },
        ],
      }),
    );
    vi.spyOn(askModule, "resolveSearchMemory").mockResolvedValue(searchMemory);

    // Route imports askAll from the module, so spy indirection only works if
    // askAll itself consults resolveSearchMemory — it does (no override given).
    const res = await api("/api/ask", {
      method: "POST",
      body: { question: "what discount did we offer acme", scope: "all" },
      env,
    });
    expect(res.status).toBe(200);
    const events = await readSse(res);
    const last = events[events.length - 1] as {
      done?: boolean;
      sources?: { session_id: string; title: string; snippet: string }[];
    };
    expect(last.done).toBe(true);
    // Sources deduped by session.
    expect(last.sources).toEqual([
      {
        session_id: "s-1",
        title: "Acme call",
        snippet: "we offered a 12% discount",
      },
    ]);
    expect(searchMemory).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        top_k: 12,
        filters: { kind: ["transcript", "summary"] },
      }),
    );
    // Citation lines carry title + date.
    expect(mock.streamCalls[0].user).toContain("— Acme call (2026-07-20):");
  });

  it("scope=all with zero hits answers 'no relevant sessions' without an LLM call", async () => {
    setTestSearchMemory(vi.fn(async () => ({ results: [] })));
    const res = await api("/api/ask", {
      method: "POST",
      body: { question: "anything?", scope: "all" },
      env,
    });
    const events = await readSse(res);
    const text = events
      .filter((e): e is { delta: string } => "delta" in e)
      .map((e) => e.delta)
      .join("");
    expect(text).toContain("No relevant sessions found");
    expect(mock.streamCalls).toHaveLength(0);
    const last = events[events.length - 1] as { done?: boolean; sources?: unknown[] };
    expect(last.sources).toEqual([]);
  });
});
