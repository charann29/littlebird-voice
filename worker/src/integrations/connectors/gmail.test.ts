import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../../env";
import {
  GMAIL_SCOPES,
  gmailConnector,
  buildRfc822Message,
  encodeRfc2047,
  exchangeGmailCode,
  gmailAuthorizeUrl,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  sendGmail,
} from "./gmail";
import { ConnectorProviderError, ValidationError, base64UrlEncode } from "./shared";

/** Same upstream-fetch stub pattern as src/routes/soniox.test.ts. */
type FetchArgs = { url: string; init: RequestInit & { headers: Headers } };

let upstreamCalls: FetchArgs[];
let upstreamResponder: (args: FetchArgs) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  upstreamCalls = [];
  upstreamResponder = () => {
    throw new Error("unexpected upstream fetch");
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const args: FetchArgs = { url, init: { ...init, headers } };
    upstreamCalls.push(args);
    return upstreamResponder(args);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = realFetch;
});

const CREDS = { clientId: "google-client-id", clientSecret: "google-secret" };

/** Fake unsigned JWT with the given payload (only the payload is decoded). */
function fakeIdToken(payload: object): string {
  const b64url = (s: string) => base64UrlEncode(s);
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

describe("gmailAuthorizeUrl", () => {
  it("builds the Google consent URL with offline access and gmail scopes", () => {
    const url = new URL(
      gmailAuthorizeUrl({
        clientId: CREDS.clientId,
        redirectUri: "https://worker.example/api/integrations/gmail/callback",
        state: "abc.def",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CREDS.clientId);
    expect(url.searchParams.get("scope")).toBe(GMAIL_SCOPES);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("abc.def");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("exchangeGmailCode", () => {
  it("exchanges the code and maps id_token claims to account fields", async () => {
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe("https://oauth2.googleapis.com/token");
      const form = new URLSearchParams(String(init.body));
      expect(form.get("code")).toBe("auth-code");
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("client_secret")).toBe(CREDS.clientSecret);
      return Response.json({
        access_token: "at-123",
        refresh_token: "rt-456",
        expires_in: 3599,
        token_type: "Bearer",
        scope: GMAIL_SCOPES,
        id_token: fakeIdToken({ sub: "google-sub-1", email: "user@example.com" }),
      });
    };

    const before = Date.now();
    const tokens = await exchangeGmailCode({
      code: "auth-code",
      redirectUri: "https://worker.example/cb",
      credentials: CREDS,
    });
    expect(tokens.accessToken).toBe("at-123");
    expect(tokens.refreshToken).toBe("rt-456");
    expect(tokens.tokenType).toBe("Bearer");
    expect(tokens.scopes).toBe(GMAIL_SCOPES);
    expect(tokens.externalAccountId).toBe("google-sub-1");
    expect(tokens.displayName).toBe("user@example.com");
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3599_000);
  });

  it("throws ProviderError with Google's error code on failure", async () => {
    upstreamResponder = () =>
      Response.json({ error: "invalid_grant" }, { status: 400 });
    await expect(
      exchangeGmailCode({ code: "bad", redirectUri: "https://x", credentials: CREDS }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "invalid_grant",
      status: 400,
    });
  });
});

describe("refreshGoogleAccessToken", () => {
  it("posts the refresh grant and returns the rotated access token", async () => {
    upstreamResponder = ({ init }) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("rt-456");
      return Response.json({ access_token: "at-new", expires_in: 3600 });
    };
    const refreshed = await refreshGoogleAccessToken("rt-456", CREDS);
    expect(refreshed.accessToken).toBe("at-new");
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
  });

  it("surfaces a dead refresh token as ProviderError invalid_grant", async () => {
    upstreamResponder = () =>
      Response.json({ error: "invalid_grant" }, { status: 400 });
    await expect(refreshGoogleAccessToken("dead", CREDS)).rejects.toMatchObject({
      code: "invalid_grant",
    });
  });
});

describe("revokeGoogleToken", () => {
  it("is best-effort: never throws even when the request fails", async () => {
    upstreamResponder = () => {
      throw new Error("network down");
    };
    await expect(revokeGoogleToken("some-token")).resolves.toBeUndefined();
    expect(upstreamCalls).toHaveLength(1);
  });
});

describe("encodeRfc2047", () => {
  it("passes ASCII subjects through unchanged", () => {
    expect(encodeRfc2047("Meeting notes: Q3 roadmap")).toBe(
      "Meeting notes: Q3 roadmap",
    );
  });

  it("encodes non-ASCII subjects as UTF-8 B encoded-words", () => {
    const encoded = encodeRfc2047("Réunion — récap");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    // Round-trip the base64 payload.
    const b64 = encoded.slice("=?UTF-8?B?".length, -"?=".length);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe("Réunion — récap");
  });

  it("folds long non-ASCII subjects into multiple <=75-char words", () => {
    const encoded = encodeRfc2047("é".repeat(200));
    const words = encoded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
  });
});

describe("buildRfc822Message", () => {
  it("builds a plain-text message (golden)", () => {
    const msg = buildRfc822Message({
      to: ["a@example.com", "b@example.com"],
      subject: "Hello",
      bodyText: "Line one\nLine two",
    });
    expect(msg).toBe(
      [
        "To: a@example.com, b@example.com",
        "Subject: Hello",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        btoa("Line one\nLine two"),
      ].join("\r\n"),
    );
  });

  it("builds multipart/alternative with a fixed boundary (golden)", () => {
    const msg = buildRfc822Message(
      {
        to: ["a@example.com"],
        subject: "Hi",
        bodyText: "plain",
        bodyHtml: "<p>html</p>",
        sessionId: "sess-1",
      },
      { boundary: "BOUNDARY" },
    );
    expect(msg).toBe(
      [
        "To: a@example.com",
        "Subject: Hi",
        "X-Littlebird-Session: sess-1",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="BOUNDARY"',
        "",
        "--BOUNDARY",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        btoa("plain"),
        "--BOUNDARY",
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        btoa("<p>html</p>"),
        "--BOUNDARY--",
        "",
      ].join("\r\n"),
    );
  });

  it("base64-encodes UTF-8 bodies and wraps at 76 chars", () => {
    const body = "నమస్కారం ".repeat(50);
    const msg = buildRfc822Message({
      to: ["a@example.com"],
      subject: "Test",
      bodyText: body,
    });
    const bodyLines = msg.split("\r\n\r\n")[1].split("\r\n");
    for (const line of bodyLines) expect(line.length).toBeLessThanOrEqual(76);
    const decoded = Uint8Array.from(atob(bodyLines.join("")), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(decoded)).toBe(body);
  });

  it("rejects empty recipients, bad addresses, and header injection", () => {
    const base = { subject: "s", bodyText: "b" };
    expect(() => buildRfc822Message({ ...base, to: [] })).toThrow(ValidationError);
    expect(() => buildRfc822Message({ ...base, to: ["not-an-email"] })).toThrow(
      ValidationError,
    );
    expect(() =>
      buildRfc822Message({ to: ["a@example.com"], subject: "x\r\nBcc: evil@x.com", bodyText: "b" }),
    ).toThrow(ValidationError);
    expect(() =>
      buildRfc822Message({
        to: ["a@example.com"],
        subject: "s",
        bodyText: "b",
        sessionId: "id\r\nX-Evil: 1",
      }),
    ).toThrow(ValidationError);
  });
});

describe("sendGmail", () => {
  const INPUT = { to: ["a@example.com"], subject: "Hi", bodyText: "hello" };

  it("POSTs base64url raw RFC822 with the bearer token and returns messageId", async () => {
    upstreamResponder = ({ url, init }) => {
      expect(url).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      );
      expect(init.headers.get("Authorization")).toBe("Bearer plain-access-token");
      const body = JSON.parse(String(init.body)) as { raw: string };
      expect(body.raw).toBe(base64UrlEncode(buildRfc822Message(INPUT)));
      expect(body.raw).not.toMatch(/[+/=]/); // base64url, unpadded
      return Response.json({ id: "msg-789" });
    };
    const result = await sendGmail("plain-access-token", INPUT);
    expect(result).toEqual({ messageId: "msg-789" });
    // Browser-safe return type: no token material.
    expect(JSON.stringify(result)).not.toContain("plain-access-token");
  });

  it("maps upstream failures to ProviderError with a short code", async () => {
    upstreamResponder = () =>
      Response.json(
        { error: { status: "PERMISSION_DENIED", message: "nope" } },
        { status: 403 },
      );
    await expect(sendGmail("tok", INPUT)).rejects.toMatchObject({
      name: "ProviderError",
      code: "PERMISSION_DENIED",
      status: 403,
    });
  });

  it("rejects invalid input before any upstream call", async () => {
    await expect(
      sendGmail("tok", { to: [], subject: "s", bodyText: "b" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("throws ProviderError when Gmail returns no message id", async () => {
    upstreamResponder = () => Response.json({});
    await expect(sendGmail("tok", INPUT)).rejects.toBeInstanceOf(ConnectorProviderError);
  });
});

describe("gmailConnector (framework Connector object)", () => {
  const env = {
    GOOGLE_OAUTH_CLIENT_ID: CREDS.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: CREDS.clientSecret,
  } as Env;

  it("is configured only when both Google secrets are present", () => {
    expect(gmailConnector.slug).toBe("gmail");
    expect(gmailConnector.isConfigured(env)).toBe(true);
    expect(gmailConnector.isConfigured({} as Env)).toBe(false);
  });

  it("delegates authorizeUrl/exchangeCode/refresh to the helpers with env creds", async () => {
    expect(
      gmailConnector.authorizeUrl({ state: "s", redirectUri: "https://r/cb", env }),
    ).toBe(
      gmailAuthorizeUrl({ clientId: CREDS.clientId, redirectUri: "https://r/cb", state: "s" }),
    );

    upstreamResponder = ({ init }) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get("client_id")).toBe(CREDS.clientId);
      return Response.json({ access_token: "at", expires_in: 3600 });
    };
    const tokens = await gmailConnector.exchangeCode({
      code: "c",
      redirectUri: "https://r/cb",
      env,
    });
    expect(tokens.accessToken).toBe("at");

    const refreshed = await gmailConnector.refresh!("rt", env);
    expect(refreshed.accessToken).toBe("at");
    // Identity fields stay empty on refresh — store keeps the existing row.
    expect(refreshed.externalAccountId).toBe("");
  });
});
