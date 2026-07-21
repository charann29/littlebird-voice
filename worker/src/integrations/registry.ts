/**
 * Connector registry (section 40). Add new connectors by importing them here
 * and adding one entry — routes.ts iterates this record for the framework
 * endpoints (list/connect/callback/disconnect).
 */

import type { Connector, ProviderSlug } from "./types";
import { googleCalendarConnector } from "./connectors/googleCalendar";
import { gmailConnector } from "./connectors/gmail";
import { slackConnector } from "./connectors/slack";
import { notionConnector } from "./connectors/notion";

export const connectors: Partial<Record<ProviderSlug, Connector>> = {
  "google-calendar": googleCalendarConnector,
  gmail: gmailConnector,
  slack: slackConnector,
  notion: notionConnector,
};

export function getConnector(slug: ProviderSlug): Connector | undefined {
  return connectors[slug];
}
