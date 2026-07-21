import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  displayStream,
  installMediaDevices,
  installMediaGlobals,
  micStream,
} from "../test/mediaMocks";

vi.mock("../hooks/useRecordings", () => ({
  useRecordings: () => ({ addFromBlob: vi.fn(async () => ({}) as never) }),
}));
// Fake the live Soniox path (WebSocket SDK) — stays idle.
vi.mock("../hooks/useSoniox", () => ({
  useSoniox: () => ({
    recordState: "idle",
    isRecording: false,
    isConnecting: false,
    interimText: "",
    micError: "",
    toggleRecording: vi.fn(),
    cancelRecording: vi.fn(),
  }),
}));

import { MeetingCapture } from "./MeetingCapture";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0";

function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

beforeEach(() => {
  installMediaGlobals();
});

describe("MeetingCapture", () => {
  it("renders the three source cards with mockup copy on desktop Chrome", () => {
    setUserAgent(CHROME_MAC);
    installMediaDevices({
      getUserMedia: async () => micStream(),
      getDisplayMedia: async () => displayStream(),
    });
    render(<MeetingCapture />);

    expect(screen.getByTestId("source-card-mic-only")).toBeEnabled();
    expect(screen.getByTestId("source-card-tab-mic")).toBeEnabled();
    expect(screen.getByTestId("source-card-screen-mic")).toBeEnabled();

    expect(screen.getByText("Works offline")).toBeInTheDocument();
    expect(screen.getByText("Best for calls")).toBeInTheDocument();
    expect(screen.getByText("See note below")).toBeInTheDocument();
    // Amber system-audio caveat from the approved mockup.
    expect(screen.getByTestId("system-audio-caveat")).toHaveTextContent(
      /system-audio capture depends on your OS and browser/,
    );
    // Tab + Mic pre-selected on supporting browsers.
    expect(screen.getByTestId("source-card-tab-mic")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("disables mixed modes with an explanation on unsupported browsers (Firefox)", () => {
    setUserAgent(FIREFOX);
    installMediaDevices({ getUserMedia: async () => micStream() });
    render(<MeetingCapture />);

    expect(screen.getByTestId("source-card-mic-only")).toBeEnabled();
    expect(screen.getByTestId("source-card-tab-mic")).toBeDisabled();
    expect(screen.getByTestId("source-card-screen-mic")).toBeDisabled();
    expect(
      screen.getAllByText(/needs desktop Chrome or Edge/).length,
    ).toBeGreaterThanOrEqual(2);
    // Mic-only becomes the default selection.
    expect(screen.getByTestId("source-card-mic-only")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("starting with a zero-audio-track share shows the warning banner in the live view", async () => {
    setUserAgent(CHROME_MAC);
    installMediaDevices({
      getUserMedia: async () => micStream(),
      getDisplayMedia: async () => displayStream(false), // no audio ticked
    });
    render(<MeetingCapture />);

    fireEvent.click(screen.getByTestId("start-capture-button"));

    await waitFor(() =>
      expect(screen.getByTestId("capture-warning")).toHaveTextContent(
        /No tab audio shared — only your mic is being captured/,
      ),
    );
    // Live view: header, timer, stop button, mic channel meter, transcript.
    expect(screen.getByTestId("capture-live-header")).toBeInTheDocument();
    expect(screen.getByTestId("capture-timer")).toHaveTextContent("00:00");
    expect(screen.getByTestId("stop-and-summarize-button")).toHaveTextContent(
      "Stop & summarize",
    );
    expect(screen.getByTestId("mixer-mic-channel")).toBeInTheDocument();
    expect(screen.getByTestId("streaming-transcript")).toBeInTheDocument();
  });

  it("mic permission denied surfaces the error and stays on the picker", async () => {
    setUserAgent(CHROME_MAC);
    installMediaDevices({
      getUserMedia: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
      getDisplayMedia: async () => displayStream(),
    });
    render(<MeetingCapture />);

    fireEvent.click(screen.getByTestId("start-capture-button"));

    await waitFor(() =>
      expect(screen.getByTestId("capture-error")).toHaveTextContent(
        /Microphone access denied/,
      ),
    );
    expect(screen.getByTestId("source-cards")).toBeInTheDocument();
  });

  it("live view shows both channel meters and source pills for Tab + Mic", async () => {
    setUserAgent(CHROME_MAC);
    installMediaDevices({
      getUserMedia: async () => micStream(),
      getDisplayMedia: async () => displayStream(),
    });
    render(<MeetingCapture />);

    fireEvent.click(screen.getByTestId("start-capture-button"));

    await waitFor(() =>
      expect(screen.getByTestId("capture-mixer")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("mixer-display-channel")).toHaveTextContent(
      "Tab audio",
    );
    expect(screen.getByTestId("mixer-mic-channel")).toHaveTextContent(
      "Your mic",
    );
    // Source pills in the live header.
    expect(screen.getByTestId("capture-live-header")).toHaveTextContent("Mic");
  });
});
