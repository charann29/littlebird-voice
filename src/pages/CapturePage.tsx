/**
 * CapturePage — segmented control hosting the v1 capture components
 * unchanged: Live (useSoniox), Recorder (useRecorder/useRecordings), and
 * Meeting (section 40's MeetingCapture). The mode is the route
 * (/capture/live | /capture/recorder | /capture/meeting) so deep links and
 * the v1 offline hint (live → recorder) keep working.
 */
import { NavLink, useNavigate } from "react-router";
import { LiveTranscription } from "../components/LiveTranscription";
import { Recorder } from "../components/Recorder";
import { MeetingCapture } from "../components/MeetingCapture";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { MicIcon } from "../components/icons";

export type CaptureMode = "live" | "recorder" | "meeting";

function ModeTab({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      replace
      className={({ isActive }) =>
        [
          "flex-1 rounded-xl px-3 py-2 text-center text-sm font-semibold no-underline transition-colors",
          isActive
            ? "bg-indigo-600 text-white"
            : "text-slate-400 hover:text-slate-200",
        ].join(" ")
      }
    >
      {label}
    </NavLink>
  );
}

export function CapturePage({ mode }: { mode: CaptureMode }) {
  const online = useOnlineStatus();
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
      <nav
        aria-label="Capture mode"
        className="flex gap-1 rounded-2xl border border-slate-800 bg-slate-900/60 p-1"
      >
        <ModeTab to="/capture/live" label="Live" />
        <ModeTab to="/capture/recorder" label="Recorder" />
        <ModeTab to="/capture/meeting" label="Meeting" />
      </nav>

      <div className="mt-4 flex flex-1 flex-col">
        {mode === "live" && <LiveTranscription online={online} />}
        {mode === "recorder" && <Recorder />}
        {mode === "meeting" && <MeetingCapture />}
      </div>

      {/* v1 offline hint, kept: live view links to the offline recorder. */}
      {mode === "live" && !online && (
        <button
          onClick={() => navigate("/capture/recorder", { replace: true })}
          className="mt-3 flex items-center justify-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-300"
        >
          <MicIcon className="h-4 w-4" />
          You're offline — record here and transcribe later
        </button>
      )}
    </div>
  );
}
