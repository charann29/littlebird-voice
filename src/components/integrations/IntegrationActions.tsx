/**
 * Reusable integration action controls (section 40 client slice).
 *
 * Each control is self-contained (own busy/success/error state), talks only
 * to the Worker action endpoints via integrations-api (provider tokens never
 * reach the browser), and degrades gracefully:
 * - offline → the trigger button is disabled with a hint;
 * - `not_connected` / `reconnect_required` errors → inline note linking to
 *   Settings → Connections instead of a dead-end failure.
 *
 * Embedding contract (session views — FollowUpDraft, SummaryPanel — embed
 * these directly):
 *   <GmailSendControl body={draft} sessionId={id} />
 *   <SlackPostControl text={summaryText} />
 *   <NotionExportControl defaultTitle="…" summary={…} actionItems={…} />
 * When a content prop (`body` / `text` / `summary`) is omitted — the
 * Connections settings usage — the control renders its own textarea.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../lib/api";
import {
  exportToNotion,
  importNotionPages,
  integrationErrorMessage,
  listCalendarEvents,
  listNotionDatabases,
  listSlackChannels,
  postToSlack,
  searchNotionPages,
  sendGmail,
  type CalendarEvent,
  type NotionDatabase,
  type NotionPage,
  type SlackChannel,
} from "../../lib/integrations-api";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import type { SummaryV1 } from "../../lib/ai-types";
import { AlertIcon, CheckIcon, RefreshIcon, SpinnerIcon } from "../icons";
import { SendIcon } from "../shell/shellIcons";

type Phase = "idle" | "busy" | "done" | "error";

// ---- shared bits ----------------------------------------------------------

const triggerBtn =
  "inline-flex items-center gap-1.5 rounded-[11px] border border-[#1e293b] bg-[#0f172a] px-3 py-2 text-[12.5px] font-bold text-slate-300 hover:border-[#334155] disabled:cursor-not-allowed disabled:opacity-50";
const primaryBtn =
  "inline-flex items-center gap-1.5 rounded-[11px] bg-indigo-600 px-3.5 py-2 text-[12.5px] font-bold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50";
const fieldInput =
  "w-full rounded-[11px] border border-[#1e293b] bg-[#111a2e] px-3 py-2 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-indigo-500/60 focus:outline-none";
const panelBox =
  "flex w-full flex-col gap-2.5 rounded-[13px] border border-[#1e293b] bg-[#0f172a] px-3.5 py-3";

function isConnectionProblem(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === "not_connected" || err.code === "reconnect_required")
  );
}

function ActionErrorNote({ err }: { err: unknown }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-[11px] border border-red-500/30 bg-red-500/[.07] px-3 py-2.5"
    >
      <span className="mt-0.5 shrink-0 text-red-400">
        <AlertIcon width={13} height={13} />
      </span>
      <p className="min-w-0 text-[12.5px] leading-snug text-red-200">
        {integrationErrorMessage(err)}
        {isConnectionProblem(err) && (
          <>
            {" "}
            <Link
              to="/settings/connections"
              className="font-bold text-red-100 underline"
            >
              Open Connections
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

function SuccessNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-green-400"
    >
      <CheckIcon width={13} height={13} />
      {children}
    </p>
  );
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-bold uppercase tracking-[.08em] text-slate-500">
      {children}
    </span>
  );
}

// ---- Google Calendar: upcoming events -------------------------------------

/** Upcoming Google Calendar events (next `days` days), with refresh. */
export function CalendarUpcomingEvents({ days = 7 }: { days?: number }) {
  const online = useOnlineStatus();
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setPhase("busy");
    setError(null);
    try {
      const res = await listCalendarEvents(days);
      setEvents(res?.events ?? []);
      setPhase("done");
    } catch (err) {
      setError(err);
      setPhase("error");
    }
  }, [days]);

  useEffect(() => {
    if (online) void load();
  }, [online, load]);

  if (!online) {
    return (
      <p className="text-[12.5px] text-slate-500">
        You're offline — upcoming events will load when you're back online.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="calendar-events">
      <div className="flex items-center justify-between">
        <PanelLabel>Next {days} days</PanelLabel>
        <button
          type="button"
          onClick={() => void load()}
          disabled={phase === "busy"}
          aria-label="Refresh events"
          className="rounded-[9px] border border-[#1e293b] p-1.5 text-slate-400 hover:border-[#334155] hover:text-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === "busy" ? (
            <SpinnerIcon width={12} height={12} />
          ) : (
            <RefreshIcon width={12} height={12} />
          )}
        </button>
      </div>

      {phase === "error" && <ActionErrorNote err={error} />}

      {phase === "busy" && events === null && (
        <p className="flex items-center gap-2 text-[12.5px] text-slate-500">
          <SpinnerIcon width={12} height={12} /> Loading events…
        </p>
      )}

      {events !== null && events.length === 0 && phase !== "error" && (
        <p className="text-[12.5px] text-slate-600">
          No events in the next {days} days.
        </p>
      )}

      {events !== null && events.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {events.map((e) => (
            <li
              key={e.id}
              className="rounded-[11px] border border-[#1e293b] bg-[#111a2e] px-3 py-2"
            >
              <p className="text-[13px] font-semibold leading-snug text-slate-200">
                {e.title || "(untitled event)"}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-slate-500">
                <span>
                  {new Date(e.startsAt).toLocaleString([], {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                {e.attendees.length > 0 && (
                  <span>
                    · {e.attendees.length} attendee
                    {e.attendees.length === 1 ? "" : "s"}
                  </span>
                )}
                {e.meetLink && (
                  <a
                    href={e.meetLink}
                    target="_blank"
                    rel="noreferrer"
                    className="font-bold text-indigo-300 hover:text-indigo-200"
                  >
                    Join
                  </a>
                )}
                <a
                  href={e.htmlLink}
                  target="_blank"
                  rel="noreferrer"
                  className="font-bold text-slate-400 hover:text-slate-300"
                >
                  Open
                </a>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Gmail: send -----------------------------------------------------------

export interface GmailSendControlProps {
  /** Fixed message body (e.g. the follow-up draft). Omit for a textarea. */
  body?: string;
  /** Initial subject line. */
  subject?: string;
  sessionId?: string;
  defaultOpen?: boolean;
}

/** "Send via Gmail" — recipients + subject (+ body when not provided). */
export function GmailSendControl({
  body,
  subject: initialSubject = "",
  sessionId,
  defaultOpen = false,
}: GmailSendControlProps) {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(defaultOpen);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(initialSubject);
  const [bodyDraft, setBodyDraft] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<unknown>(null);

  const effectiveBody = body ?? bodyDraft;
  const recipients = to
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const canSend =
    online &&
    phase !== "busy" &&
    recipients.length > 0 &&
    Boolean(subject.trim()) &&
    Boolean(effectiveBody.trim());

  const send = async () => {
    setPhase("busy");
    setError(null);
    try {
      await sendGmail({
        to: recipients,
        subject: subject.trim(),
        bodyText: effectiveBody,
        ...(sessionId ? { sessionId } : {}),
      });
      setPhase("done");
    } catch (err) {
      setError(err);
      setPhase("error");
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!online}
        title={online ? undefined : "You're offline"}
        className={triggerBtn}
      >
        <SendIcon width={13} height={13} />
        Send via Gmail
      </button>
    );
  }

  return (
    <div className={panelBox} data-testid="gmail-send-panel">
      <PanelLabel>Send via Gmail</PanelLabel>

      {phase === "done" ? (
        <div className="flex items-center justify-between gap-2">
          <SuccessNote>Email sent</SuccessNote>
          <button
            type="button"
            onClick={() => {
              setPhase("idle");
              setOpen(false);
            }}
            className={triggerBtn}
          >
            Done
          </button>
        </div>
      ) : (
        <>
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="To — comma-separated addresses"
            aria-label="Recipients"
            className={fieldInput}
          />
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            aria-label="Subject"
            className={fieldInput}
          />
          {body === undefined && (
            <textarea
              value={bodyDraft}
              onChange={(e) => setBodyDraft(e.target.value)}
              rows={5}
              placeholder="Message body"
              aria-label="Message body"
              className={`${fieldInput} resize-y`}
            />
          )}

          {phase === "error" && <ActionErrorNote err={error} />}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void send()}
              disabled={!canSend}
              className={primaryBtn}
            >
              {phase === "busy" ? (
                <SpinnerIcon width={13} height={13} />
              ) : (
                <SendIcon width={13} height={13} />
              )}
              {phase === "busy" ? "Sending…" : "Send"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={triggerBtn}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Flatten a SummaryV1 into `{ summary, actionItems }` for Notion export. */
export function summaryToNotionExport(summary: SummaryV1): {
  summary: string;
  actionItems: string[];
} {
  const parts = [summary.overview];
  if (summary.decisions.length > 0) {
    parts.push("Decisions:\n" + summary.decisions.map((d) => `• ${d}`).join("\n"));
  }
  if (summary.risks_open_questions.length > 0) {
    parts.push(
      "Risks & open questions:\n" +
        summary.risks_open_questions.map((r) => `• ${r}`).join("\n"),
    );
  }
  return {
    summary: parts.join("\n\n"),
    actionItems: summary.action_items.map((a) =>
      [a.text, a.owner && `(${a.owner})`, a.due && `— due ${a.due}`]
        .filter(Boolean)
        .join(" "),
    ),
  };
}

// ---- Slack: channel picker + post ------------------------------------------

export interface SlackPostControlProps {
  /** Fixed message text (e.g. summary). Omit for a textarea. */
  text?: string;
  defaultOpen?: boolean;
}

/** "Post to Slack" — channel picker fed by /slack/channels + post. */
export function SlackPostControl({
  text,
  defaultOpen = false,
}: SlackPostControlProps) {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(defaultOpen);
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [channelsError, setChannelsError] = useState<unknown>(null);
  const [channelId, setChannelId] = useState("");
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<unknown>(null);

  const effectiveText = text ?? message;

  useEffect(() => {
    if (!open || channels !== null || !navigator.onLine) return;
    let cancelled = false;
    listSlackChannels()
      .then((res) => {
        if (cancelled) return;
        const list = res?.channels ?? [];
        setChannels(list);
        if (list.length > 0) setChannelId((id) => id || list[0].id);
      })
      .catch((err) => {
        if (!cancelled) setChannelsError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [open, channels]);

  const post = async () => {
    setPhase("busy");
    setError(null);
    try {
      await postToSlack(channelId, effectiveText);
      setPhase("done");
    } catch (err) {
      setError(err);
      setPhase("error");
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!online}
        title={online ? undefined : "You're offline"}
        className={triggerBtn}
      >
        <SendIcon width={13} height={13} />
        Post to Slack
      </button>
    );
  }

  const postedChannel = channels?.find((c) => c.id === channelId);

  return (
    <div className={panelBox} data-testid="slack-post-panel">
      <PanelLabel>Post to Slack</PanelLabel>

      {phase === "done" ? (
        <div className="flex items-center justify-between gap-2">
          <SuccessNote>
            Posted{postedChannel ? ` to #${postedChannel.name}` : ""}
          </SuccessNote>
          <button
            type="button"
            onClick={() => {
              setPhase("idle");
              setOpen(false);
            }}
            className={triggerBtn}
          >
            Done
          </button>
        </div>
      ) : (
        <>
          {channelsError !== null ? (
            <ActionErrorNote err={channelsError} />
          ) : channels === null ? (
            <p className="flex items-center gap-2 text-[12.5px] text-slate-500">
              <SpinnerIcon width={12} height={12} /> Loading channels…
            </p>
          ) : channels.length === 0 ? (
            <p className="text-[12.5px] text-slate-600">
              No channels available — invite the bot to a channel first.
            </p>
          ) : (
            <select
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              aria-label="Slack channel"
              className={fieldInput}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          )}

          {text === undefined && (
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Message"
              aria-label="Slack message"
              className={`${fieldInput} resize-y`}
            />
          )}

          {phase === "error" && <ActionErrorNote err={error} />}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void post()}
              disabled={
                !online ||
                phase === "busy" ||
                !channelId ||
                !effectiveText.trim()
              }
              className={primaryBtn}
            >
              {phase === "busy" ? (
                <SpinnerIcon width={13} height={13} />
              ) : (
                <SendIcon width={13} height={13} />
              )}
              {phase === "busy" ? "Posting…" : "Post"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={triggerBtn}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Notion: export summary -------------------------------------------------

export interface NotionExportControlProps {
  /** Fixed summary text (e.g. flattened SummaryV1). Omit for a textarea. */
  summary?: string;
  actionItems?: string[];
  defaultTitle?: string;
  sessionId?: string;
  defaultOpen?: boolean;
}

/** "Export to Notion" — database picker + page create. */
export function NotionExportControl({
  summary,
  actionItems = [],
  defaultTitle = "",
  sessionId,
  defaultOpen = false,
}: NotionExportControlProps) {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(defaultOpen);
  const [databases, setDatabases] = useState<NotionDatabase[] | null>(null);
  const [databasesError, setDatabasesError] = useState<unknown>(null);
  const [databaseId, setDatabaseId] = useState("");
  const [title, setTitle] = useState(defaultTitle);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<unknown>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);

  const effectiveSummary = summary ?? summaryDraft;

  useEffect(() => {
    if (!open || databases !== null || !navigator.onLine) return;
    let cancelled = false;
    listNotionDatabases()
      .then((res) => {
        if (cancelled) return;
        const list = res?.databases ?? [];
        setDatabases(list);
        if (list.length > 0) setDatabaseId((id) => id || list[0].id);
      })
      .catch((err) => {
        if (!cancelled) setDatabasesError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [open, databases]);

  const exportPage = async () => {
    setPhase("busy");
    setError(null);
    try {
      const res = await exportToNotion({
        databaseId,
        title: title.trim(),
        summary: effectiveSummary,
        actionItems,
        ...(sessionId ? { sessionId } : {}),
      });
      setPageUrl(res?.url ?? null);
      setPhase("done");
    } catch (err) {
      setError(err);
      setPhase("error");
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!online}
        title={online ? undefined : "You're offline"}
        className={triggerBtn}
      >
        <SendIcon width={13} height={13} />
        Export to Notion
      </button>
    );
  }

  return (
    <div className={panelBox} data-testid="notion-export-panel">
      <PanelLabel>Export to Notion</PanelLabel>

      {phase === "done" ? (
        <div className="flex items-center justify-between gap-2">
          <SuccessNote>
            Page created
            {pageUrl && (
              <>
                {" — "}
                <a
                  href={pageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-bold text-green-300 underline"
                >
                  open in Notion
                </a>
              </>
            )}
          </SuccessNote>
          <button
            type="button"
            onClick={() => {
              setPhase("idle");
              setOpen(false);
            }}
            className={triggerBtn}
          >
            Done
          </button>
        </div>
      ) : (
        <>
          {databasesError !== null ? (
            <ActionErrorNote err={databasesError} />
          ) : databases === null ? (
            <p className="flex items-center gap-2 text-[12.5px] text-slate-500">
              <SpinnerIcon width={12} height={12} /> Loading databases…
            </p>
          ) : databases.length === 0 ? (
            <p className="text-[12.5px] text-slate-600">
              No databases shared with the integration — share one in Notion
              first.
            </p>
          ) : (
            <select
              value={databaseId}
              onChange={(e) => setDatabaseId(e.target.value)}
              aria-label="Notion database"
              className={fieldInput}
            >
              {databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          )}

          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Page title"
            aria-label="Page title"
            className={fieldInput}
          />

          {summary === undefined && (
            <textarea
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              rows={4}
              placeholder="Summary text"
              aria-label="Summary text"
              className={`${fieldInput} resize-y`}
            />
          )}

          {phase === "error" && <ActionErrorNote err={error} />}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void exportPage()}
              disabled={
                !online ||
                phase === "busy" ||
                !databaseId ||
                !title.trim() ||
                !effectiveSummary.trim()
              }
              className={primaryBtn}
            >
              {phase === "busy" ? (
                <SpinnerIcon width={13} height={13} />
              ) : (
                <SendIcon width={13} height={13} />
              )}
              {phase === "busy" ? "Exporting…" : "Export"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={triggerBtn}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Notion: import pages into memory ---------------------------------------

/** "Import from Notion" — page search picker → memory ingest. */
export function NotionImportControl({
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
}) {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<NotionPage[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<unknown>(null);
  const [importedCount, setImportedCount] = useState(0);

  const search = async () => {
    setSearching(true);
    setError(null);
    try {
      const res = await searchNotionPages(query.trim());
      setPages(res?.pages ?? []);
    } catch (err) {
      setError(err);
      setPhase("error");
    } finally {
      setSearching(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runImport = async () => {
    setPhase("busy");
    setError(null);
    try {
      const res = await importNotionPages([...selected]);
      setImportedCount(res?.imported?.length ?? selected.size);
      setPhase("done");
    } catch (err) {
      setError(err);
      setPhase("error");
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!online}
        title={online ? undefined : "You're offline"}
        className={triggerBtn}
      >
        <RefreshIcon width={13} height={13} />
        Import pages to memory
      </button>
    );
  }

  return (
    <div className={panelBox} data-testid="notion-import-panel">
      <PanelLabel>Import Notion pages to memory</PanelLabel>

      {phase === "done" ? (
        <div className="flex items-center justify-between gap-2">
          <SuccessNote>
            Imported {importedCount} page{importedCount === 1 ? "" : "s"} —
            searchable in memory now
          </SuccessNote>
          <button
            type="button"
            onClick={() => {
              setPhase("idle");
              setSelected(new Set());
              setOpen(false);
            }}
            className={triggerBtn}
          >
            Done
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search();
              }}
              placeholder="Search pages…"
              aria-label="Search Notion pages"
              className={fieldInput}
            />
            <button
              type="button"
              onClick={() => void search()}
              disabled={!online || searching}
              className={triggerBtn}
            >
              {searching ? (
                <SpinnerIcon width={13} height={13} />
              ) : (
                "Search"
              )}
            </button>
          </div>

          {pages !== null && pages.length === 0 && (
            <p className="text-[12.5px] text-slate-600">
              No pages found — make sure they're shared with the integration.
            </p>
          )}

          {pages !== null && pages.length > 0 && (
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {pages.map((p) => (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-[11px] border border-[#1e293b] bg-[#111a2e] px-3 py-2"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                    className="h-4 w-4 shrink-0 accent-indigo-600"
                  />
                  <span className="min-w-0 truncate text-[13px] text-slate-200">
                    {p.title || "(untitled page)"}
                  </span>
                </label>
              ))}
            </div>
          )}

          {phase === "error" && <ActionErrorNote err={error} />}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void runImport()}
              disabled={!online || phase === "busy" || selected.size === 0}
              className={primaryBtn}
            >
              {phase === "busy" ? (
                <SpinnerIcon width={13} height={13} />
              ) : (
                <CheckIcon width={13} height={13} />
              )}
              {phase === "busy"
                ? "Importing…"
                : `Import${selected.size > 0 ? ` (${selected.size})` : ""}`}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={triggerBtn}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
