import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SINGLE_USER_ID } from "../auth";
import type { Env } from "../env";
import {
  consumeOauthState,
  createOauthState,
  deleteConnection,
  getAccessToken,
  getConnection,
  listConnections,
  upsertConnection,
} from "./store";
import { generateStateId } from "./crypto";
import {
  ReconnectRequiredError,
  type Connector,
  type TokenSet,
} from "./types";

const testEnv = env as unknown as Env;

// Storage is shared within a test file — reset the tables this suite touches.
beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM integration_connections"),
    testEnv.DB.prepare("DELETE FROM oauth_states"),
  ]);
});

function tokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-plain",
    refreshToken: "refresh-plain",
    expiresAt: Date.now() + 3600_000,
    tokenType: "Bearer",
    scopes: "scope-a scope-b",
    externalAccountId: "acct-1",
    displayName: "user@example.com",
    ...overrides,
  };
}

/** Minimal connector whose refresh behavior tests control. */
function fakeConnector(
  refresh?: (rt: string, env: Env) => Promise<TokenSet>,
): Connector {
  return {
    slug: "google-calendar",
    isConfigured: () => true,
    authorizeUrl: () => "https://example.com/authorize",
    exchangeCode: async () => tokenSet(),
    ...(refresh ? { refresh } : {}),
  };
}

describe("connection upsert + listing", () => {
  it("creates a connection and never exposes token plaintext in D1", async () => {
    await upsertConnection(testEnv, SINGLE_USER_ID, "google-calendar", tokenSet());
    const conn = await getConnection(testEnv, SINGLE_USER_ID, "google-calendar");
    expect(conn).not.toBeNull();
    expect(conn!.status).toBe("active");
    expect(conn!.display_name).toBe("user@example.com");

    const row = await testEnv.DB.prepare(
      "SELECT access_token_enc, refresh_token_enc FROM integration_tokens WHERE connection_id = ?",
    )
      .bind(conn!.id)
      .first<{ access_token_enc: string; refresh_token_enc: string }>();
    expect(row!.access_token_enc).not.toContain("access-plain");
    expect(row!.refresh_token_enc).not.toContain("refresh-plain");
  });

  it("re-connecting replaces the row (one per user+provider) and resets status", async () => {
    const id1 = await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      tokenSet(),
    );
    await testEnv.DB.prepare(
      "UPDATE integration_connections SET status = 'error' WHERE id = ?",
    )
      .bind(id1)
      .run();
    const id2 = await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      tokenSet({ displayName: "other@example.com" }),
    );
    expect(id2).toBe(id1);
    const rows = await listConnections(testEnv, SINGLE_USER_ID);
    const cal = rows.filter((r) => r.provider === "google-calendar");
    expect(cal).toHaveLength(1);
    expect(cal[0].status).toBe("active");
    expect(cal[0].display_name).toBe("other@example.com");
  });

  it("deleteConnection removes both rows and returns decrypted tokens for revocation", async () => {
    await upsertConnection(testEnv, SINGLE_USER_ID, "google-calendar", tokenSet());
    const conn = await getConnection(testEnv, SINGLE_USER_ID, "google-calendar");
    const tokens = await deleteConnection(testEnv, conn!);
    expect(tokens).toEqual({
      accessToken: "access-plain",
      refreshToken: "refresh-plain",
    });
    expect(
      await getConnection(testEnv, SINGLE_USER_ID, "google-calendar"),
    ).toBeNull();
    const tokenRow = await testEnv.DB.prepare(
      "SELECT connection_id FROM integration_tokens WHERE connection_id = ?",
    )
      .bind(conn!.id)
      .first();
    expect(tokenRow).toBeNull();
  });
});

