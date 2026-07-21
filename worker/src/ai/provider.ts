/**
 * LlmProvider seam — the ONLY place model APIs are touched. Everything above
 * (summarize/followup/ask) talks to this interface so the provider can be
 * swapped (Anthropic/OpenAI later) without touching call sites.
 *
 * Implementations:
 * - WorkersAiProvider — Cloudflare Workers AI via the native `env.AI`
 *   binding, model id from the `AI_MODEL` var (default
 *   `@cf/meta/llama-3.3-70b-instruct-fp8-fast`), never hardcoded at call
 *   sites. NOTE: under `wrangler dev` Workers AI is a REMOTE binding — it
 *   needs a logged-in Cloudflare account. This workspace has no Cloudflare
 *   credentials, so for local dev use the fake provider below.
 * - DevFakeProvider — deterministic stub gated by `DEV_FAKE_AI=1` (set in
 *   `worker/.dev.vars`) so every endpoint is exercisable locally end-to-end
 *   with zero credentials. Never enable in a deployed environment.
 *
 * Shared error/retry policy (plan "Error / retry policy"):
 * - transient model errors → retry twice with 1s/3s backoff, then
 *   AiError("ai_unavailable") → HTTP 503;
 * - JSON-mode output failing parse/validation → ONE repair retry appending
 *   JSON_REPAIR_SUFFIX, then AiError("ai_bad_output") → HTTP 502.
 */

import type { Env } from "../env";
import { JSON_REPAIR_SUFFIX } from "./prompts";

export interface CompleteRequest {
  system: string;
  user: string;
  /** JSON schema — when set the call runs in JSON mode. */
  json?: object;
  maxTokens?: number;
}

export interface StreamRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmProvider {
  /** Model id this provider runs (recorded in SummaryV1.model). */
  readonly model: string;
  complete(req: CompleteRequest): Promise<string>;
  /** Decoded text deltas (NOT raw SSE bytes). */
  stream(req: StreamRequest): Promise<ReadableStream<string>>;
}

export type AiErrorCode = "ai_unavailable" | "ai_bad_output";

export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const RETRY_DELAYS_MS = [1_000, 3_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry a transiently-failing model call (twice, 1s/3s), then 503. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delays: number[] = RETRY_DELAYS_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AiError) throw err; // already classified
      lastError = err;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  throw new AiError(
    "ai_unavailable",
    lastError instanceof Error ? lastError.message : "Model call failed",
  );
}

/**
 * JSON-mode call + parse + validate with ONE repair retry, then 502.
 * `validate` returns the normalized value or null when invalid.
 */
export async function completeJson<T>(
  provider: LlmProvider,
  req: CompleteRequest,
  validate: (parsed: unknown) => T | null,
): Promise<T> {
  const attempt = async (repair: boolean): Promise<T | null> => {
    const raw = await provider.complete(
      repair ? { ...req, user: `${req.user}\n\n${JSON_REPAIR_SUFFIX}` } : req,
    );
    try {
      return validate(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  const first = await attempt(false);
  if (first !== null) return first;
  const second = await attempt(true);
  if (second !== null) return second;
  throw new AiError("ai_bad_output", "Model returned invalid JSON after repair retry");
}

/* ------------------------------------------------------------ Workers AI */

interface WorkersAiTextResult {
  response?: string;
}

export class WorkersAiProvider implements LlmProvider {
  constructor(
    private ai: Ai,
    public readonly model: string,
  ) {}

  async complete(req: CompleteRequest): Promise<string> {
    return withRetry(async () => {
      const result = (await this.ai.run(this.model as keyof AiModels, {
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        max_tokens: req.maxTokens ?? 2_048,
        ...(req.json
          ? {
              response_format: {
                type: "json_schema",
                json_schema: req.json,
              },
            }
          : {}),
      } as never)) as WorkersAiTextResult | string;
      if (typeof result === "string") return result;
      if (typeof result?.response === "string") return result.response;
      throw new AiError("ai_bad_output", "Workers AI returned no text response");
    });
  }

  async stream(req: StreamRequest): Promise<ReadableStream<string>> {
    // Retries only apply BEFORE the first delta: the run() call itself is
    // retried; once the stream is handed out, errors surface to the caller.
    const raw = await withRetry(async () => {
      const result = (await this.ai.run(this.model as keyof AiModels, {
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        max_tokens: req.maxTokens ?? 2_048,
        stream: true,
      } as never)) as ReadableStream<Uint8Array>;
      if (!(result instanceof ReadableStream)) {
        throw new Error("Workers AI did not return a stream");
      }
      return result;
    });
    return decodeWorkersAiSse(raw);
  }
}

/**
 * Workers AI streams SSE bytes: `data: {"response":"delta"}` events ending
 * with `data: [DONE]`. Decode into plain text deltas.
 */
export function decodeWorkersAiSse(
  raw: ReadableStream<Uint8Array>,
): ReadableStream<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  return raw.pipeThrough(
    new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as WorkersAiTextResult;
            if (typeof parsed.response === "string" && parsed.response) {
              controller.enqueue(parsed.response);
            }
          } catch {
            /* partial/keepalive line — skip */
          }
        }
      },
    }),
  );
}

