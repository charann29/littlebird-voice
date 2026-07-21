/**
 * TranscriptPane tests (50-T3): segment-source precedence, plain-text
 * export, copy, empty states per status, highlight scroll.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../../types";
import type { Segment } from "../../lib/api-types";
import {
  resolveSegments,
  segmentsToPlainText,
  TranscriptPane,
} from "./TranscriptPane";

function recording(over: Partial<Recording> = {}): Recording {
  return {
    id: "r1",
    createdAt: Date.now(),
    durationMs: 60_000,
    mimeType: "audio/webm",
    blobSize: 10,
    blob: new Blob(["x"]),
    status: "done",
    transcript: null,
    error: null,
    sonioxFileId: null,
    sonioxTranscriptionId: null,
    segments: null,
    syncState: "local",
    ...over,
  };
}

const serverSegments: Segment[] = [
  {
    seq: 0,
    speaker: "1",
    start_ms: 0,
    end_ms: 4000,
    text: "server segment",
  } as Segment,
];

describe("resolveSegments precedence", () => {
  it("prefers local Recording.segments", () => {
    const local = recording({
      segments: [{ speaker: "2", start_ms: 100, end_ms: 900, text: "local seg" }],
      transcript: "plain text",
    });
    const out = resolveSegments(local, serverSegments);
    expect(out).toEqual([{ speaker: "2", start_ms: 100, text: "local seg" }]);
  });

  it("falls back to server segments when local has none", () => {
    const out = resolveSegments(recording({ transcript: "plain" }), serverSegments);
    expect(out).toEqual([{ speaker: "1", start_ms: 0, text: "server segment" }]);
  });

  it("falls back to a single unlabelled block from local transcript", () => {
    const out = resolveSegments(recording({ transcript: "just text" }), null);
    expect(out).toEqual([{ speaker: null, start_ms: null, text: "just text" }]);
  });

  it("returns null when nothing is available", () => {
    expect(resolveSegments(recording(), null)).toBeNull();
    expect(resolveSegments(null, null)).toBeNull();
    expect(resolveSegments(null, [])).toBeNull();
  });
});

describe("segmentsToPlainText", () => {
  it("produces Speaker N: text lines, plain text for unlabelled blocks", () => {
    expect(
      segmentsToPlainText([
        { speaker: "1", start_ms: 0, text: "hello" },
        { speaker: null, start_ms: null, text: "no speaker" },
      ]),
    ).toBe("Speaker 1: hello\nno speaker");
  });
});

describe("TranscriptPane", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("copies the speaker-labelled plain text", async () => {
    const user = userEvent.setup(); // installs a clipboard stub
    render(
      <TranscriptPane
        segments={[
          { speaker: "1", start_ms: 0, text: "alpha" },
          { speaker: "2", start_ms: 5000, text: "beta" },
        ]}
        status="done"
      />,
    );
    await user.click(screen.getByRole("button", { name: /Copy transcript/ }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeInTheDocument());
    await expect(navigator.clipboard.readText()).resolves.toBe(
      "Speaker 1: alpha\nSpeaker 2: beta",
    );
  });

  it("shows status empty states", () => {
    const { rerender } = render(
      <TranscriptPane segments={null} status="transcribing" />,
    );
    expect(screen.getByText("Transcribing…")).toBeInTheDocument();

    rerender(<TranscriptPane segments={null} status="pending" />);
    expect(
      screen.getByText("Pending — will transcribe when online."),
    ).toBeInTheDocument();

    const onRetry = vi.fn();
    rerender(
      <TranscriptPane
        segments={null}
        status="error"
        error="boom"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("error state Retry calls onRetry", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <TranscriptPane segments={null} status="error" onRetry={onRetry} />,
    );
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("scrolls the highlighted segment into view (nearest at-or-before start_ms)", () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    render(
      <TranscriptPane
        segments={[
          { speaker: "1", start_ms: 0, text: "first" },
          { speaker: "1", start_ms: 10_000, text: "second" },
          { speaker: "2", start_ms: 20_000, text: "third" },
        ]}
        status="done"
        highlight={{ start_ms: 12_500 }}
      />,
    );
    expect(scrollSpy).toHaveBeenCalledWith({ block: "center" });
    // The flash styling lands on the matched (second) segment's paragraph.
    expect(screen.getByText("second").className).toContain("border-indigo-500/30");
    expect(screen.getByText("first").className).not.toContain(
      "border-indigo-500/30",
    );
  });
});
