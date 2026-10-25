import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { history, historyScope, type HistoryState } from "./history";
import {
  downloadArchive,
  exportArchive,
  importArchive,
  type HistoryPage,
  type LocalArchive,
} from "./archive";
import { MAX_ARCHIVE_FILE_BYTES } from "../server/archive-format.mjs";
import { AttachmentView } from "./Attachments";
import { cacheMedia } from "./media";
import type { Group, Message, Session } from "./types";

type Context = {
  groupId: string;
  messages: Message[];
  earlier: boolean;
  later: boolean;
  highlight?: string;
};
const date = (time: number) =>
  new Date(time).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function HistoryTools({
  session,
  initialGroup,
  onOpenMessage,
}: {
  session: Session;
  initialGroup?: string;
  onOpenMessage?: (groupId: string, id: string) => void;
}) {
  const ownerScope = historyScope(session);
  const [archives, setArchives] = useState<LocalArchive[]>([]);
  const [scope, setScope] = useState(ownerScope);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState(initialGroup ?? "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Message[]>([]);
  const [context, setContext] = useState<Context>();
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const reader = useRef(0);
  const viewport = useRef<HTMLDivElement>(null);
  const selected = archives.find((archive) => archive.scope === scope);

  async function catalog() {
    const entries = await history<LocalArchive[]>({
      operation: "archives",
      scope: ownerScope,
    });
    setArchives(entries);
  }
  useEffect(() => {
    let active = true;
    history<LocalArchive[]>({ operation: "archives", scope: ownerScope })
      .then((entries) => {
        if (active) setArchives(entries);
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
      reader.current++;
    };
  }, [ownerScope]);
  useEffect(() => {
    let active = true;
    setGroups([]);
    setResults([]);
    setContext(undefined);
    setConfirmRemove(false);
    reader.current++;
    history<HistoryState>({ operation: "state", scope })
      .then((data) => {
        if (active) setGroups(data.groups);
      })
      .catch((failure) => {
        if (active) setError(failure.message);
      });
    return () => {
      active = false;
    };
  }, [scope]);
  useEffect(() => {
    let active = true;
    setResults([]);
    setContext(undefined);
    reader.current++;
    if (!query.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    let timer: number;
    let runId = 0;
    const search = () => {
      clearTimeout(timer);
      const attempt = ++runId;
      timer = window.setTimeout(() => {
        history<Message[]>({
          operation: "search",
          scope,
          query,
          ...(groupId ? { groupId } : {}),
        })
          .then((messages) => {
            if (active && attempt === runId) setResults(messages);
          })
          .catch((failure) => {
            if (active && attempt === runId) setError(failure.message);
          })
          .finally(() => {
            if (active && attempt === runId) setSearching(false);
          });
      }, 180);
    };
    const updated = (event: Event) => {
      if ((event as CustomEvent).detail?.scope === scope) search();
    };
    search();
    window.addEventListener("gather:history-updated", updated);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("gather:history-updated", updated);
    };
  }, [scope, query, groupId]);
  useEffect(() => {
    if (!context) return;
    const target = viewport.current?.querySelector<HTMLElement>(
      "[data-highlight=true]",
    );
    if (target) target.scrollIntoView({ block: "center" });
    else if (viewport.current) viewport.current.scrollTop = 0;
  }, [context]);

  async function open(
    group: string,
    hit?: Message,
    direction?: "earlier" | "later",
  ) {
    const attempt = ++reader.current;
    setError("");
    try {
      const before =
        direction === "earlier"
          ? context?.messages[0]?.sequence
          : hit
            ? hit.sequence + 1
            : undefined;
      const after =
        direction === "later" ? context?.messages.at(-1)?.sequence : undefined;
      const page = await history<HistoryPage>({
        operation: "page",
        scope,
        groupId: group,
        before,
        after,
      });
      let later =
        direction === "later" ? page.hasMore : direction === "earlier";
      if (hit && page.messages.length)
        later =
          (
            await history<HistoryPage>({
              operation: "page",
              scope,
              groupId: group,
              after: page.messages.at(-1)!.sequence,
              limit: 1,
            })
          ).messages.length > 0;
      if (attempt === reader.current)
        setContext({
          groupId: group,
          messages: page.messages,
          earlier: direction === "later" || page.hasMore,
          later,
          highlight: hit?.id,
        });
    } catch (failure) {
      if (attempt === reader.current) setError((failure as Error).message);
    }
  }

  async function perform(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (failure) {
      setError(
        (failure as Error).message || "That archive could not be opened.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function importFile(value: File) {
    await perform(async () => {
      if (value.size > MAX_ARCHIVE_FILE_BYTES)
        throw new Error("Choose a text archive smaller than 20 MB.");
      let raw: unknown;
      try {
        raw = JSON.parse(await value.text());
      } catch {
        throw new Error("Choose a valid Gather JSON archive.");
      }
      const entry = await importArchive(
        session,
        value.name.slice(0, 128) || "Imported history",
        raw,
      );
      await catalog();
      setGroupId("");
      setQuery("");
      setScope(entry.scope);
      setNotice(
        entry.alreadyImported
          ? "This archive is already saved here."
          : "Archive saved on this device.",
      );
    });
  }

  return (
    <div className="history-tools">
      <div className="history-toolbar">
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const result = await exportArchive(session);
              downloadArchive(result.archive);
              setNotice(
                result.missingFiles
                  ? `Exported history. ${result.missingFiles} original files were unavailable and are marked missing.`
                  : result.serverIncluded
                    ? "Export includes saved and available server history."
                    : "Export includes this device’s saved history. Server unavailable.",
              );
            })
          }
        >
          <Download size={16} />
          Export
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          <Upload size={16} />
          Import
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="Import history file"
          onChange={(event) => {
            const value = event.target.files?.[0];
            event.target.value = "";
            if (value) void importFile(value);
          }}
        />
        {busy && (
          <span role="status" className="muted">
            Working…
          </span>
        )}
      </div>
      <div className="history-filters">
        <label>
          History
          <select
            aria-label="History source"
            disabled={busy}
            value={scope}
            onChange={(event) => {
              setGroupId("");
              setScope(event.target.value);
            }}
          >
            <option value={ownerScope}>This device</option>
            {archives.map((archive) => (
              <option key={archive.id} value={archive.scope}>
                {archive.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Conversation
          <select
            aria-label="History conversation"
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
          >
            <option value="">All chats</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="history-query">
        <Search size={17} />
        <input
          aria-label="Search saved messages"
          placeholder="Search messages"
          maxLength={200}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="field-hint" role="status">
          {notice}
        </p>
      )}
      {context ? (
        <section className="history-context" aria-label="Saved conversation">
          {scope === ownerScope && context.highlight && onOpenMessage && (
            <button
              className="text-button"
              onClick={() => onOpenMessage(context.groupId, context.highlight!)}
            >
              Open in chat
            </button>
          )}
          <button
            className="text-button"
            onClick={() => {
              reader.current++;
              setContext(undefined);
            }}
          >
            <ArrowLeft size={14} />
            Back
          </button>
          <h3>
            {groups.find((group) => group.id === context.groupId)?.name ??
              "Saved chat"}
          </h3>
          <div className="history-pages">
            <button
              className="text-button"
              disabled={!context.earlier || !context.messages.length}
              onClick={() => void open(context.groupId, undefined, "earlier")}
            >
              <ChevronLeft size={14} />
              Earlier
            </button>
            <span className="muted">Saved messages</span>
            <button
              className="text-button"
              disabled={!context.later || !context.messages.length}
              onClick={() => void open(context.groupId, undefined, "later")}
            >
              Later
              <ChevronRight size={14} />
            </button>
          </div>
          <div
            ref={viewport}
            className="history-message-list"
            tabIndex={0}
            aria-label="Saved messages"
          >
            {!context.messages.length && (
              <p className="muted">No messages saved here yet.</p>
            )}
            {context.messages.map((message) => (
              <article
                key={message.id}
                data-highlight={message.id === context.highlight}
              >
                <header>
                  <strong>{message.name}</strong>
                  <time dateTime={new Date(message.createdAt).toISOString()}>
                    {date(message.createdAt)}
                  </time>
                </header>
                <p>
                  {message.deletedAt ? "Message deleted" : message.body}
                  {message.editedAt && !message.deletedAt ? " (edited)" : ""}
                </p>
                {message.attachments?.map((attachment) => (
                  <AttachmentView
                    key={attachment.id}
                    session={session}
                    attachment={attachment}
                    messageKey={`${message.userId}:${message.clientId}`}
                    scope={scope}
                    fallbackScope={selected?.mediaSourceScope}
                    remote={scope === ownerScope}
                  />
                ))}
              </article>
            ))}
          </div>
        </section>
      ) : (
        <div className="history-results" aria-live="polite">
          {searching ? (
            <p className="muted">Searching…</p>
          ) : query.trim() ? (
            <>
              <p className="field-hint">
                {results.length === 50
                  ? "Latest 50 matches"
                  : `${results.length} ${results.length === 1 ? "match" : "matches"}`}
              </p>
              {results.map((message) => (
                <button
                  key={message.id}
                  onClick={() => void open(message.groupId, message)}
                >
                  <span>
                    <strong>{message.name}</strong>
                    <time>{date(message.createdAt)}</time>
                  </span>
                  <p>{message.body}</p>
                  <small>
                    {groups.find((group) => group.id === message.groupId)
                      ?.name ?? "Saved chat"}
                  </small>
                </button>
              ))}
            </>
          ) : (
            <>
              {!groups.length && (
                <p className="muted">No conversations saved here yet.</p>
              )}
              {groups
                .filter((group) => !groupId || group.id === groupId)
                .map((group) => (
                  <button key={group.id} onClick={() => void open(group.id)}>
                    <span>
                      <strong>
                        <FolderOpen size={16} />
                        {group.name}
                      </strong>
                      <small>
                        {group.members.length}{" "}
                        {group.members.length === 1 ? "person" : "people"}
                      </small>
                    </span>
                  </button>
                ))}
            </>
          )}
        </div>
      )}
      <footer className="history-footer">
        <span className="field-hint">
          {selected
            ? `Imported copy · ${selected.messages} messages · ${selected.person}`
            : "Search covers history saved on this device."}
        </span>
        {selected &&
          (confirmRemove ? (
            <div className="history-toolbar">
              <span>Remove this local copy?</span>
              <button
                className="text-button danger-text"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await cacheMedia({
                      operation: "clearArchive",
                      scope: ownerScope,
                      id: selected.id,
                    });
                    await history({
                      operation: "deleteArchive",
                      scope: ownerScope,
                      id: selected.id,
                    });
                    await catalog();
                    setScope(ownerScope);
                    setGroupId("");
                    setConfirmRemove(false);
                    setNotice(
                      "Imported copy removed. Live chats and the original file are unchanged.",
                    );
                  })
                }
              >
                Remove
              </button>
              <button
                className="text-button"
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              className="text-button danger-text"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2 size={14} />
              Remove imported copy
            </button>
          ))}
      </footer>
    </div>
  );
}
