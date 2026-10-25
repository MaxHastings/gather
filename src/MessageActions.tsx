import { useCallback, useRef, useState } from "react";
import { MoreHorizontal, Pencil, Trash2, Copy, Reply } from "lucide-react";
import type { Message } from "./types";
import { useDismissable } from "./useDismissable";
export function MessageActions({
  message,
  scope,
  online,
  onEdit,
  onDelete,
  canEdit = true,
  onReply,
}: {
  message: Message;
  scope: string;
  online: boolean;
  onEdit: (body: string, revision: number) => Promise<void>;
  onDelete: () => Promise<void>;
  canEdit?: boolean;
  onReply?: () => void;
}) {
  const [menu, setMenu] = useState(false),
    [editing, setEditing] = useState(false),
    [deleting, setDeleting] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [text, setText] = useState(""),
    [base, setBase] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setMenu(false), []);
  useDismissable(menu, root, dismiss);
  const key = `gather.edit.${scope}.${message.id}`;
  const clear = () => {
    try {
      localStorage.removeItem(key);
    } catch {}
    setEditing(false);
    setDeleting(false);
    setError("");
  };
  if (message.deletedAt && !editing) return null;
  return (
    <div
      ref={root}
      className={`message-actions${editing || deleting || error ? " expanded" : ""}`}
    >
      {!editing && !deleting && (
        <button
          className="icon-button message-more"
          aria-label="Message actions"
          aria-expanded={menu}
          onClick={() => setMenu((open) => !open)}
        >
          <MoreHorizontal size={16} />
        </button>
      )}
      {menu && (
        <div className="message-action-menu">
          <button
            onClick={async () => {
              setMenu(false);
              try {
                if (window.desktop) await window.desktop.copyText(message.body);
                else await navigator.clipboard.writeText(message.body);
              } catch {
                setError(
                  "Could not copy. Select the message text and copy it instead.",
                );
              }
            }}
          >
            <Copy size={14} />
            Copy
          </button>
          {onReply && (
            <button
              onClick={() => {
                setMenu(false);
                onReply();
              }}
            >
              <Reply size={14} />
              Reply
            </button>
          )}
          {canEdit && (
            <>
              <button
                onClick={() => {
                  let saved;
                  try {
                    saved = JSON.parse(localStorage.getItem(key) || "null");
                  } catch {}
                  setText(
                    typeof saved?.text === "string" ? saved.text : message.body,
                  );
                  setBase(
                    saved?.base ??
                      message.contentRevision ??
                      message.revision ??
                      0,
                  );
                  setEditing(true);
                  setMenu(false);
                  setError("");
                }}
              >
                <Pencil size={14} />
                Edit
              </button>
              <button
                className="danger-text"
                onClick={() => {
                  setDeleting(true);
                  setMenu(false);
                  setError("");
                }}
              >
                <Trash2 size={14} />
                Delete
              </button>
            </>
          )}
        </div>
      )}
      {editing && (
        <form
          className="message-edit"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !online || message.deletedAt) return;
            setBusy(true);
            setError("");
            try {
              await onEdit(text, base);
              clear();
            } catch (failure) {
              setError((failure as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <textarea
            autoFocus
            aria-label="Edit message"
            value={text}
            maxLength={4000}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              setText(value);
              try {
                localStorage.setItem(
                  key,
                  JSON.stringify({ text: value, base }),
                );
              } catch {
                setError(
                  "This edit could not be saved locally. Keep it open or copy it before leaving.",
                );
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                clear();
              }
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="message-edit-controls">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={clear}
            >
              Cancel
            </button>
            {!message.deletedAt &&
              (message.contentRevision ?? message.revision) !== base && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setText(message.body);
                    setBase(message.contentRevision ?? message.revision ?? 0);
                    try {
                      localStorage.removeItem(key);
                    } catch {}
                    setError("");
                  }}
                >
                  Use latest
                </button>
              )}
            <button
              className="button primary"
              disabled={
                busy ||
                !online ||
                Boolean(message.deletedAt) ||
                (!text.trim() && !message.attachments?.length)
              }
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
          {(!online || message.deletedAt) && (
            <p className="field-hint">
              {message.deletedAt
                ? "This message was deleted elsewhere. Copy your edit before closing it."
                : "Reconnect to save. Your edit stays here."}
            </p>
          )}
        </form>
      )}
      {deleting && (
        <div className="message-delete-confirm">
          <span>Delete this message for everyone?</span>
          <button className="text-button" disabled={busy} onClick={clear}>
            Cancel
          </button>
          <button
            className="text-button danger-text"
            disabled={busy || !online}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onDelete();
                clear();
              } catch (failure) {
                setError((failure as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
          {!online && <span>Reconnect to delete.</span>}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
