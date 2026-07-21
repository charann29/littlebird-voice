/**
 * SessionDetailTabs tests (50-T3): tablist keyboard semantics (arrow roving,
 * Home/End, aria-selected), initialTab handoff (palette's followups state).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetailTabs } from "./SessionDetailTabs";

describe("SessionDetailTabs", () => {
  beforeEach(() => {
    // jsdom lacks scrollIntoView (AskAiPanel keeps the newest answer in view).
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders the three tabs with correct aria wiring", () => {
    render(<SessionDetailTabs sessionId="s1" />);
    const tablist = screen.getByRole("tablist", { name: "AI features" });
    const tabs = screen.getAllByRole("tab");
    expect(tablist).toBeInTheDocument();
    expect(tabs.map((t) => t.textContent)).toEqual([
      "AI Summary",
      "Follow-ups",
      "Ask",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
    // Only the active panel is visible.
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "panel-summary");
  });

  it("moves with ArrowRight/ArrowLeft (wrapping) and Home/End", async () => {
    const user = userEvent.setup();
    render(<SessionDetailTabs sessionId="s1" />);
    const [summary, followups, ask] = screen.getAllByRole("tab");

    summary.focus();
    await user.keyboard("{ArrowRight}");
    expect(followups).toHaveAttribute("aria-selected", "true");
    expect(followups).toHaveFocus();

    await user.keyboard("{ArrowLeft}{ArrowLeft}"); // summary → wraps to ask
    expect(ask).toHaveAttribute("aria-selected", "true");
    expect(ask).toHaveFocus();

    await user.keyboard("{ArrowRight}"); // wraps back to summary
    expect(summary).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(ask).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(summary).toHaveAttribute("aria-selected", "true");
  });

  it("clicking a tab switches the visible panel", async () => {
    const user = userEvent.setup();
    render(<SessionDetailTabs sessionId="s1" />);
    await user.click(screen.getByRole("tab", { name: "Ask" }));
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "panel-ask");
  });

  it("honors initialTab (palette followups handoff)", () => {
    render(<SessionDetailTabs sessionId="s1" initialTab="followups" />);
    expect(screen.getByRole("tab", { name: "Follow-ups" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "id",
      "panel-followups",
    );
  });
});
