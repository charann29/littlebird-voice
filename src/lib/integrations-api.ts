/**
 * integrations-api — typed client for the section-40 integrations endpoints
 * (`/api/integrations/*`).
 *
 * Thin wrapper over `apiFetch` (bearer token + `/api` prefix + ApiError
 * normalization). Provider tokens live exclusively in the Worker: the client
 * only ever sees connection status, display labels, and content identifiers
 * (channel ids, database ids, page ids) — never an access/refresh token.
 */
import { ApiError, apiFetch } from "./api";

export const INTEGRATION_PROVIDERS = [
  "google-calendar",
  "gmail",
  "slack",
  "notion",
] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** Server-side connection status ('error' → surface Reconnect in UI). */
export type ConnectionStatus = "active" | "error" | "revoked";

/** One provider row from GET /api/integrations (all 4, connected or not). */
export interface ProviderState {
  provider: IntegrationProvider;
  connected: boolean;
  status?: ConnectionStatus;
  /** Account label: email / Slack workspace / Notion workspace. */
  displayName?: string;
  /** Space-separated granted scopes ('' for Notion). */
  scopes?: string;
  /** Unix ms. */
  connectedAt?: number;
}

export interface IntegrationsListResponse {
  providers: ProviderState[];
}

/** POST /api/integrations/:provider/connect response. */
export interface ConnectResponse {
  authorizeUrl: string;
}

// ---- Google Calendar ------------------------------------------------------

export interface CalendarAttendee {
  email: string;
  name?: string;
}

/** Normalized event from GET /api/integrations/google-calendar/events. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601. */
  startsAt: string;
  endsAt: string;
  attendees: CalendarAttendee[];
  meetLink?: string;
  htmlLink: string;
}

export interface CalendarEventsResponse {
  events: CalendarEvent[];
}

// ---- Gmail ----------------------------------------------------------------

export interface GmailSendBody {
  to: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  sessionId?: string;
}

export interface GmailSendResponse {
  messageId: string;
}

// ---- Slack ----------------------------------------------------------------

export interface SlackChannel {
  id: string;
  name: string;
}

export interface SlackChannelsResponse {
  channels: SlackChannel[];
}

export interface SlackSendResponse {
  ok: boolean;
  ts: string;
}

// ---- Notion ---------------------------------------------------------------

export interface NotionDatabase {
  id: string;
  title: string;
}

export interface NotionDatabasesResponse {
  databases: NotionDatabase[];
}

export interface NotionPage {
  id: string;
  title: string;
}

export interface NotionPagesResponse {
  pages: NotionPage[];
}

export interface NotionExportBody {
  databaseId: string;
  title: string;
  summary: string;
  actionItems: string[];
  sessionId?: string;
}

export interface NotionExportResponse {
  pageId: string;
  url: string;
}

export interface NotionImportResponse {
  imported: { pageId: string; documentId: string }[];
}

// ---- Framework calls ------------------------------------------------------

/** GET /api/integrations — status of all four providers. */
export function listIntegrations(
  signal?: AbortSignal,
): Promise<IntegrationsListResponse> {
  return apiFetch<IntegrationsListResponse>("/integrations", { signal });
}

/**
 * POST /api/integrations/:provider/connect — returns the provider consent
 * URL for a full-page redirect. `redirectTo` is the app path the OAuth
 * callback should send the browser back to.
 */
export function connectIntegration(
  provider: IntegrationProvider,
  redirectTo?: string,
): Promise<ConnectResponse> {
  return apiFetch<ConnectResponse>(`/integrations/${provider}/connect`, {
    method: "POST",
    body: JSON.stringify(redirectTo ? { redirectTo } : {}),
  });
}

/** DELETE /api/integrations/:provider — revoke (best effort) + delete. */
export function disconnectIntegration(
  provider: IntegrationProvider,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/integrations/${provider}`, {
    method: "DELETE",
  });
}

// ---- Connector actions ----------------------------------------------------

/** GET /api/integrations/google-calendar/events?days=N */
export function listCalendarEvents(
  days = 7,
  signal?: AbortSignal,
): Promise<CalendarEventsResponse> {
  return apiFetch<CalendarEventsResponse>(
    `/integrations/google-calendar/events?days=${days}`,
    { signal },
  );
}

/** POST /api/integrations/gmail/send */
export function sendGmail(body: GmailSendBody): Promise<GmailSendResponse> {
  return apiFetch<GmailSendResponse>("/integrations/gmail/send", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** GET /api/integrations/slack/channels */
export function listSlackChannels(
  signal?: AbortSignal,
): Promise<SlackChannelsResponse> {
  return apiFetch<SlackChannelsResponse>("/integrations/slack/channels", {
    signal,
  });
}

/** POST /api/integrations/slack/send */
export function postToSlack(
  channelId: string,
  text: string,
): Promise<SlackSendResponse> {
  return apiFetch<SlackSendResponse>("/integrations/slack/send", {
    method: "POST",
    body: JSON.stringify({ channelId, text }),
  });
}

/** GET /api/integrations/notion/databases */
export function listNotionDatabases(
  signal?: AbortSignal,
): Promise<NotionDatabasesResponse> {
  return apiFetch<NotionDatabasesResponse>("/integrations/notion/databases", {
    signal,
  });
}

/** POST /api/integrations/notion/export */
export function exportToNotion(
  body: NotionExportBody,
): Promise<NotionExportResponse> {
  return apiFetch<NotionExportResponse>("/integrations/notion/export", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** GET /api/integrations/notion/pages?query= */
export function searchNotionPages(
  query: string,
  signal?: AbortSignal,
): Promise<NotionPagesResponse> {
  return apiFetch<NotionPagesResponse>(
    `/integrations/notion/pages?query=${encodeURIComponent(query)}`,
    { signal },
  );
}

/** POST /api/integrations/notion/import */
export function importNotionPages(
  pageIds: string[],
): Promise<NotionImportResponse> {
  return apiFetch<NotionImportResponse>("/integrations/notion/import", {
    method: "POST",
    body: JSON.stringify({ pageIds }),
  });
}

// ---- Error mapping --------------------------------------------------------

/**
 * Map an action failure to a short, user-readable message. Provider errors
 * (e.g. Slack's `not_in_channel`) surface their upstream message verbatim per
 * the section-40 spec.
 */
export function integrationErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "not_connected":
        return "Not connected — connect this provider in Settings → Connections.";
      case "reconnect_required":
        return "Access expired — reconnect this provider in Settings → Connections.";
      case "provider_error":
        return err.message || "The provider returned an error.";
      default:
        return err.message || `Request failed (HTTP ${err.status})`;
    }
  }
  return "Network error — check your connection and try again.";
}
