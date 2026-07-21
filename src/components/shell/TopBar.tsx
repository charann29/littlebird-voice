/**
 * TopBar — route title, ⌘K searchbox-as-button, OnlineBadge (unchanged v1
 * component), and the hamburger that opens the mobile nav drawer.
 */
import { useLocation } from "react-router";
import { OnlineBadge } from "../OnlineBadge";
import { MenuIcon, SearchIcon } from "./shellIcons";

function routeTitle(pathname: string): string {
  if (pathname.startsWith("/capture")) return "Capture";
  if (pathname.startsWith("/sessions/")) return "Session";
  if (pathname.startsWith("/sessions")) return "Sessions";
  if (pathname.startsWith("/ask")) return "Ask AI";
  if (pathname.startsWith("/settings/connections")) return "Integrations";
  if (pathname.startsWith("/settings")) return "Settings & Privacy";
  return "littlebird-voice";
}

export function TopBar({
  onOpenMenu,
  onOpenPalette,
}: {
  onOpenMenu: () => void;
  onOpenPalette: () => void;
}) {
  const { pathname } = useLocation();

  return (
    <div className="flex items-center gap-3.5 border-b border-[#1e293b] px-4 pb-3.5 pt-4 md:px-7 md:pt-[18px]">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open navigation"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border border-[#1e293b] bg-[#0f172a] text-slate-400 hover:text-slate-200 md:hidden"
      >
        <MenuIcon width={17} height={17} />
      </button>

      <h2 className="text-[19px] font-bold tracking-tight text-white">
        {routeTitle(pathname)}
      </h2>

      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Search or ask AI"
        className="ml-2 hidden max-w-[420px] flex-1 items-center gap-2 rounded-xl border border-[#1e293b] bg-[#0f172a] px-3 py-2 text-[13px] text-slate-500 hover:border-[#334155] sm:flex"
      >
        <SearchIcon width={14} height={14} />
        Search sessions or ask AI…
        <kbd className="ml-auto rounded-md border border-[#1e293b] bg-[#111a2e] px-1.5 py-px font-sans text-[10.5px] font-semibold text-slate-500">
          ⌘K
        </kbd>
      </button>
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Search or ask AI"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border border-[#1e293b] bg-[#0f172a] text-slate-400 hover:text-slate-200 sm:hidden"
      >
        <SearchIcon width={15} height={15} />
      </button>

      <span className="ml-auto shrink-0">
        <OnlineBadge />
      </span>
    </div>
  );
}
