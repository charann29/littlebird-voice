/**
 * Soniox integration:
 *  - POST /auth/soniox-token — mints a short-lived single-use realtime key so
 *    the browser can stream to wss://stt-rt.soniox.com WITHOUT ever seeing the
 *    permanent key.
 *  - /stt/* — an ALLOW-LISTED relay for the async transcription flow
 *    (upload → create → poll → transcript → cleanup). It strips the client's
 *    app-token header, injects `Authorization: Bearer ${SONIOX_API_KEY}`, and
 *    streams the upstream response back verbatim. It is NOT a generic proxy —
 *    exactly the five paths below are reachable.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import type { AuthVariables } from "../auth";
import { errorResponse } from "../errors";

type App = { Bindings: Env; Variables: AuthVariables };

const SONIOX_API_BASE = "https://api.soniox.com";

/** Temp realtime keys live this long; a live session refreshes per start. */
const TEMP_KEY_TTL_SECONDS = 300;

/** Relay a request to api.soniox.com/v1/<path>, injecting the API key. */
async function relay(
  c: { req: { raw: Request }; env: Env },
  method: string,
  upstreamPath: string,
): Promise<Response> {
  const url = new URL(c.req.raw.url);
  const upstream = new URL(`${SONIOX_API_BASE}${upstreamPath}`);
  upstream.search = url.search;

  const headers = new Headers(c.req.raw.headers);
  headers.set("Authorization", `Bearer ${c.env.SONIOX_API_KEY}`);
  headers.delete("Host");
  headers.delete("Cookie");

  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";
  const res = await fetch(upstream.toString(), {
    method,
    headers,
    body: hasBody ? c.req.raw.body : undefined,
  });

  // Stream the upstream response through, preserving status + body.
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export const sonioxRoutes = new Hono<App>()

  // POST /auth/soniox-token — { api_key, expires_at }
  .post("/auth/soniox-token", async (c) => {
    let upstream: Response;
    try {
      upstream = await fetch(`${SONIOX_API_BASE}/v1/auth/temporary-api-key`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.SONIOX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          usage_type: "transcribe_websocket",
          expires_in_seconds: TEMP_KEY_TTL_SECONDS,
          single_use: true,
        }),
      });
    } catch (err) {
      return errorResponse(
        c,
        502,
        "upstream_error",
        `Soniox temp-key request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      return errorResponse(
        c,
        502,
        "upstream_error",
        `Soniox temp-key mint failed (HTTP ${upstream.status})${detail ? ` — ${detail}` : ""}`,
      );
    }
    const data = (await upstream.json()) as {
      api_key?: string;
      expires_at?: string;
    };
    if (!data.api_key) {
      return errorResponse(
        c,
        502,
        "upstream_error",
        "Soniox temp-key response missing api_key",
      );
    }
    return c.json({ api_key: data.api_key, expires_at: data.expires_at });
  })

  // Allow-listed async-flow relay (exactly these five endpoints):
  .post("/stt/files", (c) => relay(c, "POST", "/v1/files"))
  .post("/stt/transcriptions", (c) => relay(c, "POST", "/v1/transcriptions"))
  .get("/stt/transcriptions/:id", (c) =>
    relay(c, "GET", `/v1/transcriptions/${encodeURIComponent(c.req.param("id"))}`),
  )
  .get("/stt/transcriptions/:id/transcript", (c) =>
    relay(
      c,
      "GET",
      `/v1/transcriptions/${encodeURIComponent(c.req.param("id"))}/transcript`,
    ),
  )
  .delete("/stt/transcriptions/:id", (c) =>
    relay(c, "DELETE", `/v1/transcriptions/${encodeURIComponent(c.req.param("id"))}`),
  )
  .delete("/stt/files/:id", (c) =>
    relay(c, "DELETE", `/v1/files/${encodeURIComponent(c.req.param("id"))}`),
  );
