import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { api, sessionBody, testEnv } from "../../test/helpers";

describe("auth", () => {
  it("returns 401 without a token, with canonical error body", async () => {
    const res = await api("/api/sessions", { token: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthorized");
    expect(typeof body.error.message).toBe("string");
  });

  it("returns 401 with a wrong token", async () => {
    const res = await api("/api/sessions", { token: "wrong-token" });
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/check → 204 with token, 401 without", async () => {
    const ok = await api("/api/auth/check");
    expect(ok.status).toBe(204);
    const bad = await api("/api/auth/check", { token: null });
    expect(bad.status).toBe(401);
  });

  it("GET /api/health is unauthenticated", async () => {
    const res = await api("/api/health", { token: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("sessions CRUD", () => {
  it("PUT upsert is idempotent: same UUID twice ⇒ one row, 201 then 200", async () => {
    const id = crypto.randomUUID();
    const first = await api(`/api/sessions/${id}`, {
      method: "PUT",
      body: sessionBody(),
    });
    expect(first.status).toBe(201);
    const second = await api(`/api/sessions/${id}`, {
      method: "PUT",
      body: sessionBody({ title: "Renamed" }),
    });
    expect(second.status).toBe(200);
    const { session } = (await second.json()) as { session: { title: string } };
    expect(session.title).toBe("Renamed");

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("PUT validates status/source enums and timestamps", async () => {
    const id = crypto.randomUUID();
    const badStatus = await api(`/api/sessions/${id}`, {
      method: "PUT",
      body: sessionBody({ status: "ready" }),
    });
    expect(badStatus.status).toBe(400);
    const body = (await badStatus.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");

    const badSource = await api(`/api/sessions/${id}`, {
      method: "PUT",
      body: sessionBody({ source: "phone" }),
    });
    expect(badSource.status).toBe(400);

    const noTimestamps = await api(`/api/sessions/${id}`, {
      method: "PUT",
      body: { title: "x" },
    });
    expect(noTimestamps.status).toBe(400);
  });

  it("GET list returns sessions newest-first, honors limit/before", async () => {
    // Far-future timestamps so rows from other tests (shared storage within
    // a test file) can never interleave with this test's window.
    const base = Date.now() + 10_000_000;
    for (let i = 0; i < 3; i++) {
      await api(`/api/sessions/${crypto.randomUUID()}`, {
        method: "PUT",
        body: sessionBody({ created_at: base + i, title: `s${i}` }),
      });
    }
    const res = await api("/api/sessions?limit=2");
    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as {
      sessions: { title: string; created_at: number }[];
    };
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.title)).toEqual(["s2", "s1"]);
    expect(sessions[0].created_at).toBeGreaterThan(sessions[1].created_at);

    // `before` excludes rows at/after the cursor: only s0 from this batch.
    const older = await api(`/api/sessions?before=${base + 1}`);
    const olderBody = (await older.json()) as { sessions: { title: string }[] };
    const mine = olderBody.sessions.filter((s) => /^s\d$/.test(s.title));
    expect(mine.map((s) => s.title)).toEqual(["s0"]);

    const badCursor = await api("/api/sessions?before=nonsense");
    expect(badCursor.status).toBe(400);
  });

  it("PATCH persists self_speaker and partial fields", async () => {
    const id = crypto.randomUUID();
    await api(`/api/sessions/${id}`, { method: "PUT", body: sessionBody() });
    const res = await api(`/api/sessions/${id}`, {
      method: "PATCH",
      body: { self_speaker: "1", title: "Patched" },
    });
    expect(res.status).toBe(200);
    const { session } = (await res.json()) as {
      session: { self_speaker: string; title: string };
    };
    expect(session.self_speaker).toBe("1");
    expect(session.title).toBe("Patched");
  });

  it("GET/PATCH/DELETE on a missing id return 404 with canonical body", async () => {
    const id = crypto.randomUUID();
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { title: "x" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await api(`/api/sessions/${id}`, { method, body });
      expect(res.status).toBe(404);
      const parsed = (await res.json()) as { error: { code: string } };
      expect(parsed.error.code).toBe("not_found");
    }
  });

  it("DELETE cascades segments and summaries", async () => {
    const shared = testEnv();
    const id = crypto.randomUUID();
    await api(`/api/sessions/${id}`, {
      method: "PUT",
      body: sessionBody(),
      env: shared.env,
    });
    await api(`/api/sessions/${id}/transcript`, {
      method: "PUT",
      body: { segments: [{ text: "hello", speaker: "1" }] },
      env: shared.env,
    });
    await api(`/api/sessions/${id}/summaries/meeting_summary`, {
      method: "PUT",
      body: { payload: { tl_dr: "hi" } },
      env: shared.env,
    });

    const del = await api(`/api/sessions/${id}`, {
      method: "DELETE",
      env: shared.env,
    });
    expect(del.status).toBe(204);

    const segs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM transcript_segments WHERE session_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    const sums = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM summaries WHERE session_id = ?",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(segs?.n).toBe(0);
    expect(sums?.n).toBe(0);
  });

  it("unknown /api route returns canonical 404 body", async () => {
    const res = await api("/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("transcript endpoints", () => {
  it("PUT transcript replaces segments; GET returns segments + joined text", async () => {
    const shared = testEnv();
    const id = crypto.randomUUID();
    await api(`/api/sessions/${id}`, {
      method: "PUT",
      body: sessionBody(),
      env: shared.env,
    });

    const put1 = await api(`/api/sessions/${id}/transcript`, {
      method: "PUT",
      body: {
        segments: [
          { text: "hello", speaker: "1", start_ms: 0, end_ms: 900 },
          { text: "world", speaker: "2", start_ms: 900, end_ms: 1500 },
        ],
      },
      env: shared.env,
    });
    expect(put1.status).toBe(200);
    expect(await put1.json()).toEqual({ count: 2 });

    // Replace with a single segment — old rows must be gone.
    await api(`/api/sessions/${id}/transcript`, {
      method: "PUT",
      body: { segments: [{ text: "replaced" }] },
      env: shared.env,
    });

    const get = await api(`/api/sessions/${id}/transcript`, {
      env: shared.env,
    });
    const body = (await get.json()) as {
      segments: { text: string; seq: number }[];
      text: string;
    };
    expect(body.segments).toHaveLength(1);
    expect(body.text).toBe("replaced");
  });

  it("PUT transcript rejects segments without text", async () => {
    const id = crypto.randomUUID();
    await api(`/api/sessions/${id}`, { method: "PUT", body: sessionBody() });
    const res = await api(`/api/sessions/${id}/transcript`, {
      method: "PUT",
      body: { segments: [{ speaker: "1" }] },
    });
    expect(res.status).toBe(400);
  });

  it("PUT transcript on unknown session → 404", async () => {
    const res = await api(`/api/sessions/${crypto.randomUUID()}/transcript`, {
      method: "PUT",
      body: { segments: [{ text: "x" }] },
    });
    expect(res.status).toBe(404);
  });
});

describe("summaries endpoints", () => {
  it("PUT upserts per kind, bumps revision, GET returns payloads", async () => {
    const shared = testEnv();
    const id = crypto.randomUUID();
    await api(`/api/sessions/${id}`, {
      method: "PUT",
      body: sessionBody(),
      env: shared.env,
    });

    const first = await api(`/api/sessions/${id}/summaries/meeting_summary`, {
      method: "PUT",
      body: { payload: { tl_dr: "v1" }, model: "test-model" },
      env: shared.env,
    });
    expect(first.status).toBe(200);
    const s1 = ((await first.json()) as { summary: { revision: number } }).summary;
    expect(s1.revision).toBe(1);

    const second = await api(`/api/sessions/${id}/summaries/meeting_summary`, {
      method: "PUT",
      body: { payload: { tl_dr: "v2" } },
      env: shared.env,
    });
    const s2 = ((await second.json()) as {
      summary: { revision: number; payload: { tl_dr: string } };
    }).summary;
    expect(s2.revision).toBe(2);
    expect(s2.payload.tl_dr).toBe("v2");

    // A different kind is an independent row with its own revision.
    await api(`/api/sessions/${id}/summaries/follow_ups`, {
      method: "PUT",
      body: { payload: { items: [] } },
      env: shared.env,
    });

    const list = await api(`/api/sessions/${id}/summaries`, {
      env: shared.env,
    });
    const { summaries } = (await list.json()) as {
      summaries: { kind: string; revision: number; payload: object }[];
    };
    expect(summaries).toHaveLength(2);
    const meeting = summaries.find((s) => s.kind === "meeting_summary");
    expect(meeting?.revision).toBe(2);
  });
});
