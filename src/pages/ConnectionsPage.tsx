/**
 * ConnectionsPage — thin host for section 40's ConnectionsSettings at
 * /settings/connections (the exact path 40's OAuth callback redirects to;
 * ?connected= / ?error= query params are consumed by useIntegrations).
 */
import { ConnectionsSettings } from "../components/ConnectionsSettings";

export function ConnectionsPage() {
  return <ConnectionsSettings />;
}
