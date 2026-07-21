/**
 * SessionDetailPage — /sessions/:id two-column detail per the mockup:
 * header (back, inline-rename title, meta, status pill, copy, delete),
 * left = TranscriptPane + AudioPlayer (local blob), right =
 * SessionDetailTabs (section 20's AI panes). Server-only rows are read-only
 * metadata + server transcript; the audio player is replaced by a note.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useSessionDetail } from "../hooks/useSessionDetail";
import { useRecordings } from "../hooks/useRecordings";
import { apiFetch, getApiToken } from "../lib/api";
import {
  resolveSegments,
  segmentsToPlainText,
  TranscriptPane,
} from "../components/session/TranscriptPane";
import { AudioPlayer } from "../components/session/AudioPlayer";
import {
  SessionDetailTabs,
  type DetailTab,
} from "../components/session/SessionDetailTabs";
import { StatusPill } from "../components/sessions/StatusPill";
import { defaultTitle } from "../lib/mergeSessions";
import { SOURCE_LABEL } from "../components/sessions/SessionRow";
import { ArrowLeftIcon } from "../components/shell/shellIcons";
import { CheckIcon, CopyIcon, TrashIcon } from "../components/icons";
import type { SessionSource, SessionStatus } from "../lib/api-types";

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface LocationState {
  highlight?: { start_ms: number };
  tab?: DetailTab;
}

export function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as LocationState;

  const detail = useSessionDetail(id);
  const { recordings, stages, activeIds, transcribeOne, remove } =
    useRecordings();

  // Prefer the reactive context row over the one-shot DB read so status
  // flips (transcribing → done) re-render live.
  const localLive = useMemo(
    () => recordings.find((r) => r.id === id) ?? detail.local,
    [recordings, id, detail.local],
  );

  const serverMeta = detail.server?.session ?? null;
  const isLocal = Boolean(localLive);

  const status: SessionStatus =
    localLive?.status ?? serverMeta?.status ?? "pending";
  const source: SessionSource = serverMeta?.source ?? "mic";
  const createdAt = localLive?.createdAt ?? serverMeta?.created_at ?? 0;
  const durationMs = localLive?.durationMs ?? serverMeta?.duration_ms ?? 0;
  const fallbackTitle = createdAt ? defaultTitle(createdAt) : "Session";
  const serverTitle = serverMeta?.title || null;

  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [savedTitle, setSavedTitle] = useState<string | null>(null);
  const title = savedTitle ?? serverTitle ?? fallbackTitle;

  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [id]);

  const segments = useMemo(
    () => resolveSegments(localLive ?? null, detail.server?.segments ?? null),
    [localLive, detail.server],
  );

  if (!id || detail.notFound) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-[#1e293b] bg-[#0f172a] px-6 py-12 text-center">
        <p className="text-sm font-semibold text-slate-300">
          Session not found
        </p>
        <p className="text-[13px] text-slate-500">
          It may have been deleted, or never synced to this device.
        </p>
        <Link
          to="/sessions"
          className="mt-1 rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white no-underline hover:bg-indigo-500"
        >
          Back to Sessions
        </Link>
      </div>
    );
  }

  const commitRename = async () => {
    const value = titleDraft?.trim();
    setTitleDraft(null);
    if (!value || value === title) return;
    setSavedTitle(value);
    // Rename persists server-side when a server row exists (PATCH).
    if (serverMeta && getApiToken()) {
      try {
        await apiFetch(`/sessions/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: value }),
        });
      } catch {
        /* best-effort; local display keeps the new title */
      }
    }
  };

  const copyTranscript = async () => {
    if (!segments) return;
    try {
      await navigator.clipboard.writeText(segmentsToPlainText(segments));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const doDelete = async () => {
    if (isLocal) {
      // remove() also enqueues the remote-delete tombstone.
      await remove(id);
    } else if (getApiToken()) {
      // Server-only row: delete directly.
      try {
        await apiFetch(`/sessions/${id}`, { method: "DELETE" });
      } catch {
        /* 404 = already gone */
      }
    }
    navigate("/sessions");
  };

  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/sessions");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[#1e293b] pb-4">
        <button
          type="button"
          onClick={goBack}
          aria-label="Back"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border border-[#1e293b] bg-[#0f172a] text-slate-400 hover:text-slate-200"
        >
          <ArrowLeftIcon width={16} height={16} />
        </button>

        <div className="min-w-0 flex-1">
          {titleDraft !== null ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setTitleDraft(null);
              }}
              aria-label="Session title"
              className="w-full rounded-lg border border-indigo-500/50 bg-slate-900 px-2 py-1 text-[17px] font-bold text-white outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setTitleDraft(title)}
              title="Rename"
              className="block max-w-full truncate text-left text-[17px] font-bold tracking-tight text-white hover:text-indigo-200"
            >
              {title}
            </button>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#334155] bg-[#111a2e] px-2 py-0.5 text-[10.5px] font-bold text-slate-400">
              {SOURCE_LABEL[source]}
            </span>
            {createdAt > 0 && (
              <span>
                {new Date(createdAt).toLocaleDateString([], {
                  month: "short",
                  day: "numeric",
                })}{" "}
                · {formatDuration(durationMs)}
              </span>
            )}
          </div>
        </div>

        <StatusPill status={status} stage={id ? stages[id] : undefined} />

        {segments && (
          <button
            type="button"
            onClick={() => void copyTranscript()}
            className="inline-flex items-center gap-1.5 rounded-[11px] border border-[#1e293b] bg-[#0f172a] px-3 py-2 text-[12.5px] font-bold text-slate-300 hover:border-[#334155]"
          >
            {copied ? (
              <CheckIcon width={13} height={13} />
            ) : (
              <CopyIcon width={13} height={13} />
            )}
            {copied ? "Copied" : "Copy"}
          </button>
        )}

        {confirmDelete ? (
          <span className="inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void doDelete()}
              className="rounded-[11px] bg-red-600 px-3 py-2 text-[12.5px] font-bold text-white hover:bg-red-500"
            >
              Confirm delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded-[11px] px-2 py-2 text-[12.5px] font-bold text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label="Delete session"
            className="inline-flex items-center gap-1.5 rounded-[11px] border border-[#1e293b] bg-[#0f172a] px-3 py-2 text-[12.5px] font-bold text-slate-400 hover:border-red-500/40 hover:text-red-300"
          >
            <TrashIcon width={14} height={14} />
          </button>
        )}
      </div>

      {/* two columns (stack on small screens) */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 pt-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col">
          {localLive?.blob ? (
            <AudioPlayer blob={localLive.blob} durationMs={durationMs} />
          ) : (
            <div className="mb-4 rounded-[14px] border border-[#1e293b] bg-[#0f172a] px-3.5 py-3 text-[12.5px] text-slate-500">
              Audio stays on the device that recorded it.
            </div>
          )}
          <TranscriptPane
            segments={segments}
            status={status}
            error={localLive?.error ?? serverMeta?.error}
            highlight={state.highlight ?? null}
            onRetry={
              localLive && !activeIds.includes(id)
                ? () => void transcribeOne(id)
                : undefined
            }
          />
        </div>

        <div className="flex min-w-0 flex-col lg:border-l lg:border-[#1e293b] lg:pl-6">
          <SessionDetailTabs sessionId={id} initialTab={state.tab} />
        </div>
      </div>
    </div>
  );
}
