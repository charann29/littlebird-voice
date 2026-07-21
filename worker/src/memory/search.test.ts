import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ingestMemory } from "./ingest";
import { searchMemory, toFtsQuery } from "./search";
import type { IngestMessage } from "../services/ingest-message";
import {
  RecordingIndex,
  RecordingProvider,
  SINGLE_USER_ID,
  seedSegments,
  seedSession,
} from "../../test/memory-helpers";

const OTHER_USER = "00000000-0000-4000-8000-000000000002";

function ingestMsg(
  parentId: string,
  overrides: Partial<IngestMessage> = {},
): IngestMessage {
  return {
    userId: SINGLE_USER_ID,
    kind: "transcript",
    parentId,
    sourceRevision: 1,
    ...overrides,
  };
}

describe("searchMemory", () => {
  let deps: { provider: RecordingProvider; index: RecordingIndex };

  beforeEach(() => {
    deps = { provider: new RecordingProvider(), index: new RecordingIndex() };
  });

  async function seedAndIngest(
    text: string,
    opts: { title?: string; createdAt?: number; userId?: string } = {},
  ): Promise<string> {
    const sessionId = crypto.randomUUID();
    await seedSession(sessionId, opts);
    await seedSegments(sessionId, [{ speaker: "1", text }]);
    await ingestMemory(
      env,
      ingestMsg(sessionId, { userId: opts.userId ?? SINGLE_USER_ID }),
      deps,
    );
    return sessionId;
  }

  it("returns hybrid results with hydrated session_title + created_at", async () => {
    const createdAt = Date.parse("2026-06-01T10:00:00Z");
    const sessionId = await seedAndIngest(
      "we agreed to migrate the billing service to the new gateway",
      { title: "Billing sync", createdAt },
    );

    const res = await searchMemory(env, SINGLE_USER_ID, { query: "billing gateway migration" }, deps);
    expect(res.results.length).toBeGreaterThan(0);
    const hit = res.results.find((r) => r.session_id === sessionId);
    expect(hit).toBeDefined();
    expect(hit?.session_title).toBe("Billing sync");
    expect(hit?.created_at).toBe(createdAt);
    expect(hit?.kind).toBe("transcript");
    expect(hit?.text).toContain("billing");
    // Every session-backed result carries citation data.
    for (const r of res.results) {
      if (r.session_id) {
        expect(r.session_title).toBeDefined();
        expect(typeof r.created_at).toBe("number");
      }
    }
  });

  it("top result has display_score 1.0; ordering matches raw score; others in (0,1]", async () => {
    await seedAndIngest("kubernetes cluster autoscaling discussion");
    await seedAndIngest("random chatter about lunch options downtown");
    await seedAndIngest("kubernetes deployment rollout strategy");

    const res = await searchMemory(env, SINGLE_USER_ID, { query: "kubernetes rollout" }, deps);
    expect(res.results.length).toBeGreaterThan(1);
    expect(res.results[0].display_score).toBe(1.0);
    for (let i = 0; i < res.results.length; i++) {
      const r = res.results[i];
      expect(r.display_score).toBeGreaterThan(0);
      expect(r.display_score).toBeLessThanOrEqual(1);
      if (i > 0) {
        expect(r.score).toBeLessThanOrEqual(res.results[i - 1].score);
        expect(r.display_score).toBeLessThanOrEqual(res.results[i - 1].display_score);
      }
    }
  });

  it("keyword-only rare term (ID string) surfaces via FTS in the fused list", async () => {
    const sessionId = await seedAndIngest("the incident ticket is INC0042317 filed yesterday");
    // Bury it among unrelated content.
    await seedAndIngest("marketing plan review for the summer campaign");

    const res = await searchMemory(env, SINGLE_USER_ID, { query: "INC0042317" }, deps);
    const hit = res.results.find((r) => r.session_id === sessionId);
    expect(hit).toBeDefined();
    expect(hit?.text).toContain("INC0042317");
  });

  it("a chunk hit by both queries outranks single-source hits (RRF sum) and keeps source vector", async () => {
    // "quarterly forecast" chunk: shares tokens with the query (vector hit via
    // hash embedding) AND matches keywords.
    const both = await seedAndIngest("quarterly forecast numbers look strong for expansion");
    await seedAndIngest("completely unrelated gardening discussion about tulips");

    const res = await searchMemory(env, SINGLE_USER_ID, { query: "quarterly forecast" }, deps);
    expect(res.results[0].session_id).toBe(both);
    expect(res.results[0].source).toBe("vector"); // dual hit keeps 'vector'
    expect(res.results[0].vector_score).toBeDefined();
  });

  it("user A never sees user B's chunks", async () => {
    const bSession = await seedAndIngest("secret roadmap of user B", {
      userId: OTHER_USER,
    });
    const res = await searchMemory(env, SINGLE_USER_ID, { query: "secret roadmap" }, deps);
    // No result may reference B's session or leak B's text.
    expect(res.results.every((r) => r.session_id !== bSession)).toBe(true);
    expect(res.results.every((r) => !r.text.includes("secret roadmap"))).toBe(true);
    expect(res.sessions.every((s) => s.id !== bSession)).toBe(true);

    const other = await searchMemory(env, OTHER_USER, { query: "secret roadmap" }, deps);
    expect(other.results.length).toBeGreaterThan(0);
    expect(other.results[0].session_id).toBe(bSession);
  });

  it("respects kind, session_id, and date filters", async () => {
    const early = Date.parse("2026-01-05T00:00:00Z");
    const late = Date.parse("2026-06-05T00:00:00Z");
    const earlySession = await seedAndIngest("architecture review of the payments module", {
      createdAt: early,
    });
    const lateSession = await seedAndIngest("architecture review of the payments module again", {
      createdAt: late,
    });

    // session_id filter
    const bySession = await searchMemory(
      env,
      SINGLE_USER_ID,
      { query: "payments architecture", filters: { session_id: earlySession } },
      deps,
    );
    expect(bySession.results.length).toBeGreaterThan(0);
    expect(bySession.results.every((r) => r.session_id === earlySession)).toBe(true);

    // date range filter excludes the early session, keeps the late one
    const byDate = await searchMemory(
      env,
      SINGLE_USER_ID,
      {
        query: "payments architecture",
        filters: { date_from: "2026-03-01", date_to: "2026-12-31" },
      },
      deps,
    );
    expect(byDate.results.some((r) => r.session_id === lateSession)).toBe(true);
    expect(byDate.results.every((r) => r.session_id !== earlySession)).toBe(true);

    // kind filter excludes transcripts entirely
    const byKind = await searchMemory(
      env,
      SINGLE_USER_ID,
      { query: "payments architecture", filters: { kind: ["document"] } },
      deps,
    );
    expect(byKind.results).toHaveLength(0);
  });

  it("returns keyword session-title matches for the palette", async () => {
    await seedSession(crypto.randomUUID(), { title: "Phoenix launch retro" });
    const res = await searchMemory(env, SINGLE_USER_ID, { query: "Phoenix" }, deps);
    expect(res.sessions.length).toBeGreaterThan(0);
    expect(res.sessions[0].title).toContain("Phoenix");
    expect(typeof res.sessions[0].created_at).toBe("number");
  });

  it("empty query is a no-op", async () => {
    const res = await searchMemory(env, SINGLE_USER_ID, { query: "   " }, deps);
    expect(res).toEqual({ results: [], sessions: [] });
  });

  it("respects top_k", async () => {
    for (let i = 0; i < 5; i++) {
      await seedAndIngest(`retro notes batch ${i} about deployment cadence`);
    }
    const res = await searchMemory(
      env,
      SINGLE_USER_ID,
      { query: "deployment cadence retro", top_k: 2 },
      deps,
    );
    expect(res.results.length).toBeLessThanOrEqual(2);
  });
});

describe("toFtsQuery", () => {
  it("quotes terms and strips embedded quotes", () => {
    expect(toFtsQuery('hello "world" OR 1;DROP')).toBe('"hello" "world" "OR" "1;DROP"');
    expect(toFtsQuery("   ")).toBe("");
  });
});
