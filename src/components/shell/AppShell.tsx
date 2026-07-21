/**
 * AppShell — layout route wrapping every page: fixed 248px sidebar on
 * desktop, slide-over drawer behind a hamburger below the md breakpoint
 * (user decision: one nav structure), topbar, scrollable outlet, globally
 * mounted CommandPalette + Update/Install banners.
 *
 * Renders fully offline: nothing here awaits a fetch.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { UpdateBanner } from "./UpdateBanner";
import { InstallBanner } from "./InstallBanner";
import { CloseIcon } from "./shellIcons";
import {
  CommandPaletteProvider,
  useCommandPalette,
} from "../palette/useCommandPalette";
import { CommandPalette } from "../palette/CommandPalette";

function MobileDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Keep focus inside the drawer while open.
    const panel = panelRef.current;
    panel?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", trap);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <div
        className="absolute inset-0 bg-[#020617]/70 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col border-r border-[#1e293b] bg-[#0b1220] shadow-2xl outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="absolute right-3 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:text-slate-300"
        >
          <CloseIcon width={16} height={16} />
        </button>
        <Sidebar onNavigate={onClose} />
      </div>
    </div>
  );
}

function ShellInner() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { open } = useCommandPalette();
  const { pathname } = useLocation();

  // Close the drawer on any route change (belt-and-braces with onNavigate).
  useEffect(() => setDrawerOpen(false), [pathname]);

  const openPalette = useCallback(() => open(), [open]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1440px]">
      {/* desktop sidebar rail */}
      <aside className="hidden w-[248px] shrink-0 border-r border-[#1e293b] bg-[#0f172a]/45 md:block">
        <div className="sticky top-0 h-dvh">
          <Sidebar />
        </div>
      </aside>

      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          onOpenMenu={() => setDrawerOpen(true)}
          onOpenPalette={openPalette}
        />
        <UpdateBanner />
        <InstallBanner />
        <main className="flex flex-1 flex-col overflow-y-auto px-4 pb-8 pt-4 md:px-7 md:pt-[18px]">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}

export function AppShell() {
  return (
    <CommandPaletteProvider>
      <ShellInner />
    </CommandPaletteProvider>
  );
}
