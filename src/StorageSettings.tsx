import { useCallback, useEffect, useRef, useState } from "react";
import { Pin, Trash2 } from "lucide-react";
import { cacheMedia } from "./media";
import { historyScope } from "./history";
import type { Session } from "./types";
import type { MediaEntry, MediaStatus } from "../server/media-contract.mjs";
export const fileSize = (n: number) =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toFixed(1)} GB`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)} MB`
      : n >= 1000
        ? `${Math.ceil(n / 1000)} KB`
        : `${n} B`;
export function StorageSettings({ session }: { session: Session }) {
  const scope = historyScope(session);
  const revision = useRef(0);
  const currentRequest = useRef("");
  const [status, setStatus] = useState<MediaStatus>(),
    [files, setFiles] = useState<MediaEntry[]>([]),
    [more, setMore] = useState(false),
    [offset, setOffset] = useState(0),
    [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<"clear" | MediaEntry | null>(null);
  currentRequest.current = JSON.stringify([scope, offset, query]);
  const refresh = useCallback(async () => {
    const attempt = ++revision.current;
    const key = JSON.stringify([scope, offset, query]);
    const [info, listing] = await Promise.all([
      cacheMedia<MediaStatus>({ operation: "status", scope }),
      cacheMedia<{ files: MediaEntry[]; hasMore: boolean }>({
        operation: "list",
        scope,
        limit: 50,
        offset,
        query,
        includeArchives: true,
      }),
    ]);
    if (attempt !== revision.current || key !== currentRequest.current) return;
    setStatus(info);
    setFiles(listing.files);
    setMore(listing.hasMore);
    if (!listing.files.length && offset > 0)
      setOffset(Math.max(0, offset - 50));
  }, [scope, offset, query]);
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const load = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (active)
          void refresh().catch(() =>
            setError("Saved files could not be opened. Try again."),
          );
      }, 80);
    };
    load();
    window.addEventListener("gather:media-changed", load);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      revision.current++;
      clearTimeout(timer);
      window.removeEventListener("gather:media-changed", load);
      window.removeEventListener("focus", load);
    };
  }, [refresh]);
  const perform = async (work: () => Promise<unknown>, message = "") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await refresh();
      setConfirm(null);
      setNotice(message);
    } catch (failure) {
      setError(
        (failure as Error).message ||
          "That change could not be saved. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="storage-settings">
      {error && (
        <div>
          <p className="form-error" role="alert">
            {error}
          </p>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void perform(async () => {})}
          >
            Retry
          </button>
        </div>
      )}
      {notice && (
        <p className="field-hint" role="status">
          {notice}
        </p>
      )}
      {!status ? (
        <p>Loading saved files…</p>
      ) : (
        <>
          <div className="storage-summary">
            <strong>{fileSize(status.bytes)}</strong>
            <span>
              {" "}
              of {fileSize(status.limitBytes)} · file data on this device
            </span>
          </div>
          <progress
            aria-label="Device file storage used"
            value={status.bytes}
            max={status.limitBytes}
          />
          <p className="field-hint">
            This profile: {fileSize(status.scopeBytes)} · Kept:{" "}
            {fileSize(status.keptBytes)} · Pending:{" "}
            {fileSize(status.pendingBytes)}
          </p>
          {status.bytes > status.scopeBytes && (
            <p className="field-hint">
              Other profiles use {fileSize(status.bytes - status.scopeBytes)}.
            </p>
          )}
          {status.archiveBytes > 0 && (
            <p className="field-hint">
              Imported archive files: {fileSize(status.archiveBytes)}. Clearing
              downloads leaves these copies alone.
            </p>
          )}
          {status.allocatedBytes !== undefined && (
            <p className="field-hint">
              File storage on disk: {fileSize(status.allocatedBytes)}. Cleared
              space can be reused by Gather.
            </p>
          )}
          <label htmlFor="media-budget">File storage limit</label>
          <select
            id="media-budget"
            disabled={busy}
            value={status.limitBytes}
            onChange={(event) =>
              void perform(() =>
                cacheMedia({
                  operation: "configure",
                  scope,
                  limitBytes: Number(event.target.value),
                }),
              )
            }
          >
            {[20, 100, 250, 500, 1000, 2000].map((n) => (
              <option key={n} value={n * 1_000_000}>
                {n >= 1000 ? `${n / 1000} GB` : `${n} MB`}
              </option>
            ))}
          </select>
          <p className="field-hint">
            Kept files and pending messages are protected. Files without a
            confirmed cloud copy are not removed automatically.
          </p>
          <button
            className="button secondary"
            disabled={busy || !status.clearableCount}
            onClick={() => {
              setConfirm("clear");
              setError("");
            }}
          >
            <Trash2 size={16} /> Clear downloaded files
          </button>
          {confirm && (
            <div
              className="storage-confirm"
              role="group"
              aria-label="Confirm local file removal"
            >
              <strong>
                {confirm === "clear"
                  ? `Remove ${status.clearableCount} downloaded files from this profile?`
                  : `Remove ${confirm.name} from this device?`}
              </strong>
              {(confirm === "clear"
                ? status.unconfirmedCount > 0
                : !confirm.cloudConfirmed) && (
                <p>
                  No cloud copy is confirmed for{" "}
                  {confirm === "clear"
                    ? `${status.unconfirmedCount} of these files`
                    : "this file"}
                  . Removing {confirm === "clear" ? "them" : "it"} may remove
                  the last available copy.
                </p>
              )}
              {confirm === "clear" ? (
                <p>Kept files, pending messages and chat history stay here.</p>
              ) : (
                confirm.kept && (
                  <p>This also removes its kept copy from this device.</p>
                )
              )}
              <div className="message-edit-controls">
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  className="button secondary danger-text"
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      () =>
                        cacheMedia(
                          confirm === "clear"
                            ? {
                                operation: "clear",
                                scope,
                                allowUnconfirmed: true,
                              }
                            : {
                                operation: "remove",
                                scope: confirm.scope,
                                id: confirm.id,
                                allowUnconfirmed: true,
                                allowKept: true,
                              },
                        ),
                      "Files removed from this device.",
                    )
                  }
                >
                  {busy
                    ? "Removing…"
                    : confirm === "clear"
                      ? "Remove downloads"
                      : "Remove file"}
                </button>
              </div>
            </div>
          )}
          <h3>Saved in this profile</h3>
          <input
            aria-label="Find a saved file"
            placeholder="Find a file…"
            value={query}
            maxLength={200}
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
            }}
          />
          {!files.length && (
            <p className="field-hint">
              No matching saved files. Use Keep on a shared file to keep a copy
              on this device.
            </p>
          )}
          <ul className="storage-files">
            {files.map((file) => (
              <li key={file.id}>
                <span className="storage-file-name" title={file.name}>
                  {file.kept && <Pin size={13} />}
                  <strong>{file.name}</strong>
                  <small>
                    {fileSize(file.bytes)}
                    {file.scope !== scope ? " · Imported copy" : ""}
                    {file.pending
                      ? " · Pending message"
                      : file.kept
                        ? " · Kept here"
                        : ""}
                  </small>
                </span>
                <button
                  className="icon-button"
                  disabled={busy || file.pending}
                  aria-label={`Remove ${file.name} from this device`}
                  title={
                    file.pending
                      ? "Send this pending message first"
                      : "Remove from this device"
                  }
                  onClick={() => {
                    setConfirm(file);
                    setError("");
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
          <div className="message-edit-controls">
            {offset > 0 && (
              <button
                className="text-button"
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous files
              </button>
            )}
            {more && (
              <button
                className="text-button"
                onClick={() => setOffset(offset + 50)}
              >
                Next files
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
