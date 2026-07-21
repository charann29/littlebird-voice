/**
 * SettingsPage tests (50-T1): token save validation semantics — 204 →
 * Connected (+ outbox drain), 401 → Invalid token, network failure →
 * Server unreachable (NOT invalid), disconnect clears the token.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiFetch: (path: string) => apiFetchMock(path) };
});

const drainOutboxMock = vi.fn(async () => {});
vi.mock("../lib/sync", () => ({
  drainOutbox: () => drainOutboxMock(),
}));

import { ApiError, getApiToken, setApiToken } from "../lib/api";
import { checkToken, SettingsPage } from "./SettingsPage";

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  setApiToken(null);
  apiFetchMock.mockReset();
  drainOutboxMock.mockClear();
});

describe("checkToken", () => {
  it("returns connected on a 2xx", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined); // 204 → undefined
    await expect(checkToken()).resolves.toBe("connected");
    expect(apiFetchMock).toHaveBeenCalledWith("/auth/check");
  });

  it("returns invalid only on 401", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(401, "unauthorized", "no"));
    await expect(checkToken()).resolves.toBe("invalid");
  });

  it("returns unreachable on other ApiError statuses", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(502, "bad_gateway", "boom"));
    await expect(checkToken()).resolves.toBe("unreachable");
  });

  it("returns unreachable (never invalid) on a network error", async () => {
    apiFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(checkToken()).resolves.toBe("unreachable");
  });
});

describe("SettingsPage token card", () => {
  it("saving a valid token shows Connected and drains the outbox", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValue(undefined);
    renderPage();

    await user.type(screen.getByLabelText("API token"), "  secret-token  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByTestId("token-status")).toHaveTextContent("Connected"),
    );
    expect(getApiToken()).toBe("secret-token"); // trimmed
    expect(drainOutboxMock).toHaveBeenCalled();
  });

  it("a 401 shows Invalid token", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockRejectedValue(new ApiError(401, "unauthorized", "no"));
    renderPage();

    await user.type(screen.getByLabelText("API token"), "bad-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByTestId("token-status")).toHaveTextContent(
        "Invalid token",
      ),
    );
    expect(drainOutboxMock).not.toHaveBeenCalled();
  });

  it("a network error shows Server unreachable, not Invalid token", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderPage();

    await user.type(screen.getByLabelText("API token"), "maybe-fine-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByTestId("token-status")).toHaveTextContent(
        "Server unreachable",
      ),
    );
    expect(screen.getByTestId("token-status")).not.toHaveTextContent(
      "Invalid",
    );
  });

  it("Disconnect clears the stored token and pauses sync", async () => {
    const user = userEvent.setup();
    setApiToken("existing-token");
    apiFetchMock.mockResolvedValue(undefined);
    renderPage();

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(getApiToken()).toBeNull();
    expect(screen.getByTestId("token-status")).toHaveTextContent(
      "Disconnected — sync is paused",
    );
  });

  it("silently validates a stored token on mount", async () => {
    setApiToken("stored-token");
    apiFetchMock.mockResolvedValue(undefined);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("token-status")).toHaveTextContent("Connected"),
    );
  });
});
