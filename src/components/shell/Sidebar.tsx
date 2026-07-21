/**
 * Sidebar — the persistent workspace navigation per the approved
 * shell-sessions mockup. MVP nav only: Capture (button), Workspace→Sessions,
 * Assistant→Ask AI, System→Integrations + Settings & Privacy. No other nav
 * items are rendered (grayed-out placeholders are deliberately omitted).
 *
 * The same content renders in the fixed desktop rail and inside the mobile
 * slide-over drawer (AppShell owns the drawer chrome).
 */
import { NavLink, useNavigate } from "react-router";
import { useRecordings } from "../../hooks/useRecordings";
import { BrandLogo } from "./BrandLogo";
import { MicIcon } from "../icons";
import {
  CheckSmallIcon,
  ListIcon,
  PlugIcon,
  ShieldIcon,
} from "./shellIcons";
import { SparklesIcon } from "../icons";
import type { ReactNode } from "react";

function NavItem({
  to,
  end,
  icon,
  label,
  trailing,
  onNavigate,
}: {
  to: string;
  end?: boolean;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        [
          "mb-px flex items-center gap-2.5 rounded-[11px] px-3 py-2 text-[13.5px] font-semibold no-underline",
          isActive
            ? "border border-indigo-500/35 bg-indigo-500/15 text-indigo-200"
            : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-300",
        ].join(" ")
      }
    >
      <span className="shrink-0">{icon}</span>
      {label}
      {trailing}
    </NavLink>
  );
}

function GroupHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1.5 text-[10.5px] font-bold uppercase tracking-[.09em] text-slate-600">
      {children}
    </div>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { recordings } = useRecordings();
  const total = recordings.length;
  const pendingCount = recordings.filter((r) => r.status === "pending").length;

  return (
    <div className="flex h-full flex-col px-3.5 pb-4 pt-5">
      {/* brand */}
      <div className="flex items-center gap-2.5 px-2 pb-1">
        <BrandLogo />
        <div>
          <h1 className="text-[15px] font-bold tracking-tight text-white">
            littlebird-voice
          </h1>
          <p className="mt-px text-[10.5px] text-slate-500">
            Your meetings, remembered
          </p>
        </div>
      </div>

      {/* capture button */}
      <button
        type="button"
        onClick={() => {
          onNavigate?.();
          navigate("/capture");
        }}
        className="mx-1 mb-1.5 mt-4 flex items-center justify-center gap-2 rounded-[13px] px-3.5 py-2.5 text-[13.5px] font-bold text-white hover:brightness-110"
        style={{
          background: "linear-gradient(160deg, #6366f1, #4f46e5)",
          boxShadow: "0 8px 20px -6px rgba(79,70,229,.6)",
        }}
      >
        <MicIcon width={15} height={15} />
        Capture
      </button>

      <nav className="mt-4" aria-label="Workspace">
        <GroupHeader>Workspace</GroupHeader>
        <NavItem
          to="/sessions"
          icon={<ListIcon width={16} height={16} />}
          label="Sessions"
          onNavigate={onNavigate}
          trailing={
            <span className="ml-auto flex items-center gap-1.5">
              {pendingCount > 0 && (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-[7px] py-px text-[11px] font-bold text-amber-300">
                  {pendingCount}
                </span>
              )}
              <span className="rounded-full border border-[#1e293b] bg-[#111a2e] px-[7px] py-px text-[11px] font-bold text-slate-500">
                {total}
              </span>
            </span>
          }
        />
      </nav>

      <nav className="mt-4" aria-label="Assistant">
        <GroupHeader>Assistant</GroupHeader>
        <NavItem
          to="/ask"
          icon={<SparklesIcon width={16} height={16} />}
          label="Ask AI"
          onNavigate={onNavigate}
          trailing={
            <kbd className="ml-auto rounded-md border border-[#1e293b] bg-[#0f172a] px-1.5 py-px font-sans text-[10.5px] font-semibold text-slate-500">
              ⌘K
            </kbd>
          }
        />
      </nav>

      <nav className="mt-4" aria-label="System">
        <GroupHeader>System</GroupHeader>
        <NavItem
          to="/settings/connections"
          icon={<PlugIcon width={16} height={16} />}
          label="Integrations"
          onNavigate={onNavigate}
        />
        <NavItem
          to="/settings"
          end
          icon={<ShieldIcon width={16} height={16} />}
          label="Settings & Privacy"
          onNavigate={onNavigate}
        />
      </nav>

      {/* offline-first footer card */}
      <div className="mt-auto px-1">
        <div className="rounded-[14px] border border-[#1e293b] bg-[#0f172a] px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300">
            <CheckSmallIcon width={13} height={13} className="text-green-400" />
            Offline-first
          </div>
          <div className="mt-1 text-[11px] leading-relaxed text-slate-500">
            {total === 0
              ? "Capture works without a connection."
              : `${total} session${total === 1 ? "" : "s"} cached on this device. Capture works without a connection.`}
          </div>
        </div>
      </div>
    </div>
  );
}
