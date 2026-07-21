/**
 * Calendar → sessions auto-create cron (decisions.md #4).
 *
 * On each scheduled run, for every user with an active google-calendar
 * connection: list events starting within the lookahead window (default 24h)
 * and pre-create a `sessions` row per event, titled from the event, so the
 * meeting shows up in the app ready for capture.
 *
 * Dedup: the `calendar_event_sessions` ledger maps (user_id, event_id) →
 * session_id with a PRIMARY KEY on (user_id, event_id). An event is only
 * materialized when no ledger row exists — and the ledger row deliberately
 * survives session deletion, so deleting an auto-created session does NOT
 * resurrect it on the next cron run. `singleEvents=true` in the Calendar
 * query expands recurring events, so each instance id is unique.
 *
 * Hard platform constraint (documented in the plan): capture can NOT
 * auto-start from these sessions — getDisplayMedia/getUserMedia require a
 * user gesture. Auto-created sessions sit in status='pending' until the user
 * clicks "Start capture".
 */

import type { Env } from "../env";
import { ReconnectRequiredError, type ConnectionRow } from "./types";
import { getAccessToken } from "./store";
import { getConnector } from "./registry";
import {
  listUpcomingEvents,
  type CalendarEvent,
} from "./connectors/googleCalendar";

const DEFAULT_WINDOW_HOURS = 24;

export interface AutoCreateResult {
  usersProcessed: number;
  eventsSeen: number;
  sessionsCreated: number;
  errors: number;
}

function windowMs(env: Env): number {
  const hours = Number(env.CALENDAR_AUTOCREATE_WINDOW_HOURS ?? "");
  return (
    (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_WINDOW_HOURS) *
    60 *
    60 *
    1000
  );
}

function sessionTitle(event: CalendarEvent): string {
  return event.title || "(untitled event)";
}

/** Create one session + ledger row for a not-yet-materialized event. */
async function materializeEvent(
  env: Env,
  userId: string,
  event: CalendarEvent,
  now: number,
): Promise<boolean> {
  const startsAtMs = Date.parse(event.startsAt);
  const createdAt = Number.isFinite(startsAtMs) ? startsAtMs : now;
  const sessionId = crypto.randomUUID();

  // Ledger INSERT first (OR IGNORE): under concurrent runs only one insert
  // wins the (user_id, event_id) primary key; the loser skips the session.
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO calendar_event_sessions (user_id, event_id, session_id, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(userId, event.id, sessionId, now)
    .run();
  if (inserted.meta.changes !== 1) return false; // already materialized

  // source='tab' — meetings are tab-capture sessions (sessions.source CHECK
  // allows 'mic'|'tab'|'screen' only). created_at = event start so the
  // session sorts into the right day group.
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, title, source, status, created_at, updated_at, duration_ms)
     VALUES (?, ?, ?, 'tab', 'pending', ?, ?, 0)`,
  )
    .bind(sessionId, userId, sessionTitle(event), createdAt, now)
    .run();
  return true;
}

/** The cron body — safe to call with zero connected users / no credentials
 *  (local dev): it simply does nothing. */
export async function autoCreateCalendarSessions(
  env: Env,
  now: number = Date.now(),
): Promise<AutoCreateResult> {
  const result: AutoCreateResult = {
    usersProcessed: 0,
    eventsSeen: 0,
    sessionsCreated: 0,
    errors: 0,
  };
  const connector = getConnector("google-calendar");
  if (!connector || !env.INTEGRATIONS_TOKEN_KEY) return result;

  const { results: connections } = await env.DB.prepare(
    `SELECT id, user_id, provider, external_account_id, display_name, scopes,
            status, metadata, created_at, updated_at
     FROM integration_connections
     WHERE provider = 'google-calendar' AND status = 'active'`,
  ).all<ConnectionRow>();

  for (const conn of connections) {
    result.usersProcessed++;
    try {
      const accessToken = await getAccessToken(env, conn, connector);
      const events = await listUpcomingEvents(accessToken, windowMs(env), now);
      result.eventsSeen += events.length;
      for (const event of events) {
        if (!event.id) continue;
        if (await materializeEvent(env, conn.user_id, event, now)) {
          result.sessionsCreated++;
        }
      }
    } catch (err) {
      // ReconnectRequiredError already flipped status='error'; other errors
      // (provider 5xx etc.) are logged and skipped — next run retries.
      result.errors++;
      if (!(err instanceof ReconnectRequiredError)) {
        console.error(
          `calendar auto-create failed for user ${conn.user_id}:`,
          err,
        );
      }
    }
  }
  return result;
}
