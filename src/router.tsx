/**
 * Route table (section 50 §2). Exported as an element so App.tsx and tests
 * (MemoryRouter) share the same table.
 */
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/shell/AppShell";
import { CapturePage } from "./pages/CapturePage";
import { SessionsPage } from "./pages/SessionsPage";
import { SessionDetailPage } from "./pages/SessionDetailPage";
import { AskAiPage } from "./pages/AskAiPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/sessions" replace />} />
        <Route
          path="/capture"
          element={<Navigate to="/capture/live" replace />}
        />
        <Route path="/capture/live" element={<CapturePage mode="live" />} />
        <Route
          path="/capture/recorder"
          element={<CapturePage mode="recorder" />}
        />
        <Route
          path="/capture/meeting"
          element={<CapturePage mode="meeting" />}
        />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/sessions/:id" element={<SessionDetailPage />} />
        <Route path="/ask" element={<AskAiPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/connections" element={<ConnectionsPage />} />
        <Route path="*" element={<Navigate to="/sessions" replace />} />
      </Route>
    </Routes>
  );
}
