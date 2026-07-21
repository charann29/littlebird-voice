import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApiError,
  apiFetch,
  getApiToken,
  onApiTokenChange,
  setApiToken,
} from "./api";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token storage", () => {
  it("persists and clears the token in localStorage", () => {
    expect(getApiToken()).toBeNull();
    setApiToken("tok-1");
    expect(getApiToken()).toBe("tok-1");
    expect(localStorage.getItem("lb.apiToken")).toBe("tok-1");
    setApiToken(null);
    expect(getApiToken()).toBeNull();
  });

  it("notifies subscribers on set/change/clear and supports unsubscribe", () => {
    const seen: (string | null)[] = [];
    const off = onApiTokenChange((t) => seen.push(t));
    setApiToken("a");
    setApiToken("b");
    setApiToken(null);
    off();
    setApiToken("c");
    expect(seen).toEqual(["a", "b", null]);
  });
});

describe("apiFetch", () => {
  it("prefixes /api and attaches the bearer header when a token is set", async () => {
    setApiToken("tok-xyz");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await apiFetch("/sessions");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/sessions");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer tok-xyz",
    );
  });

  it("omits the Authorization header when no token is set", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/health");
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("sets Content-Type for JSON bodies", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/sessions/x", {
      method: "PUT",
      body: JSON.stringify({ title: "t" }),
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it("parses JSON on 2xx and returns undefined for 204", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sessions: [] }), { status: 200 }),
    );
    await expect(apiFetch("/sessions")).resolves.toEqual({ sessions: [] });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiFetch("/auth/check")).resolves.toBeUndefined();
  });

  it("normalizes the canonical error schema into ApiError", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "unauthorized", message: "Missing token" },
        }),
        { status: 401 },
      ),
    );

    const err = await apiFetch("/sessions").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(401);
    expect(apiErr.code).toBe("unauthorized");
    expect(apiErr.message).toBe("Missing token");
  });

  it("falls back to a generic ApiError for non-JSON error bodies", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 502 }));
    const err = (await apiFetch("/x").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("unknown");
  });
});
