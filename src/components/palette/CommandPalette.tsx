/**
 * CommandPalette — the ⌘K dialog: input row, grouped results (Ask AI →
 * Memory → Sessions → Actions), footer. Combobox/listbox a11y pattern with
 * active-descendant selection; focus trapped; Esc/scrim close; focus
 * restored to the previously-focused element on close.
 *
 * Data: section 30's useMemorySearch supplies semantic memory chunks +
 * keyword session matches when online. Until 30-T5 lands (or when offline)
 * the palette falls back to local substring filtering over the merged
 * sessions list, and the Memory group is replaced by a connectivity note.
 *
 * INTEGRATION POINT (section 30-T5): replace `useMemorySearchAdapter` below
 * with the real hook:
 *   import { useMemorySearch } from "../../hooks/useMemorySearch";
 * The adapter already exposes the same contract
 * ({ results, sessions, isLoading, disabled }).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { useCommandPalette } from "./useCommandPalette";
import {
  buildPaletteGroups,
  flattenPaletteGroups,
  movePaletteIndex,
  type MemoryResultLike,
  type PaletteItem,
} from "./paletteItems";
import { useSessionsIndex } from "../../hooks/useSessionsIndex";
import { useRecordings } from "../../hooks/useRecordings";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import type { SessionListItem } from "../../lib/mergeSessions";
import { MicIcon, SparklesIcon } from "../icons";
import { DatabaseIcon, SendIcon, UsersIcon } from "../shell/shellIcons";
import { StatusPill } from "../sessions/StatusPill";

interface MemorySearchState {
  results: MemoryResultLike[];
  sessions: { id: string; title: string; created_at: number }[];
  isLoading: boolean;
  /** True when semantic search is unavailable (offline / hook not landed). */
  disabled: boolean;
}

/**
 * Local-only stand-in for section 30's useMemorySearch: semantic search
 * disabled, no network. Swap for the real hook at integration (see header).
 */
function useMemorySearchAdapter(_query: string): MemorySearchState {
  return { results: [], sessions: [], isLoading: false, disabled: true };
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/** Substring-filter local sessions by title/transcript (offline fallback). */
function filterLocalSessions(
  items: SessionListItem[],
  transcripts: Map<string, string | null>,
  query: string,
): SessionListItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return items
    .filter((item) => {
      if (item.title.toLowerCase().includes(q)) return true;
      const transcript = transcripts.get(item.id);
      return Boolean(transcript && transcript.toLowerCase().includes(q));
    })
    .slice(0, 6);
}

