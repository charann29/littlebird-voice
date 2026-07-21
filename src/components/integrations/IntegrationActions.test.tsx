/**
 * IntegrationActions tests: Gmail send (fixed body + validation + success/
 * error paths incl. not_connected linking to Connections), Slack channel
 * picker + post (provider_error surfaced verbatim, e.g. not_in_channel),
 * Notion export database picker + create, Notion import search/select/import,
 * Calendar upcoming events list, offline-disabled triggers, and the
 * SummaryV1 flatteners.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  };
});

import { ApiError } from "../../lib/api";
import type { SummaryV1 } from "../../lib/ai-types";
import {
  CalendarUpcomingEvents,
  GmailSendControl,
  NotionExportControl,
  NotionImportControl,
  SlackPostControl,
  summaryToNotionExport,
} from "./IntegrationActions";
import { summaryToSlackText } from "../session/SummaryPanel";

function renderIn(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

beforeEach(() => {
  setOnline(true);
  apiFetchMock.mockReset();
});

describe("GmailSendControl", () => {
  it("sends the fixed body with parsed recipients and shows success", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValue({ messageId: "m1" });
    renderIn(
      <GmailSendControl body="Hello there" sessionId="sess-1" defaultOpen />,
    );

    await user.type(
      screen.getByLabelText("Recipients"),
      "a@x.com, b@y.com",
    );
    await user.type(screen.getByLabelText("Subject"), "Follow-up");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("Email sent");
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe("/integrations/gmail/send");
    expect(JSON.parse(init.body)).toEqual({
      to: ["a@x.com", "b@y.com"],
      subject: "Follow-up",
      bodyText: "Hello there",
      sessionId: "sess-1",
    });
  });

  it("keeps Send disabled until recipients + subject are set", async () => {
    const user = userEvent.setup();
    renderIn(<GmailSendControl body="Body" defaultOpen />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(screen.getByLabelText("Recipients"), "a@x.com");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(screen.getByLabelText("Subject"), "Hi");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("maps not_connected to a message linking to Connections", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockRejectedValue(
      new ApiError(404, "not_connected", "gmail is not connected"),
    );
    renderIn(<GmailSendControl body="Body" defaultOpen />);
    await user.type(screen.getByLabelText("Recipients"), "a@x.com");
    await user.type(screen.getByLabelText("Subject"), "Hi");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Not connected — connect this provider/);
    expect(
      within(alert).getByRole("link", { name: "Open Connections" }),
    ).toHaveAttribute("href", "/settings/connections");
  });

  it("renders a body textarea when no body prop is given", () => {
    renderIn(<GmailSendControl defaultOpen />);
    expect(screen.getByLabelText("Message body")).toBeInTheDocument();
  });

  it("is a disabled trigger while offline", () => {
    setOnline(false);
    renderIn(<GmailSendControl body="Body" />);
    expect(
      screen.getByRole("button", { name: /Send via Gmail/ }),
    ).toBeDisabled();
  });
});

describe("SlackPostControl", () => {
  it("loads channels, posts to the chosen one, and shows success", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/integrations/slack/channels") {
        return {
          channels: [
            { id: "C1", name: "general" },
            { id: "C2", name: "meetings" },
          ],
        };
      }
      return { ok: true, ts: "123.456" };
    });
    renderIn(<SlackPostControl text="Summary text" defaultOpen />);

    const select = await screen.findByLabelText("Slack channel");
    await user.selectOptions(select, "C2");
    await user.click(screen.getByRole("button", { name: "Post" }));

    await screen.findByText(/Posted to #meetings/);
    const sendCall = apiFetchMock.mock.calls.find(
      ([p]) => p === "/integrations/slack/send",
    );
    expect(JSON.parse(sendCall?.[1]?.body as string)).toEqual({
      channelId: "C2",
      text: "Summary text",
    });
  });

  it("surfaces provider errors verbatim (not_in_channel)", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/integrations/slack/channels") {
        return { channels: [{ id: "C1", name: "private-stuff" }] };
      }
      throw new ApiError(502, "provider_error", "not_in_channel");
    });
    renderIn(<SlackPostControl text="hi" defaultOpen />);

    await screen.findByLabelText("Slack channel");
    await user.click(screen.getByRole("button", { name: "Post" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "not_in_channel",
    );
  });

  it("shows the reconnect message when the channel list 409s", async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError(409, "reconnect_required", "refresh failed"),
    );
    renderIn(<SlackPostControl text="hi" defaultOpen />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Access expired — reconnect/,
    );
  });
});

describe("NotionExportControl", () => {
  it("loads databases and creates a page", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/integrations/notion/databases") {
        return { databases: [{ id: "db1", title: "Meetings" }] };
      }
      return { pageId: "p1", url: "https://notion.so/p1" };
    });
    renderIn(
      <NotionExportControl
        summary="Overview text"
        actionItems={["Do the thing"]}
        defaultTitle="Standup"
        sessionId="sess-2"
        defaultOpen
      />,
    );

    await screen.findByLabelText("Notion database");
    await user.click(screen.getByRole("button", { name: "Export" }));

    await screen.findByText(/Page created/);
    expect(
      screen.getByRole("link", { name: "open in Notion" }),
    ).toHaveAttribute("href", "https://notion.so/p1");
    const exportCall = apiFetchMock.mock.calls.find(
      ([p]) => p === "/integrations/notion/export",
    );
    expect(JSON.parse(exportCall?.[1]?.body as string)).toEqual({
      databaseId: "db1",
      title: "Standup",
      summary: "Overview text",
      actionItems: ["Do the thing"],
      sessionId: "sess-2",
    });
  });

  it("shows an empty-state note when no databases are shared", async () => {
    apiFetchMock.mockResolvedValue({ databases: [] });
    renderIn(<NotionExportControl summary="s" defaultOpen />);
    expect(
      await screen.findByText(/No databases shared with the integration/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  });
});

describe("NotionImportControl", () => {
  it("searches, selects, imports, and reports the count", async () => {
    const user = userEvent.setup();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/integrations/notion/pages")) {
        return {
          pages: [
            { id: "pg1", title: "Design doc" },
            { id: "pg2", title: "Roadmap" },
          ],
        };
      }
      return {
        imported: [
          { pageId: "pg1", documentId: "d1" },
          { pageId: "pg2", documentId: "d2" },
        ],
      };
    });
    renderIn(<NotionImportControl defaultOpen />);

    await user.type(screen.getByLabelText("Search Notion pages"), "doc");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.click(await screen.findByText("Design doc"));
    await user.click(screen.getByText("Roadmap"));
    await user.click(screen.getByRole("button", { name: "Import (2)" }));

    await screen.findByText(/Imported 2 pages/);
    const importCall = apiFetchMock.mock.calls.find(
      ([p]) => p === "/integrations/notion/import",
    );
    expect(JSON.parse(importCall?.[1]?.body as string)).toEqual({
      pageIds: ["pg1", "pg2"],
    });
    // Query is URL-encoded into the search path.
    expect(
      apiFetchMock.mock.calls.some(
        ([p]) => p === "/integrations/notion/pages?query=doc",
      ),
    ).toBe(true);
  });

  it("Import stays disabled with nothing selected", async () => {
    apiFetchMock.mockResolvedValue({ pages: [] });
    renderIn(<NotionImportControl defaultOpen />);
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });
});

describe("CalendarUpcomingEvents", () => {
  it("lists normalized events with a Meet link", async () => {
    apiFetchMock.mockResolvedValue({
      events: [
        {
          id: "e1",
          title: "Design review",
          startsAt: "2026-07-22T10:00:00Z",
          endsAt: "2026-07-22T11:00:00Z",
          attendees: [{ email: "a@x.com" }, { email: "b@y.com" }],
          meetLink: "https://meet.google.com/abc",
          htmlLink: "https://calendar.google.com/event?id=e1",
        },
      ],
    });
    renderIn(<CalendarUpcomingEvents />);

    await screen.findByText("Design review");
    expect(screen.getByText(/2 attendees/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Join" })).toHaveAttribute(
      "href",
      "https://meet.google.com/abc",
    );
    expect(apiFetchMock.mock.calls[0][0]).toBe(
      "/integrations/google-calendar/events?days=7",
    );
  });

  it("shows an empty note when there are no events", async () => {
    apiFetchMock.mockResolvedValue({ events: [] });
    renderIn(<CalendarUpcomingEvents />);
    expect(
      await screen.findByText(/No events in the next 7 days/),
    ).toBeInTheDocument();
  });

  it("degrades to an offline note without requesting", () => {
    setOnline(false);
    renderIn(<CalendarUpcomingEvents />);
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe("summary flatteners", () => {
  const summary: SummaryV1 = {
    version: 1,
    model: "m",
    source_revision: 1,
    request_id: null,
    overview: "We met.",
    action_items: [
      { text: "Ship it", owner: "Ana", due: "Friday" },
      { text: "Write docs", owner: null, due: null },
    ],
    decisions: ["Use D1"],
    key_quotes: [],
    risks_open_questions: ["Latency unknown"],
  };

  it("summaryToNotionExport splits summary text and action items", () => {
    const out = summaryToNotionExport(summary);
    expect(out.summary).toContain("We met.");
    expect(out.summary).toContain("Decisions:\n• Use D1");
    expect(out.summary).toContain("Risks & open questions:\n• Latency unknown");
    expect(out.actionItems).toEqual([
      "Ship it (Ana) — due Friday",
      "Write docs",
    ]);
  });

  it("summaryToSlackText flattens to a single message", () => {
    const text = summaryToSlackText(summary);
    expect(text).toContain("We met.");
    expect(text).toContain("• Ship it (Ana) — due Friday");
    expect(text).toContain("Decisions:\n• Use D1");
  });
});
