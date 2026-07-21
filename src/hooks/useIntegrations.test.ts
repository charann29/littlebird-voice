/**
 * useIntegrations tests: list fetch/normalization, offline/no-token
 * unavailable state, connect navigation, disconnect refresh, connect
 * failure mapping to a per-provider action error.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  };
});

import { ApiError, setApiToken } from "../lib/api";
import {
  defaultProviders,
  normalizeProviders,
  useIntegrations,
} from "./useIntegrations";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(MemoryRouter, null, children);

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  setApiToken("tok");
  setOnline(true);
  apiFetchMock.mockReset();
});

describe("normalizeProviders", () => {
  it("always yields all four providers in canonical order", () => {
    const out = normalizeProviders([
      { provider: "notion", connected: true, status: "active" },
    ]);
    expect(out.map((p) => p.provider)).toEqual([
      "google-calendar",
      "gmail",
      "slack",
      "notion",
    ]);
    expect(out[3].connected).toBe(true);
    expect(out[0].connected).toBe(false);
  });
});

describe("useIntegrations", () => {
  it("loads and normalizes the provider list", async () => {
    apiFetchMock.mockResolvedValue({
      providers: [
        { provider: "slack", connected: true, status: "active", displayName: "W" },
      ],
    });
    const { result } = renderHook(() => useIntegrations(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.providers).toHaveLength(4);
    expect(
      result.current.providers.find((p) => p.provider === "slack")?.connected,
    ).toBe(true);
  });

  it("is unavailable offline without issuing a request", () => {
    setOnline(false);
    const { result } = renderHook(() => useIntegrations(), { wrapper });
    expect(result.current.status).toBe("unavailable");
    expect(result.current.offline).toBe(true);
    expect(result.current.providers).toEqual(defaultProviders());
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable without a token", () => {
    setApiToken(null);
    const { result } = renderHook(() => useIntegrations(), { wrapper });
    expect(result.current.status).toBe("unavailable");
    expect(result.current.offline).toBe(true);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("connect() navigates to the returned authorizeUrl", async () => {
    const assignMock = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign: assignMock,
    } as unknown as Location);
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/integrations") return { providers: [] };
      return { authorizeUrl: "https://accounts.google.com/consent" };
    });
    const { result } = renderHook(() => useIntegrations(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(() => result.current.connect("google-calendar"));
    expect(assignMock).toHaveBeenCalledWith(
      "https://accounts.google.com/consent",
    );
    // Busy flag stays set while the page navigates away.
    expect(result.current.busy["google-calendar"]).toBe("connect");
  });

  it("connect() failure lands in actionError, not a throw", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/integrations") return { providers: [] };
      throw new ApiError(502, "provider_error", "google says no");
    });
    const { result } = renderHook(() => useIntegrations(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(() => result.current.connect("gmail"));
    expect(result.current.actionError.gmail).toBe("google says no");
    expect(result.current.busy.gmail).toBeNull();
  });

  it("disconnect() DELETEs then refreshes", async () => {
    const calls: string[] = [];
    apiFetchMock.mockImplementation(
      async (path: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (init?.method === "DELETE") return { ok: true };
        return { providers: [] };
      },
    );
    const { result } = renderHook(() => useIntegrations(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(() => result.current.disconnect("notion"));
    expect(calls).toContain("DELETE /integrations/notion");
    // one initial list + one post-disconnect refresh
    expect(calls.filter((c) => c === "GET /integrations")).toHaveLength(2);
  });

  it("captures ?connected= and dismisses", async () => {
    apiFetchMock.mockResolvedValue({ providers: [] });
    const withParams = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        { initialEntries: ["/settings/connections?connected=slack"] },
        children,
      );
    const { result } = renderHook(() => useIntegrations(), {
      wrapper: withParams,
    });
    expect(result.current.oauthReturn).toEqual({
      kind: "connected",
      value: "slack",
    });
    act(() => result.current.dismissOauthReturn());
    expect(result.current.oauthReturn).toBeNull();
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });
});
