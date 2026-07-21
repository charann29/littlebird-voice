/**
 * AI feature routes (section 20):
 *   POST /api/sessions/:id/summarize   — generate/regenerate (202+enqueue for long)
 *   GET  /api/sessions/:id/summary     — read stored meeting summary
 *   POST /api/sessions/:id/followup    — SSE-streamed draft (ephemeral)
 *   POST /api/ask                      — SSE-streamed answer (scope session|all)
 *
 * Error bodies use the canonical `{ error: { code, message } }` schema. AI
 * error codes used here beyond section 10's set: transcript_not_ready (409),
 * no_summary (404), ai_bad_output (502), ai_unavailable (503).
 */

import { Hono } from "hono";
import type { Env } from "../env";
import type { AuthVariables } from "../auth";
import { askAll, askSession } from "../ai/ask";
import { streamFollowup, type FollowupFormat } from "../ai/followup";
import { AiError } from "../ai/provider";
import { sseResponse } from "../ai/stream";
import {
  estimateChunkCount,
  generateSummary,
  loadOwnedSession,
  loadSegments,
  loadStoredSummary,
  SessionNotFoundError,
  TranscriptNotReadyError,
} from "../ai";

type App = { Bindings: Env; Variables: AuthVariables };

/** Chunk-count threshold above which summarize responds 202 and enqueues. */
const QUEUE_CHUNK_THRESHOLD = 3;

interface AiErrorShape {
  error: { code: string; message: string };
}

function aiErrorBody(code: string, message: string): AiErrorShape {
  return { error: { code, message } };
}

/** Map section-20 domain errors to canonical JSON responses (or null). */
function mapAiError(err: unknown): Response | null {
  if (err instanceof SessionNotFoundError) {
    return Response.json(aiErrorBody("not_found", err.message), { status: 404 });
  }
  if (err instanceof TranscriptNotReadyError) {
    return Response.json(aiErrorBody("transcript_not_ready", err.message), {
      status: 409,
    });
  }
  if (err instanceof AiError) {
    return Response.json(aiErrorBody(err.code, err.message), {
      status: err.code === "ai_bad_output" ? 502 : 503,
    });
  }
  return null;
}

async function readJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const aiRoutes = new Hono<App>()

  // POST /sessions/:id/summarize — generate (or regenerate) the summary.
  // Short transcripts run synchronously (200 {summary}); when the estimated
  // map-reduce chunk count exceeds the threshold we enqueue a forced
  // summarize message and respond 202 {status:"queued"} — the UI polls
  // GET .../summary.
  .post("/sessions/:id/summarize", async (c) => {
    const id = c.req.param("id");
    try {
      const session = await loadOwnedSession(c.env, c.var.userId, id);
      if (!session) throw new SessionNotFoundError(id);
      if (session.status !== "done") {
        throw new TranscriptNotReadyError(
          `Session status is '${session.status}', not 'done'`,
        );
      }
      const segments = await loadSegments(c.env, id);
      if (segments.length === 0) {
        throw new TranscriptNotReadyError("Session has no transcript segments");
      }

      if (estimateChunkCount(segments) > QUEUE_CHUNK_THRESHOLD) {
        await c.env.INGEST_QUEUE.send({
          userId: c.var.userId,
          kind: "transcript",
          parentId: id,
          sourceRevision: session.transcript_revision,
          jobs: ["summarize"],
          forceSummary: true,
          requestId: crypto.randomUUID(),
          // forceSummary is section 20's regeneration flag (see
          // SummarizeQueueMessage in ../ai/summarize.ts).
        } as never);
        return c.json({ status: "queued" }, 202);
      }

      const summary = await generateSummary(c.env, c.var.userId, id, {
        requestId: crypto.randomUUID(),
      });
      return c.json({ summary });
    } catch (err) {
      const mapped = mapAiError(err);
      if (mapped) return mapped;
      throw err;
    }
  })

  // GET /sessions/:id/summary — stored meeting summary or 404 no_summary.
  .get("/sessions/:id/summary", async (c) => {
    const id = c.req.param("id");
    const session = await loadOwnedSession(c.env, c.var.userId, id);
    if (!session) {
      return c.json(aiErrorBody("not_found", `Session ${id} not found`), 404);
    }
    const stored = await loadStoredSummary(c.env, id);
    if (!stored) {
      return c.json(
        aiErrorBody("no_summary", "No summary generated for this session yet"),
        404,
      );
    }
    return c.json({ summary: stored.payload, generated_at: stored.generated_at });
  })

  // POST /sessions/:id/followup — SSE-streamed ephemeral draft.
  .post("/sessions/:id/followup", async (c) => {
    const id = c.req.param("id");
    const body = (await readJson(c)) ?? {};
    const format = body.format;
    if (format !== "email" && format !== "message") {
      return c.json(
        aiErrorBody("bad_request", 'Body must be { format: "email" | "message", instructions? }'),
        400,
      );
    }
    const instructions =
      typeof body.instructions === "string" ? body.instructions : undefined;
    try {
      const deltas = await streamFollowup(c.env, c.var.userId, id, {
        format: format as FollowupFormat,
        instructions,
      });
      return sseResponse(deltas);
    } catch (err) {
      const mapped = mapAiError(err);
      if (mapped) return mapped;
      throw err;
    }
  })

  // POST /ask — SSE-streamed answer over one session or all sessions.
  .post("/ask", async (c) => {
    const body = (await readJson(c)) ?? {};
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const scope = body.scope;
    if (!question || (scope !== "session" && scope !== "all")) {
      return c.json(
        aiErrorBody(
          "bad_request",
          'Body must be { question: string, scope: "session" | "all", session_id? }',
        ),
        400,
      );
    }
    if (scope === "session" && typeof body.session_id !== "string") {
      return c.json(
        aiErrorBody("bad_request", "session_id is required when scope is 'session'"),
        400,
      );
    }
    try {
      const result =
        scope === "session"
          ? await askSession(c.env, c.var.userId, body.session_id as string, question)
          : await askAll(c.env, c.var.userId, question);
      return sseResponse(result.deltas, {
        doneExtra: result.sources !== undefined ? { sources: result.sources } : undefined,
      });
    } catch (err) {
      const mapped = mapAiError(err);
      if (mapped) return mapped;
      throw err;
    }
  });
