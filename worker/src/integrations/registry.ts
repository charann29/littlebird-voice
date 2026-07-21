/**
 * Connector registry (section 40). Add new connectors by importing them here
 * and adding one entry — routes.ts iterates this record for the framework
 * endpoints (list/connect/callback/disconnect).
 *
 * Slots for gmail / slack / notion are filled by their connector modules
 * (T4); until a slug is registered, its framework endpoints return
 * 501 not_configured (connect) or 404 (callback/actions), so a partial
 * registry never breaks the Worker.
 */

import type { Connector, ProviderSlug } from "./types";
import { googleCalendarConnector } from "./connectors/googleCalendar";

export const connectors: Partial<Record<ProviderSlug, Connector>> = {
  "google-calendar": googleCalendarConnector,
};

export function getConnector(slug: ProviderSlug): Connector | undefined {
  return connectors[slug];
}
