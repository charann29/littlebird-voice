import { createExecutionContext, waitOnExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import type { IngestMessage } from "../src/services/ingest-message";

export const TEST_TOKEN = "test-app-token";

/** Queue stub that records every published IngestMessage. */
export function recordingQueue(): {
  queue: Queue<IngestMessage>;
  sent: IngestMessage[];
} {
  const sent: IngestMessage[] = [];
  const queue = {
    async send(message: IngestMessage) {
      sent.push(message);
    },
    async sendBatch(batch: Iterable<MessageSendRequest<IngestMessage>>) {
      for (const m of batch) sent.push(m.body);
    },
  } as unknown as Queue<IngestMessage>;
  return { queue, sent };
}

/** Test Env backed by the real (isolated) D1 + a recording queue stub. */
export function testEnv(): { env: Env; sent: IngestMessage[] } {
  const { queue, sent } = recordingQueue();
  return {
    env: { ...env, INGEST_QUEUE: queue } as Env,
    sent,
  };
}

export interface FetchOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  env?: Env;
}

/** Drive the full worker fetch handler against the test env. */
export async function api(
  path: string,
  opts: FetchOptions = {},
): Promise<Response> {
  const { method = "GET", body, token = TEST_TOKEN } = opts;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let requestBody: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }
  const request = new Request(`https://example.com${path}`, {
    method,
    headers,
    body: requestBody,
  });
  const ctx = createExecutionContext();
  const useEnv = opts.env ?? testEnv().env;
  const response = await worker.fetch(request, useEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Minimal valid PUT /api/sessions/:id body. */
export function sessionBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Date.now();
  return {
    title: "Test session",
    source: "mic",
    status: "pending",
    created_at: now,
    updated_at: now,
    duration_ms: 1234,
    mime_type: "audio/webm;codecs=opus",
    blob_size: 4096,
    ...overrides,
  };
}
