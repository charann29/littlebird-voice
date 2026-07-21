/**
 * Sessions CRUD + transcript + summaries endpoints.
 *
 * Session metadata CRUD uses prepared statements directly; transcript and
 * summary WRITES go through the persistence services (never inline SQL for
 * those tables) so revision bumps + INGEST_QUEUE publishing happen in exactly
 * one place.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import type { AuthVariables } from "../auth";
import { errorResponse } from "../errors";
import {
  PersistenceError,
  saveSummary,
  saveTranscript,
  type SegmentInput,
} from "../services/persistence";
import { deleteMemoryFor } from "../memory/ingest";

type App = { Bindings: Env; Variables: AuthVariables };

const VALID_SOURCES = new Set(["mic", "tab", "screen"]);
const VALID_STATUSES = new Set(["pending", "transcribing", "done", "error"]);

interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  source: string;
  status: string;
  created_at: number;
  updated_at: number;
  duration_ms: number;
  mime_type: string | null;
  blob_size: number | null;
  self_speaker: string | null;
  transcript_revision: number;
  error: string | null;
}

const SESSION_COLUMNS =
  "id, user_id, title, source, status, created_at, updated_at, duration_ms, mime_type, blob_size, self_speaker, transcript_revision, error";

/** Fields the client may set via PUT/PATCH (user_id/revision are server-owned). */
const WRITABLE_FIELDS = [
  "title",
  "source",
  "status",
  "created_at",
  "updated_at",
  "duration_ms",
  "mime_type",
  "blob_size",
  "self_speaker",
  "error",
] as const;
type WritableField = (typeof WRITABLE_FIELDS)[number];

function validateFields(
  body: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  if (body.source !== undefined && !VALID_SOURCES.has(body.source as string)) {
    return { ok: false, message: `Invalid source: ${String(body.source)}` };
  }
  if (body.status !== undefined && !VALID_STATUSES.has(body.status as string)) {
    return { ok: false, message: `Invalid status: ${String(body.status)}` };
  }
  return { ok: true };
}

