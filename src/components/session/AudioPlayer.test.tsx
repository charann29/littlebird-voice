/**
 * AudioPlayer tests (50-T3): objectURL create/revoke lifecycle (created on
 * mount, revoked on unmount and on blob change).
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPlayer } from "./AudioPlayer";

describe("AudioPlayer objectURL lifecycle", () => {
  let createSpy: ReturnType<typeof vi.fn>;
  let revokeSpy: ReturnType<typeof vi.fn>;
  let counter: number;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  beforeEach(() => {
    counter = 0;
    createSpy = vi.fn(() => `blob:mock-${++counter}`);
    revokeSpy = vi.fn();
    URL.createObjectURL = createSpy as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeSpy as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("creates a URL on mount and revokes it on unmount", () => {
    const blob = new Blob(["audio"]);
    const { unmount } = render(<AudioPlayer blob={blob} durationMs={1000} />);
    expect(createSpy).toHaveBeenCalledWith(blob);
    expect(revokeSpy).not.toHaveBeenCalled();

    unmount();
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock-1");
  });

  it("revokes the old URL and creates a new one when the blob changes", () => {
    const first = new Blob(["a"]);
    const second = new Blob(["b"]);
    const { rerender } = render(
      <AudioPlayer blob={first} durationMs={1000} />,
    );
    expect(createSpy).toHaveBeenCalledTimes(1);

    rerender(<AudioPlayer blob={second} durationMs={1000} />);
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock-1");
    expect(createSpy).toHaveBeenCalledWith(second);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});
