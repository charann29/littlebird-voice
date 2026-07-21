import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../env";
import { SINGLE_USER_ID } from "../auth";
import { upsertConnection } from "./store";
import { autoCreateCalendarSessions } from "./calendarSync";
import type { TokenSet } from "./types";

const testEnv = env as unknown as Env;

const realFetch = globalThis.fetch;
let calendarItems: unknown[];
let upstreamStatus: number;

beforeEach(async () => {
  calendarItems = [];
  upstreamStatus = 200;
  // Storage is shared within a test file — reset the tables this suite touches.
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM sessions"),
    testEnv.DB.prepare("DELETE FROM calendar_event_sessions"),
    testEnv.DB.prepare("DELETE FROM integration_connections"),
  ]);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.startsWith("https://www.googleapis.com/calendar/")) {
      if (upstreamStatus !== 200) {
        return new Response("err", { status: upstreamStatus });
      }
      return Response.json({ items: calendarItems });
    }
    throw new Error(`unexpected upstream fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

function tokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "cal-access",
    refreshToken: "cal-refresh",
    expiresAt: Date.now() + 3600_000,
    tokenType: "Bearer",
    scopes: "calendar",
    externalAccountId: "sub",
    displayName: "user@example.com",
    ...overrides,
  };
}

function event(id: string, title = "Weekly sync"): unknown {
  return {
    id,
    summary: title,
    start: { dateTime: new Date(Date.now() + 3600_000).toISOString() },
    end: { dateTime: new Date(Date.now() + 7200_000).toISOString() },
    htmlLink: `https://calendar.google.com/${id}`,
  };
}

async function sessionRows(): Promise<
  { id: string; title: string; source: string; status: string }[]
> {
  const { results } = await testEnv.DB.prepare(
    "SELECT id, title, source, status FROM sessions WHERE user_id = ? ORDER BY created_at",
  )
    .bind(SINGLE_USER_ID)
    .all<{ id: string; title: string; source: string; status: string }>();
  return results;
}

describe("autoCreateCalendarSessions", () => {
  it("is a no-op with no connections (local dev safe)", async () => {
    const result = await autoCreateCalendarSessions(testEnv);
    expect(result).toEqual({
      usersProcessed: 0,
      eventsSeen: 0,
      sessionsCreated: 0,
      errors: 0,
    });
  });

  it("creates one pending 'tab' session per upcoming event", async () => {
    await upsertConnection(testEnv, SINGLE_USER_ID, "google-calendar", tokens());
    calendarItems = [event("evt-1", "Standup"), event("evt-2", "1:1")];
    const result = await autoCreateCalendarSessions(testEnv);
    expect(result.sessionsCreated).toBe(2);

    const rows = await sessionRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source).toBe("tab");
      expect(row.status).toBe("pending");
    }
    expect(rows.map((r) => r.title).sort()).toEqual(["1:1", "Standup"]);

    // Ledger rows exist for both events.
    const ledger = await testEnv.DB.prepare(
      "SELECT event_id FROM calendar_event_sessions WHERE user_id = ? ORDER BY event_id",
    )
      .bind(SINGLE_USER_ID)
      .all<{ event_id: string }>();
    expect(ledger.results.map((r) => r.event_id)).toEqual(["evt-1", "evt-2"]);
  });

  it("dedups: a second run creates nothing for already-seen events", async () => {
    await upsertConnection(testEnv, SINGLE_USER_ID, "google-calendar", tokens());
    calendarItems = [event("evt-1")];
    const first = await autoCreateCalendarSessions(testEnv);
    expect(first.sessionsCreated).toBe(1);
    const second = await autoCreateCalendarSessions(testEnv);
    expect(second.sessionsCreated).toBe(0);
    expect(await sessionRows()).toHaveLength(1);
  });

  it("does NOT resurrect a session the user deleted (ledger survives)", async () => {
    await upsertConnection(testEnv, SINGLE_USER_ID, "google-calendar", tokens());
    calendarItems = [event("evt-1")];
    await autoCreateCalendarSessions(testEnv);
    const [row] = await sessionRows();
    await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?")
      .bind(row.id)
      .run();

    const again = await autoCreateCalendarSessions(testEnv);
    expect(again.sessionsCreated).toBe(0);
    expect(await sessionRows()).toHaveLength(0);
  });

  it("picks up NEW events on later runs while skipping old ones", async () => {
    await upsertConnection(testEnv, SINGLE_USER_ID, "google-calendar", tokens());
    calendarItems = [event("evt-1")];
    await autoCreateCalendarSessions(testEnv);
    calendarItems = [event("evt-1"), event("evt-3", "New meeting")];
    const result = await autoCreateCalendarSessions(testEnv);
    expect(result.sessionsCreated).toBe(1);
    const rows = await sessionRows();
    expect(rows.map((r) => r.title)).toContain("New meeting");
    expect(rows).toHaveLength(2);
  });

  it("counts provider failures as errors without creating sessions or throwing", async () => {
    await upsertConnection(testEnv, SINGLE_USER_ID, "google-calendar", tokens());
    upstreamStatus = 500;
    const result = await autoCreateCalendarSessions(testEnv);
    expect(result.errors).toBe(1);
    expect(result.sessionsCreated).toBe(0);
    expect(await sessionRows()).toHaveLength(0);
  });

  it("skips connections in error status", async () => {
    await upsertConnection(testEnv, SINGLE_USER_ID, "google-calendar", tokens());
    await testEnv.DB.prepare(
      "UPDATE integration_connections SET status = 'error' WHERE user_id = ?",
    )
      .bind(SINGLE_USER_ID)
      .run();
    calendarItems = [event("evt-1")];
    const result = await autoCreateCalendarSessions(testEnv);
    expect(result.usersProcessed).toBe(0);
    expect(await sessionRows()).toHaveLength(0);
  });
});