/* -------------------------------------------------------- dev fake stub */

/**
 * Deterministic local-dev provider (DEV_FAKE_AI=1). Produces schema-valid
 * summaries and canned streamed drafts/answers derived from the prompt, so
 * the full flow (persistence, revisions, SSE framing, UI states) can be
 * exercised without Cloudflare credentials.
 */
export class DevFakeProvider implements LlmProvider {
  readonly model = "dev-fake-ai";

  async complete(req: CompleteRequest): Promise<string> {
    if (req.json) {
      // Summarize (single or reduce step) — return a valid SummaryContent.
      const firstLine = req.user.split("\n")[0]?.slice(0, 120) ?? "";
      return JSON.stringify({
        overview: `[dev-fake-ai] Deterministic stub summary. Context: ${firstLine}`,
        action_items: [
          { text: "Stub action item from dev fake provider", owner: "1", due: null },
        ],
        decisions: ["Stub decision recorded by dev fake provider"],
        key_quotes: [{ speaker: "1", quote: "This is a stubbed verbatim quote." }],
        risks_open_questions: ["Stub open question (dev fake provider)"],
      });
    }
    // Relevance-extract map step and any other plain completion.
    return `[dev-fake-ai] ${req.user.slice(0, 200)}`;
  }

  async stream(req: StreamRequest): Promise<ReadableStream<string>> {
    const text =
      `[dev-fake-ai] Streamed stub response. ` +
      `System prompt began: "${req.system.slice(0, 60)}…". ` +
      `User prompt began: "${req.user.slice(0, 80)}…".`;
    const words = text.split(" ");
    let i = 0;
    return new ReadableStream<string>({
      pull(controller) {
        if (i >= words.length) {
          controller.close();
          return;
        }
        controller.enqueue(i === 0 ? words[i] : ` ${words[i]}`);
        i++;
      },
    });
  }
}

/* ---------------------------------------------------------------- factory */

/** Test seam: lets vitest inject a scripted provider through getProvider. */
let testProviderOverride: LlmProvider | null = null;
export function setTestProvider(provider: LlmProvider | null): void {
  testProviderOverride = provider;
}

/**
 * Factory: reads env — `DEV_FAKE_AI=1` forces the deterministic stub;
 * otherwise `AI_PROVIDER` ("workers-ai" default) + `AI_MODEL` select the
 * real provider. Missing `env.AI` (e.g. wrangler dev without a Cloudflare
 * login) also falls back to the stub when DEV_FAKE_AI is set.
 */
export function getProvider(env: Env): LlmProvider {
  if (testProviderOverride) return testProviderOverride;
  if (env.DEV_FAKE_AI === "1") return new DevFakeProvider();
  const model = env.AI_MODEL || DEFAULT_MODEL;
  if (!env.AI) {
    throw new AiError(
      "ai_unavailable",
      "Workers AI binding (env.AI) is unavailable. For local dev without " +
        "Cloudflare credentials set DEV_FAKE_AI=1 in worker/.dev.vars.",
    );
  }
  return new WorkersAiProvider(env.AI, model);
}