function MarkedText({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-transparent font-bold text-indigo-200">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export function CommandPalette() {
  const { isOpen, initialQuery, close } = useCommandPalette();
  if (!isOpen) return null;
  return <PaletteDialog initialQuery={initialQuery} close={close} />;
}

function PaletteDialog({
  initialQuery,
  close,
}: {
  initialQuery: string;
  close: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const online = useOnlineStatus();
  const [query, setQuery] = useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<Element | null>(null);

  const { items: allSessions } = useSessionsIndex();
  const { recordings } = useRecordings();
  const memory = useMemorySearchAdapter(query);

  const transcripts = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const rec of recordings) map.set(rec.id, rec.transcript);
    return map;
  }, [recordings]);

  // Session matches: hook results when available, local filter otherwise.
  const sessionMatches = useMemo<SessionListItem[]>(() => {
    if (!memory.disabled && memory.sessions.length > 0) {
      const byId = new Map(allSessions.map((s) => [s.id, s]));
      return memory.sessions
        .map((s) => byId.get(s.id))
        .filter((s): s is SessionListItem => Boolean(s));
    }
    return filterLocalSessions(allSessions, transcripts, query);
  }, [memory.disabled, memory.sessions, allSessions, transcripts, query]);

  const currentSession = useMemo(() => {
    const match = location.pathname.match(/^\/sessions\/([^/]+)$/);
    if (!match) return null;
    const session = allSessions.find((s) => s.id === match[1]);
    return session ? { id: session.id, title: session.title } : null;
  }, [location.pathname, allSessions]);

  const groups = useMemo(
    () =>
      buildPaletteGroups({
        query,
        memoryResults: memory.disabled ? [] : memory.results,
        sessionMatches,
        recentSessions: allSessions,
        currentSession,
      }),
    [query, memory.disabled, memory.results, sessionMatches, allSessions, currentSession],
  );
  const flat = useMemo(() => flattenPaletteGroups(groups), [groups]);

  // Clamp/reset selection when the list changes.
  useEffect(() => {
    setSelectedIndex((prev) =>
      flat.length === 0 ? -1 : Math.min(Math.max(prev, 0), flat.length - 1),
    );
  }, [flat.length]);

  // Capture the trigger element, focus the input, lock body scroll.
  useEffect(() => {
    previousFocus.current = document.activeElement;
    inputRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      (previousFocus.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  // Keep the selected row visible.
  useEffect(() => {
    if (selectedIndex < 0) return;
    const el = listRef.current?.querySelector(`#palette-item-${selectedIndex}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const activate = useCallback(
    (item: PaletteItem) => {
      close();
      switch (item.kind) {
        case "ask":
          navigate(`/ask?q=${encodeURIComponent(item.query)}`);
          break;
        case "memory":
          navigate(`/sessions/${item.result.session_id ?? item.result.id}`, {
            state:
              item.result.start_ms !== null &&
              item.result.start_ms !== undefined
                ? { highlight: { start_ms: item.result.start_ms } }
                : undefined,
          });
          break;
        case "session":
          navigate(`/sessions/${item.session.id}`);
          break;
        case "action":
          navigate(item.to, { state: item.state });
          break;
      }
    },
    [close, navigate],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => movePaletteIndex(i, 1, flat.length));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => movePaletteIndex(i, -1, flat.length));
        break;
      case "Home":
        if (flat.length > 0) {
          e.preventDefault();
          setSelectedIndex(0);
        }
        break;
      case "End":
        if (flat.length > 0) {
          e.preventDefault();
          setSelectedIndex(flat.length - 1);
        }
        break;
      case "Enter": {
        e.preventDefault();
        const item = flat[selectedIndex];
        if (item) activate(item);
        break;
      }
      case "Tab":
        // Focus trap: the input is the only tabbable element.
        e.preventDefault();
        inputRef.current?.focus();
        break;
    }
  };

  const selectedId =
    selectedIndex >= 0 && flat[selectedIndex]
      ? `palette-item-${selectedIndex}`
      : undefined;

  let flatIndex = -1;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[#020617]/70 px-4 pb-10 pt-[9vh] backdrop-blur-[2px] motion-reduce:backdrop-blur-none"
      onClick={close}
      data-testid="palette-scrim"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and ask AI"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-[660px] overflow-hidden rounded-[20px] border border-[#334155] bg-[#0f172a]"
        style={{
          boxShadow:
            "0 40px 100px -20px rgba(0,0,0,.85), 0 0 0 1px rgba(79,70,229,.15)",
        }}
      >
        {/* input row */}
        <div className="flex items-center gap-3 border-b border-[#1e293b] px-4 py-4">
          <span
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[10px] text-white"
            style={{
              background: "linear-gradient(150deg, #4f46e5, #7c3aed)",
              boxShadow: "0 6px 16px -6px rgba(79,70,229,.7)",
            }}
            aria-hidden="true"
          >
            <SparklesIcon width={15} height={15} />
          </span>
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={selectedId}
            aria-label="Ask AI or search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Search sessions or ask AI…"
            className="min-w-0 flex-1 bg-transparent text-[15.5px] font-medium text-white outline-none placeholder:text-slate-600"
          />
          <kbd className="shrink-0 rounded-md border border-[#1e293b] bg-[#111a2e] px-1.5 py-0.5 font-sans text-[10.5px] font-bold text-slate-500">
            esc
          </kbd>
        </div>

        {/* body */}
        <div
          ref={listRef}
          role="listbox"
          id="palette-results"
          aria-label="Results"
          className="max-h-[520px] overflow-y-auto px-2 pb-2.5 pt-1.5"
        >
          {groups.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              Nothing matches. Try a different search.
            </p>
          )}
          {groups.map((group) => (
            <div key={group.label}>
              <div
                aria-hidden="true"
                className="flex items-center justify-between px-3 pb-1.5 pt-3 text-[10.5px] font-bold uppercase tracking-[.09em] text-slate-600"
              >
                {group.label}
                {group.hint && (
                  <span className="font-semibold normal-case tracking-normal">
                    {group.hint}
                  </span>
                )}
              </div>
              {group.items.map((item) => {
                flatIndex += 1;
                const index = flatIndex;
                const selected = index === selectedIndex;
                return (
                  <div
                    key={item.id}
                    id={`palette-item-${index}`}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => activate(item)}
                    className={[
                      "flex cursor-pointer items-start gap-3 rounded-[13px] px-3 py-2.5",
                      selected
                        ? "border border-indigo-500/35 bg-indigo-500/[0.14]"
                        : "border border-transparent hover:bg-slate-800/50",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "mt-px flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border",
                        selected
                          ? "border-indigo-500/40 bg-indigo-500/[0.18] text-indigo-200"
                          : "border-[#1e293b] bg-[#111a2e] text-slate-400",
                      ].join(" ")}
                    >
                      {item.kind === "ask" ? (
                        <SparklesIcon width={15} height={15} />
                      ) : item.kind === "memory" ? (
                        <DatabaseIcon width={15} height={15} />
                      ) : item.kind === "session" ? (
                        item.session.source === "mic" ? (
                          <MicIcon width={15} height={15} />
                        ) : (
                          <UsersIcon width={15} height={15} />
                        )
                      ) : (
                        <SendIcon width={15} height={15} />
                      )}
                    </span>

                    <div className="min-w-0 flex-1">
                      {item.kind === "ask" && (
                        <>
                          <div
                            className={`text-[13.5px] font-semibold ${selected ? "text-white" : "text-slate-300"}`}
                          >
                            Ask AI: “{item.query}”
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            Answer with citations from your sessions
                          </div>
                        </>
                      )}
                      {item.kind === "memory" && (
                        <>
                          <div
                            className={`line-clamp-2 text-[13.5px] font-semibold ${selected ? "text-white" : "text-slate-300"}`}
                          >
                            “{item.result.text}”
                          </div>
                          <div className="mt-0.5 truncate text-xs text-slate-500">
                            {[
                              item.result.speaker
                                ? `Speaker ${item.result.speaker}`
                                : null,
                              item.result.session_title,
                              item.result.created_at
                                ? new Date(
                                    item.result.created_at,
                                  ).toLocaleDateString([], {
                                    month: "short",
                                    day: "numeric",
                                  })
                                : null,
                              formatMs(item.result.start_ms) || null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </>
                      )}
                      {item.kind === "session" && (
                        <>
                          <div
                            className={`truncate text-[13.5px] font-semibold ${selected ? "text-white" : "text-slate-300"}`}
                          >
                            <MarkedText
                              text={item.session.title}
                              query={query}
                            />
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {new Date(
                              item.session.createdAt,
                            ).toLocaleDateString([], {
                              month: "short",
                              day: "numeric",
                            })}{" "}
                            · {formatMs(item.session.durationMs)}
                          </div>
                        </>
                      )}
                      {item.kind === "action" && (
                        <div
                          className={`text-[13.5px] font-semibold ${selected ? "text-white" : "text-slate-300"}`}
                        >
                          {item.label}
                        </div>
                      )}
                    </div>

                    <span className="mt-0.5 flex shrink-0 items-center gap-2">
                      {item.kind === "memory" && (
                        <span
                          data-testid={`relevance-${item.result.id}`}
                          className={[
                            "inline-flex items-center gap-1.5 text-[10.5px] font-bold tabular-nums",
                            item.result.display_score >= 0.9
                              ? "text-indigo-200"
                              : "text-slate-500",
                          ].join(" ")}
                        >
                          <span className="h-1 w-11 overflow-hidden rounded-sm bg-[#111a2e]">
                            <i
                              className="block h-full rounded-sm bg-gradient-to-r from-indigo-600 to-indigo-500"
                              style={{
                                width: `${item.result.display_score * 100}%`,
                              }}
                            />
                          </span>
                          {item.result.display_score.toFixed(2)}
                        </span>
                      )}
                      {item.kind === "session" && (
                        <StatusPill
                          status={item.session.status}
                          hasSummary={item.session.hasSummary}
                        />
                      )}
                      {(item.kind === "ask" || item.kind === "action") &&
                        selected && (
                          <kbd className="rounded-md border border-[#1e293b] bg-[#0f172a] px-1.5 py-0.5 font-sans text-[10.5px] font-bold text-slate-500">
                            ↵
                          </kbd>
                        )}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}

          {memory.isLoading && (
            <div aria-hidden="true" className="px-3 py-2">
              <div className="mb-2 h-10 animate-pulse rounded-xl bg-[#111a2e]" />
              <div className="h-10 animate-pulse rounded-xl bg-[#111a2e]" />
            </div>
          )}

          {query.trim() && memory.disabled && (
            <p className="px-3 pb-1.5 pt-3 text-xs text-slate-500">
              Semantic search needs a connection — showing local matches only.
            </p>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center gap-4 border-t border-[#1e293b] bg-[#111a2e]/50 px-4 py-2.5 text-[11px] font-semibold text-slate-500">
          <span>
            <kbd className="mr-1 rounded border border-[#1e293b] bg-[#0f172a] px-1 py-px font-sans text-[10px] font-bold text-slate-400">
              ↑↓
            </kbd>
            navigate
          </span>
          <span>
            <kbd className="mr-1 rounded border border-[#1e293b] bg-[#0f172a] px-1 py-px font-sans text-[10px] font-bold text-slate-400">
              ↵
            </kbd>
            open
          </span>
          {(!online || memory.disabled) && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-amber-400">
              Searches your synced sessions · requires connection
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
