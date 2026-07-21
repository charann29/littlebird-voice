/**
 * littlebird-voice Worker — Hono app serving /api/* plus the built PWA
 * (static assets binding, single-page-application fallback).
 *
 * Route pattern: one file per feature in src/routes/*.ts, each exporting a
 * Hono sub-app mounted here (section 20 mounts routes/ai.ts the same way).
 */

import { Hono } from "hono";
import type { Env } from "./env";
import { authMiddleware, type AuthVariables } from "./auth";
import { errorBody } from "./errors";
import { aiRoutes } from "./routes/ai";
import { memoryRoutes } from "./routes/memory";
import { sessionsRoutes } from "./routes/sessions";
import { sonioxRoutes } from "./routes/soniox";
import {
  integrationsCallbackRoutes,
  integrationsRoutes,
} from "./integrations/routes";
import { autoCreateCalendarSessions } from "./integrations/calendarSync";
import { queueHandler } from "./queue/consumer";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Unauthenticated liveness probe.
app.get("/api/health", (c) => c.json({ ok: true }));

// OAuth callbacks are browser navigations without an Authorization header —
// they MUST be mounted before the auth middleware. Identity comes from the
// signed, single-use state row, never from the request (section 40).
app.route("/api", integrationsCallbackRoutes);

// Everything else under /api requires the shared bearer token.
app.use("/api/*", authMiddleware);

// Authenticated no-op — the Settings UI validates a pasted token against it.
app.get("/api/auth/check", (c) => c.body(null, 204));

app.route("/api", sessionsRoutes);
app.route("/api", sonioxRoutes);
app.route("/api", aiRoutes);
app.route("/api", memoryRoutes);
app.route("/api", integrationsRoutes);

// Canonical error schema for anything a route didn't handle.
app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json(errorBody("not_found", "No such API route"), 404);
  }
  // Non-/api paths fall through to static assets (SPA fallback).
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    errorBody("internal_error", err instanceof Error ? err.message : "Internal error"),
    500,
  );
});

export default {
  fetch: app.fetch,

  // THE single queue dispatcher (section 30): routes IngestMessages to
  // memory ingestion and to section 20's auto-summary handler; failed
  // messages retry per wrangler.jsonc (max_retries 3 → littlebird-ingest-dlq).
  queue: queueHandler,

  // Calendar auto-create cron (section 40, decisions.md #4): pre-creates
  // sessions for upcoming events, deduped via calendar_event_sessions.
  // No-op when no google-calendar connection / secrets exist (local dev).
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      autoCreateCalendarSessions(env).then((r) => {
        console.log(
          `calendar auto-create: users=${r.usersProcessed} events=${r.eventsSeen} created=${r.sessionsCreated} errors=${r.errors}`,
        );
      }),
    );
  },
} satisfies ExportedHandler<Env>;
