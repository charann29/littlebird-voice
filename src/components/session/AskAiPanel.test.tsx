import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AskAiPanel } from "./AskAiPanel";

const fetchMock = vi.fn<typeof fetch>();

function delayedSseResponse(signal: AbortSignal | null): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(
        new Response(
          'data: {"delta":"Security rollout details"}\n\n' +
            'data: {"done":true,"sources":[]}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    }, 0);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation((_input, init) =>
    delayedSseResponse(init?.signal ?? null),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AskAiPanel", () => {
  it("completes a palette handoff during the StrictMode effect replay", async () => {
    render(
      <StrictMode>
        <MemoryRouter>
          <AskAiPanel scope="all" initialQuestion="Acme security rollout" />
        </MemoryRouter>
      </StrictMode>,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Security rollout details")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Ask AI" }), {
      target: { value: "Can I ask again?" },
    });
    expect(screen.getByRole("button", { name: "Ask" })).not.toBeDisabled();
  });
});
