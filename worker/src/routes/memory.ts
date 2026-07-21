/**
 * /api/memory/* routes (section 30) — thin wrappers over the memory services.
 *
 * POST   /memory/search         → searchMemory() (400 on empty query)
 * POST   /memory/documents      → upsert memory_documents (idempotent per
 *                                 (user_id, source, external_id)), bump
 *                                 revision, enqueue ingest → 202 {id,"queued"}
 * GET    /memory/documents/:id  → document meta incl. chunk_count
 * DELETE /memory/documents/:id  → 204; removes chunks + vectors
 * POST   /memory/reindex        → { reindexed } recovery sweep
 */

import { Hono } from "hono";
import type { Env } from "../env";
import type { AuthVariables } from "../auth";
import { errorResponse } from "../errors";
import {
  searchMemory,
  MAX_TOP_K,
  type MemoryKind,
  type MemorySearchRequest,
} from "../memory/search";
import { deleteMemoryFor, reindexMemory } from "../memory/ingest";
import { ingestMemoryDocument } from "../services/memory-document";

/** Canonical input for POST /api/memory/documents (shared with section 40).
 *  Re-exported from the internal service for existing importers. */
export type { MemoryDocumentInput } from "../services/memory-document";

type App = { Bindings: Env; Variables: AuthVariables };

const VALID_KINDS = new Set<string>(["transcript", "summary", "document"]);

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

export const memoryRoutes = new Hono<App>()

  // POST /memory/search — thin wrapper over searchMemory().
  .post("/memory/search", async (c) => {
    const body = await readJson(c);
    if (!body) {
      return errorResponse(c, 400, "bad_request", "Invalid JSON body");
    }
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      return errorResponse(c, 400, "bad_request", "Query must be a non-empty string");
    }

    const request: MemorySearchRequest = { query };
    if (body.top_k !== undefined) {
      const topK = Number(body.top_k);
      if (!Number.isFinite(topK) || topK < 1) {
        return errorResponse(c, 400, "bad_request", "top_k must be a positive number");
      }
      request.top_k = Math.min(Math.trunc(topK), MAX_TOP_K);
    }
    if (body.filters !== undefined) {
      if (body.filters === null || typeof body.filters !== "object") {
        return errorResponse(c, 400, "bad_request", "filters must be an object");
      }
      const raw = body.filters as Record<string, unknown>;
      const filters: MemorySearchRequest["filters"] = {};
      if (raw.kind !== undefined) {
        if (
          !Array.isArray(raw.kind) ||
          raw.kind.some((k) => typeof k !== "string" || !VALID_KINDS.has(k))
        ) {
          return errorResponse(
            c,
            400,
            "bad_request",
            "filters.kind must be an array of transcript|summary|document",
          );
        }
        filters.kind = raw.kind as MemoryKind[];
      }
      if (raw.session_id !== undefined) {
        if (typeof raw.session_id !== "string") {
          return errorResponse(c, 400, "bad_request", "filters.session_id must be a string");
        }
        filters.session_id = raw.session_id;
      }
      for (const key of ["date_from", "date_to"] as const) {
        if (raw[key] !== undefined) {
          if (typeof raw[key] !== "string" || !Number.isFinite(Date.parse(raw[key]))) {
            return errorResponse(c, 400, "bad_request", `filters.${key} must be an ISO date string`);
          }
          filters[key] = raw[key];
        }
      }
      request.filters = filters;
    }

    const response = await searchMemory(c.env, c.var.userId, request);
    return c.json(response);
  })

  // POST /memory/documents — idempotent upsert + async ingest (202).
  .post("/memory/documents", async (c) => {
    const body = await readJson(c);
    if (!body) {
      return errorResponse(c, 400, "bad_request", "Invalid JSON body");
    }
    for (const field of ["title", "source", "text"] as const) {
      if (typeof body[field] !== "string" || !(body[field] as string).trim()) {
        return errorResponse(
          c,
          400,
          "bad_request",
          `Missing or invalid '${field}' (non-empty string required)`,
        );
      }
    }
    const externalId =
      typeof body.external_id === "string" && body.external_id.trim()
        ? body.external_id
        : null;
    if (body.metadata !== undefined && (body.metadata === null || typeof body.metadata !== "object")) {
      return errorResponse(c, 400, "bad_request", "metadata must be an object");
    }
    // Upsert + enqueue live in the internal service (shared with section
    // 40's Notion import — the plan's "internal document-ingest service").
    const row = await ingestMemoryDocument(c.env, c.var.userId, {
      title: body.title as string,
      source: body.source as string,
      text: body.text as string,
      ...(externalId !== null ? { external_id: externalId } : {}),
      ...(body.metadata ? { metadata: body.metadata as object } : {}),
    });

    return c.json({ id: row.id, status: "queued" }, 202);
  })

  // GET /memory/documents/:id — meta incl. chunk_count (0 while queued).
  .get("/memory/documents/:id", async (c) => {
    const id = c.req.param("id");
    const row = await c.env.DB.prepare(
      `SELECT id, title, source, external_id, metadata_json, chunk_count, created_at, updated_at
       FROM memory_documents WHERE id = ? AND user_id = ?`,
    )
      .bind(id, c.var.userId)
      .first<{
        id: string;
        title: string;
        source: string;
        external_id: string | null;
        metadata_json: string | null;
        chunk_count: number;
        created_at: number;
        updated_at: number;
      }>();
    if (!row) {
      return errorResponse(c, 404, "not_found", `Document ${id} not found`);
    }
    return c.json({
      id: row.id,
      title: row.title,
      source: row.source,
      ...(row.external_id !== null ? { external_id: row.external_id } : {}),
      ...(row.metadata_json !== null
        ? { metadata: JSON.parse(row.metadata_json) as object }
        : {}),
      chunk_count: row.chunk_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  })

  // DELETE /memory/documents/:id — removes chunks + vectors, then the row.
  .delete("/memory/documents/:id", async (c) => {
    const id = c.req.param("id");
    const row = await c.env.DB.prepare(
      "SELECT id FROM memory_documents WHERE id = ? AND user_id = ?",
    )
      .bind(id, c.var.userId)
      .first<{ id: string }>();
    if (!row) {
      return errorResponse(c, 404, "not_found", `Document ${id} not found`);
    }
    await deleteMemoryFor(c.env, { document_id: id });
    await c.env.DB.prepare("DELETE FROM memory_documents WHERE id = ?")
      .bind(id)
      .run();
    return c.body(null, 204);
  })

  // POST /memory/reindex — recovery sweep ({session_id?} or empty = all).
  .post("/memory/reindex", async (c) => {
    let sessionId: string | undefined;
    try {
      const body = (await c.req.json()) as { session_id?: unknown };
      if (body && typeof body === "object" && typeof body.session_id === "string") {
        sessionId = body.session_id;
      }
    } catch {
      /* empty body = full sweep */
    }
    const result = await reindexMemory(c.env, c.var.userId, sessionId);
    return c.json(result);
  });