describe("getAccessToken", () => {
  it("returns the decrypted token without refreshing when unexpired", async () => {
    await upsertConnection(testEnv, SINGLE_USER_ID, "google-calendar", tokenSet());
    const conn = await getConnection(testEnv, SINGLE_USER_ID, "google-calendar");
    let refreshCalled = false;
    const connector = fakeConnector(async () => {
      refreshCalled = true;
      return tokenSet();
    });
    const token = await getAccessToken(testEnv, conn!, connector);
    expect(token).toBe("access-plain");
    expect(refreshCalled).toBe(false);
  });

  it("refreshes an expiring token and persists the rotated tokens", async () => {
    await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      tokenSet({ expiresAt: Date.now() - 1000 }),
    );
    const conn = await getConnection(testEnv, SINGLE_USER_ID, "google-calendar");
    const connector = fakeConnector(async (rt) => {
      expect(rt).toBe("refresh-plain");
      return tokenSet({
        accessToken: "access-rotated",
        refreshToken: undefined, // Google often omits it on refresh
        expiresAt: Date.now() + 3600_000,
      });
    });
    const token = await getAccessToken(testEnv, conn!, connector);
    expect(token).toBe("access-rotated");

    // Second call: no refresh needed, decrypts the persisted rotated token,
    // and the old refresh token was kept.
    const again = await getAccessToken(testEnv, conn!, fakeConnector());
    expect(again).toBe("access-rotated");
  });

  it("keeps the old refresh token when the provider omits it", async () => {
    await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      tokenSet({ expiresAt: Date.now() - 1000 }),
    );
    const conn = await getConnection(testEnv, SINGLE_USER_ID, "google-calendar");
    await getAccessToken(
      testEnv,
      conn!,
      fakeConnector(async () =>
        tokenSet({ accessToken: "a2", refreshToken: undefined, expiresAt: Date.now() - 1 }),
      ),
    );
    // Token is expired again → refresh must still find the ORIGINAL refresh token.
    const seen: string[] = [];
    await getAccessToken(
      testEnv,
      conn!,
      fakeConnector(async (rt) => {
        seen.push(rt);
        return tokenSet({ accessToken: "a3" });
      }),
    );
    expect(seen).toEqual(["refresh-plain"]);
  });

  it("flips status to error and throws ReconnectRequiredError on refresh failure", async () => {
    await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      tokenSet({ expiresAt: Date.now() - 1000 }),
    );
    const conn = await getConnection(testEnv, SINGLE_USER_ID, "google-calendar");
    const connector = fakeConnector(async () => {
      throw new Error("invalid_grant");
    });
    await expect(getAccessToken(testEnv, conn!, connector)).rejects.toThrow(
      ReconnectRequiredError,
    );
    const after = await getConnection(testEnv, SINGLE_USER_ID, "google-calendar");
    expect(after!.status).toBe("error");
  });

  it("throws ReconnectRequiredError when expired with no refresh token", async () => {
    await upsertConnection(
      testEnv,
      SINGLE_USER_ID,
      "google-calendar",
      tokenSet({ refreshToken: undefined, expiresAt: Date.now() - 1000 }),
    );
    const conn = await getConnection(testEnv, SINGLE_USER_ID, "google-calendar");
    await expect(
      getAccessToken(testEnv, conn!, fakeConnector()),
    ).rejects.toThrow(ReconnectRequiredError);
  });
});

describe("oauth state rows", () => {
  it("consumes a valid state exactly once", async () => {
    const stateId = generateStateId();
    await createOauthState(testEnv, {
      stateId,
      userId: SINGLE_USER_ID,
      provider: "google-calendar",
      redirectTo: "/settings/connections",
    });
    const first = await consumeOauthState(testEnv, stateId);
    expect(first).toEqual({
      userId: SINGLE_USER_ID,
      provider: "google-calendar",
      redirectTo: "/settings/connections",
    });
    // Replay: single-use.
    expect(await consumeOauthState(testEnv, stateId)).toBeNull();
  });

  it("rejects expired states", async () => {
    const stateId = generateStateId();
    await createOauthState(testEnv, {
      stateId,
      userId: SINGLE_USER_ID,
      provider: "google-calendar",
    });
    await testEnv.DB.prepare(
      "UPDATE oauth_states SET expires_at = ? WHERE state_id = ?",
    )
      .bind(Date.now() - 1, stateId)
      .run();
    expect(await consumeOauthState(testEnv, stateId)).toBeNull();
  });

  it("rejects unknown state ids", async () => {
    expect(await consumeOauthState(testEnv, generateStateId())).toBeNull();
  });
});
