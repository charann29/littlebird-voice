import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "../../test/helpers";

/**
 * The relay + temp-key routes call the global `fetch` for upstream Soniox
 * requests. Tests run in the same isolate as the worker code, so stubbing
 * globalThis.fetch intercepts exactly those upstream calls (requests to the
 * worker itself go through worker.fetch directly, not global fetch).
 */
type FetchArgs = { url: string; init: RequestInit & { headers: Headers } };

let upstreamCalls: FetchArgs[];
let upstreamResponder: (args: FetchArgs) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  upstreamCalls = [];
  upstreamResponder = () => {
    throw new Error("unexpected upstream fetch");
  };
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const args: FetchArgs = { url, init: { ...init, headers } };
      upstreamCalls.push(args);
      return upstreamResponder(args);
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

describe("POST /api/auth/soniox-token", () => {
  it("requires the app token", async () => {
    const res = await api("/api/auth/soniox-token", {
      method: "POST",
      token: null,
    });
    expect(res.status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("mints a temp key via Soniox and returns { api_key, expires_at }", async () => {
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe("https://api.soniox.com/v1/auth/temporary-api-key");
      expect(init.headers.get("Authorization")).toBe("Bearer test-soniox-key");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        usage_type: "transcribe_websocket",
        expires_in_seconds: 300,
        single_use: true,
      });
      return Response.json({
        api_key: "temp-key-123",
        expires_at: "2026-07-21T00:05:00Z",
      });
    };

    const res = await api("/api/auth/soniox-token", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      api_key: "temp-key-123",
      expires_at: "2026-07-21T00:05:00Z",
    });
    expect(upstreamCalls).toHaveLength(1);
  });

  it("maps a Soniox failure to 502 with the canonical error schema", async () => {
    upstreamResponder = () => new Response("forbidden", { status: 403 });

    const res = await api("/api/auth/soniox-token", { method: "POST" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toContain("403");
  });

  it("maps a network failure to 502", async () => {
    upstreamResponder = () => {
      throw new TypeError("Network connection lost");
    };
    const res = await api("/api/auth/soniox-token", { method: "POST" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_error");
  });
});

describe("/api/stt/* relay", () => {
  it("relays POST /api/stt/transcriptions preserving body/status and injecting the key", async () => {
    let upstreamBody = "";
    upstreamResponder = async ({ url, init }) => {
      expect(url).toBe("https://api.soniox.com/v1/transcriptions");
      expect(init.method).toBe("POST");
      expect(init.headers.get("Authorization")).toBe("Bearer test-soniox-key");
      upstreamBody = await new Response(
        init.body as ReadableStream,
      ).text();
      return Response.json({ id: "tx-1" }, { status: 201 });
    };

    const res = await api("/api/stt/transcriptions", {
      method: "POST",
      body: { model: "stt-async-v5", file_id: "f-1", language_hints: ["en"] },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "tx-1" });
    expect(JSON.parse(upstreamBody)).toMatchObject({ file_id: "f-1" });
  });

  it("relays GET poll + transcript with path params and preserves query", async () => {
    upstreamResponder = ({ url }) => {
      if (url === "https://api.soniox.com/v1/transcriptions/tx-9") {
        return Response.json({ status: "completed" });
      }
      if (
        url === "https://api.soniox.com/v1/transcriptions/tx-9/transcript"
      ) {
        return Response.json({ text: "hi", tokens: [] });
      }
      throw new Error(`unexpected upstream url: ${url}`);
    };

    const poll = await api("/api/stt/transcriptions/tx-9");
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual({ status: "completed" });

    const tr = await api("/api/stt/transcriptions/tx-9/transcript");
    expect(await tr.json()).toEqual({ text: "hi", tokens: [] });
  });

  it("relays DELETE cleanup endpoints", async () => {
    const urls: string[] = [];
    upstreamResponder = ({ url, init }) => {
      expect(init.method).toBe("DELETE");
      urls.push(url);
      return new Response(null, { status: 204 });
    };

    const delTx = await api("/api/stt/transcriptions/tx-2", {
      method: "DELETE",
    });
    expect(delTx.status).toBe(204);
    const delFile = await api("/api/stt/files/f-2", { method: "DELETE" });
    expect(delFile.status).toBe(204);
    expect(urls).toEqual([
      "https://api.soniox.com/v1/transcriptions/tx-2",
      "https://api.soniox.com/v1/files/f-2",
    ]);
  });

  it("passes upstream error statuses through", async () => {
    upstreamResponder = () =>
      Response.json(
        { error_type: "not_found", error_message: "no such job" },
        { status: 404 },
      );
    const res = await api("/api/stt/transcriptions/missing");
    expect(res.status).toBe(404);
  });

  it("does not leak the client's app token upstream", async () => {
    upstreamResponder = ({ init }) => {
      expect(init.headers.get("Authorization")).toBe("Bearer test-soniox-key");
      return Response.json({ status: "queued" });
    };
    const res = await api("/api/stt/transcriptions/tx-3");
    expect(res.status).toBe(200);
  });

  it("rejects non-allow-listed paths with 404 (no upstream call)", async () => {
    const paths: [string, string][] = [
      ["GET", "/api/stt/files"], // listing not allow-listed
      ["POST", "/api/stt/anything"],
      ["GET", "/api/stt/models"],
      ["PUT", "/api/stt/transcriptions/tx-1"],
    ];
    for (const [method, path] of paths) {
      const res = await api(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_found");
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  it("requires the app token on relay routes", async () => {
    const res = await api("/api/stt/transcriptions/tx-1", { token: null });
    expect(res.status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });
});
