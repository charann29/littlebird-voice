/**
 * App — providers + router only (section 50). The v1 tab layout moved into
 * the AppShell layout route (sidebar/topbar/drawer) and the pages under
 * src/pages/; banners and the brand logo live in src/components/shell/.
 */
import { BrowserRouter } from "react-router";
import { RecordingsProvider } from "./hooks/useRecordings";
import { AppRoutes } from "./router";

export default function App() {
  return (
    <RecordingsProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </RecordingsProvider>
  );
}
