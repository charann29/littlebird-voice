/**
 * Google Calendar connector (section 40 T3) — the first real connector that
 * proves the framework end-to-end: OAuth with offline access + refresh,
 * readonly events scope, normalized events listing, token revocation.
 *
 * Shares the Google OAuth app with the Gmail connector (separate consent,
 * different scopes, separate connection rows = scope minimization).
 */

import type { Env } from "../../env";
import { ProviderError, type Connector, type TokenSet } from "../types";

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const EVENTS_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export const CALENDAR_SCOPES =
  "https://www.googleapis.com/auth/calendar.events.readonly openid email";

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  id_token?: string;
}

/** Decode the payload of a JWT without verifying — acceptable here because
 *  the id_token comes straight from Google's token endpoint over TLS. */
function decodeIdToken(idToken: string): { sub?: string; email?: string } {
  try {
    const payload = idToken.split(".")[1] ?? "";
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(pad)) as { sub?: string; email?: string };
  } catch {
    return {};
  }
}

async function tokenRequest(
  env: Env,
  params: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      ...params,
    }),
  });
  if (!res.ok) {
    throw new ProviderError(`Google token endpoint returned ${res.status}`, res.status);
  }
  return (await res.json()) as GoogleTokenResponse;
}

function toTokenSet(
  data: GoogleTokenResponse,
  fallback?: { externalAccountId?: string; displayName?: string },
): TokenSet {
  const claims = data.id_token ? decodeIdToken(data.id_token) : {};
  const externalAccountId = claims.sub ?? fallback?.externalAccountId ?? "";
  const displayName = claims.email ?? fallback?.displayName ?? "Google account";
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    tokenType: data.token_type || "Bearer",
    scopes: data.scope ?? CALENDAR_SCOPES,
    externalAccountId,
    displayName,
  };
}

export const googleCalendarConnector: Connector = {
  slug: "google-calendar",

  isConfigured(env) {
    return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
  },

  authorizeUrl({ state, redirectUri, env }) {
    const url = new URL(AUTHORIZE_ENDPOINT);
    url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID ?? "");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", CALENDAR_SCOPES);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent"); // always get a refresh token
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode({ code, redirectUri, env }) {
    const data = await tokenRequest(env, {
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    return toTokenSet(data);
  },

  async refresh(refreshToken, env) {
    const data = await tokenRequest(env, {
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    return toTokenSet(data);
  },

  async revoke(tokenSet) {
    // Revoking either token invalidates the whole grant; refresh preferred.
    const token = tokenSet.refreshToken ?? tokenSet.accessToken;
    await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    }); // best effort — callers ignore failures
  },
};

// ---------------------------------------------------------------------------
// Events listing (used by GET /api/integrations/google-calendar/events and
// the auto-create cron)
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string; // RFC3339 (all-day events: date at midnight UTC)
  endsAt: string;
  attendees: { email: string; name?: string }[];
  meetLink?: string;
  htmlLink: string;
}

interface GoogleEventItem {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string }[];
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
  htmlLink?: string;
}

function eventTime(t?: { dateTime?: string; date?: string }): string {
  if (t?.dateTime) return t.dateTime;
  if (t?.date) return `${t.date}T00:00:00Z`;
  return "";
}

function meetLinkOf(item: GoogleEventItem): string | undefined {
  if (item.hangoutLink) return item.hangoutLink;
  const video = item.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video" && e.uri,
  );
  return video?.uri;
}

/** Fetch upcoming events in [now, now + windowMs), normalized. */
export async function listUpcomingEvents(
  accessToken: string,
  windowMs: number,
  now: number = Date.now(),
): Promise<CalendarEvent[]> {
  const url = new URL(EVENTS_ENDPOINT);
  url.searchParams.set("timeMin", new Date(now).toISOString());
  url.searchParams.set("timeMax", new Date(now + windowMs).toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "50");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new ProviderError(`Google Calendar API returned ${res.status}`, res.status);
  }
  const data = (await res.json()) as { items?: GoogleEventItem[] };
  return (data.items ?? [])
    .filter((item) => item.status !== "cancelled")
    .map((item) => ({
      id: item.id,
      title: item.summary ?? "(untitled event)",
      startsAt: eventTime(item.start),
      endsAt: eventTime(item.end),
      attendees: (item.attendees ?? [])
        .filter((a): a is { email: string; displayName?: string } =>
          Boolean(a.email),
        )
        .map((a) => ({
          email: a.email,
          ...(a.displayName ? { name: a.displayName } : {}),
        })),
      ...(meetLinkOf(item) ? { meetLink: meetLinkOf(item) } : {}),
      htmlLink: item.htmlLink ?? "",
    }));
}