async function getOwnedSession(
  env: Env,
  userId: string,
  id: string,
): Promise<SessionRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ? AND user_id = ?`,
  )
    .bind(id, userId)
    .first<SessionRow>();
  return row ?? null;
}

async function readJson(
  c: { req: { json: () => Promise<unknown> } },
): Promise<Record<string, unknown> | null> {
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

export const sessionsRoutes = new Hono<App>()

  // GET /sessions?limit=50&before=<created_at> — metadata list, no segments.
  .get("/sessions", async (c) => {
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200)
      : 50;
    const beforeRaw = c.req.query("before");
    const before = beforeRaw !== undefined ? Number(beforeRaw) : undefined;
    if (before !== undefined && !Number.isFinite(before)) {
      return errorResponse(c, 400, "bad_request", "Invalid 'before' cursor");
    }

    const stmt =
      before !== undefined
        ? c.env.DB.prepare(
            `SELECT ${SESSION_COLUMNS} FROM sessions
             WHERE user_id = ? AND created_at < ?
             ORDER BY created_at DESC LIMIT ?`,
          ).bind(c.var.userId, before, limit)
        : c.env.DB.prepare(
            `SELECT ${SESSION_COLUMNS} FROM sessions
             WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
          ).bind(c.var.userId, limit);

    const { results } = await stmt.all<SessionRow>();
    return c.json({ sessions: results });
  })

  // PUT /sessions/:id — idempotent upsert keyed on the client UUID.
  .put("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const body = await readJson(c);
    if (!body) {
      return errorResponse(c, 400, "bad_request", "Invalid JSON body");
    }
    const valid = validateFields(body);
    if (!valid.ok) return errorResponse(c, 400, "bad_request", valid.message);
    for (const field of ["created_at", "updated_at"] as const) {
      if (typeof body[field] !== "number") {
        return errorResponse(
          c,
          400,
          "bad_request",
          `Missing or invalid '${field}' (epoch ms number required)`,
        );
      }
    }

    const existing = await c.env.DB.prepare(
      "SELECT user_id FROM sessions WHERE id = ?",
    )
      .bind(id)
      .first<{ user_id: string }>();
    if (existing && existing.user_id !== c.var.userId) {
      // Same as not owning it — do not leak existence.
      return errorResponse(c, 404, "not_found", `Session ${id} not found`);
    }
    const created = !existing;

    await c.env.DB.prepare(
      `INSERT INTO sessions (id, user_id, title, source, status, created_at, updated_at,
                             duration_ms, mime_type, blob_size, self_speaker, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title,
         source = excluded.source,
         status = excluded.status,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         duration_ms = excluded.duration_ms,
         mime_type = excluded.mime_type,
         blob_size = excluded.blob_size,
         self_speaker = excluded.self_speaker,
         error = excluded.error`,
    )
      .bind(
        id,
        c.var.userId,
        (body.title as string) ?? "",
        (body.source as string) ?? "mic",
        (body.status as string) ?? "pending",
        body.created_at as number,
        body.updated_at as number,
        (body.duration_ms as number) ?? 0,
        (body.mime_type as string) ?? null,
        (body.blob_size as number) ?? null,
        (body.self_speaker as string) ?? null,
        (body.error as string) ?? null,
      )
      .run();

    const session = await getOwnedSession(c.env, c.var.userId, id);
    return c.json({ session }, created ? 201 : 200);
  })

  // GET /sessions/:id — session + segments + summary metadata.
  .get("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const session = await getOwnedSession(c.env, c.var.userId, id);
    if (!session) {
      return errorResponse(c, 404, "not_found", `Session ${id} not found`);
    }
    const [segments, summaries] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, session_id, seq, speaker, start_ms, end_ms, text
         FROM transcript_segments WHERE session_id = ? ORDER BY seq`,
      )
        .bind(id)
        .all(),
      c.env.DB.prepare(
        `SELECT id, kind, model, revision, created_at
         FROM summaries WHERE session_id = ? ORDER BY created_at DESC`,
      )
        .bind(id)
        .all(),
    ]);
    return c.json({
      session,
      segments: segments.results,
      summaries: summaries.results,
    });
  })

  // PATCH /sessions/:id — partial update of any PUT field.
  .patch("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const body = await readJson(c);
    if (!body) {
      return errorResponse(c, 400, "bad_request", "Invalid JSON body");
    }
    const valid = validateFields(body);
    if (!valid.ok) return errorResponse(c, 400, "bad_request", valid.message);

    const existing = await getOwnedSession(c.env, c.var.userId, id);
    if (!existing) {
      return errorResponse(c, 404, "not_found", `Session ${id} not found`);
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const field of WRITABLE_FIELDS) {
      if (field in body) {
        sets.push(`${field} = ?`);
        values.push(body[field as WritableField] ?? null);
      }
    }
    if (sets.length === 0) {
      return errorResponse(c, 400, "bad_request", "No updatable fields in body");
    }
    if (!("updated_at" in body)) {
      sets.push("updated_at = ?");
      values.push(Date.now());
    }
    await c.env.DB.prepare(
      `UPDATE sessions SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
    )
      .bind(...values, id, c.var.userId)
      .run();

    const session = await getOwnedSession(c.env, c.var.userId, id);
    return c.json({ session });
  })

  // DELETE /sessions/:id — cascades segments + summaries, and propagates to
  // memory (chunks + vectors for BOTH transcript and summary kinds).
  .delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await getOwnedSession(c.env, c.var.userId, id);
    if (!existing) {
      return errorResponse(c, 404, "not_found", `Session ${id} not found`);
    }
    await deleteMemoryFor(c.env, { session_id: id });
    await c.env.DB.prepare(
      "DELETE FROM sessions WHERE id = ? AND user_id = ?",
    )
      .bind(id, c.var.userId)
      .run();
    return c.body(null, 204);
  })

  // PUT /sessions/:id/transcript — replace all segments via saveTranscript().
  .put("/sessions/:id/transcript", async (c) => {
    const id = c.req.param("id");
    const body = await readJson(c);
    if (!body || !Array.isArray(body.segments)) {
      return errorResponse(
        c,
        400,
        "bad_request",
        "Body must be { segments: [...] }",
      );
    }
    const segments: SegmentInput[] = [];
    for (const raw of body.segments as unknown[]) {
      if (
        raw === null ||
        typeof raw !== "object" ||
        typeof (raw as { text?: unknown }).text !== "string"
      ) {
        return errorResponse(
          c,
          400,
          "bad_request",
          "Each segment requires a string 'text'",
        );
      }
      const seg = raw as SegmentInput;
      segments.push({
        speaker: seg.speaker ?? null,
        start_ms: seg.start_ms ?? null,
        end_ms: seg.end_ms ?? null,
        text: seg.text,
      });
    }
    try {
      const { count } = await saveTranscript(
        c.env,
        c.var.userId,
        id,
        segments,
      );
      return c.json({ count });
    } catch (err) {
      if (err instanceof PersistenceError) {
        return errorResponse(
          c,
          err.code === "not_found" ? 404 : 400,
          err.code,
          err.message,
        );
      }
      throw err;
    }
  })

  // GET /sessions/:id/transcript — segments + joined text.
  .get("/sessions/:id/transcript", async (c) => {
    const id = c.req.param("id");
    const session = await getOwnedSession(c.env, c.var.userId, id);
    if (!session) {
      return errorResponse(c, 404, "not_found", `Session ${id} not found`);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT id, session_id, seq, speaker, start_ms, end_ms, text
       FROM transcript_segments WHERE session_id = ? ORDER BY seq`,
    )
      .bind(id)
      .all<{ text: string }>();
    const text = results.map((s) => s.text).join(" ");
    return c.json({ segments: results, text });
  })

  // PUT /sessions/:id/summaries/:kind — upsert via saveSummary().
  .put("/sessions/:id/summaries/:kind", async (c) => {
    const id = c.req.param("id");
    const kind = c.req.param("kind");
    const body = await readJson(c);
    if (
      !body ||
      body.payload === null ||
      typeof body.payload !== "object" ||
      Array.isArray(body.payload)
    ) {
      return errorResponse(
        c,
        400,
        "bad_request",
        "Body must be { payload: object, model? }",
      );
    }
    try {
      const summary = await saveSummary(
        c.env,
        c.var.userId,
        id,
        kind,
        body.payload as object,
        typeof body.model === "string" ? body.model : undefined,
      );
      return c.json({ summary });
    } catch (err) {
      if (err instanceof PersistenceError) {
        return errorResponse(
          c,
          err.code === "not_found" ? 404 : 400,
          err.code,
          err.message,
        );
      }
      throw err;
    }
  })

  // GET /sessions/:id/summaries — full summaries incl. payloads.
  .get("/sessions/:id/summaries", async (c) => {
    const id = c.req.param("id");
    const session = await getOwnedSession(c.env, c.var.userId, id);
    if (!session) {
      return errorResponse(c, 404, "not_found", `Session ${id} not found`);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT id, kind, payload_json, model, revision, created_at
       FROM summaries WHERE session_id = ? ORDER BY created_at DESC`,
    )
      .bind(id)
      .all<{
        id: string;
        kind: string;
        payload_json: string;
        model: string | null;
        revision: number;
        created_at: number;
      }>();
    return c.json({
      summaries: results.map((r) => ({
        id: r.id,
        kind: r.kind,
        payload: JSON.parse(r.payload_json) as object,
        model: r.model,
        revision: r.revision,
        created_at: r.created_at,
      })),
    });
  });
