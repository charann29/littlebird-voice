import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { registerSW } from "virtual:pwa-register";

// Prompt-based SW registration. We deliberately do NOT auto-reload: an update
// that reloads mid-recording would lose unsaved audio. The App surfaces the
// update via a banner and only applies it on explicit user action.
const updateSW = registerSW({
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent("pwa:need-refresh"));
  },
});

// App listens for a user-confirmed refresh and calls this.
window.addEventListener("pwa:apply-update", () => {
  void updateSW(true);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
