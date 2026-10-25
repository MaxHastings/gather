import { useState } from "react";
import type { Message } from "./types";
export function QueueActions({
  message: m,
  scope,
  control,
  resend,
  online,
  transfer,
}: {
  message: Message;
  scope: string;
  control: (
    m: Message,
    action: "pause" | "resume" | "edit" | "discard",
  ) => Promise<boolean>;
  resend: (m: Message, text: string) => Promise<void>;
  online: boolean;
  transfer?: string;
}) {
  const key = `gather.unsent.${scope}.${m.clientId}`;
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(key) ?? m.body;
    } catch {
      return m.body;
    }
  });
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="queue-actions">
      <span className="delivery-state">
        {m.paused
          ? "Paused · Saved on this device"
          : m.status === "failed"
            ? "Not sent · Saved for retry"
            : m.status === "queued"
              ? "Queued · Saved on this device"
              : (transfer ?? "Sending…")}
      </span>
      <div className="queue-buttons">
        <button
          className="text-button retry-message"
          disabled={busy || !online}
          onClick={() =>
            void run(async () => {
              if (m.cancelled) await resend(m, text);
              else await control(m, "resume");
            })
          }
        >
          {m.cancelled ? "Send as new" : "Retry"}
        </button>
        {!m.paused && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await control(m, "pause");
              })
            }
          >
            Pause
          </button>
        )}
        <button
          className="text-button"
          disabled={busy || !online}
          onClick={() =>
            void run(async () => {
              if (await control(m, "edit")) setEditing(true);
            })
          }
        >
          Edit draft
        </button>
        <button
          className="text-button danger-text"
          disabled={busy || !online}
          onClick={() => setConfirming(true)}
        >
          Discard
        </button>
        {confirming && (
          <span className="queue-confirm">
            Discard this unsent message?{" "}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
            <button
              className="text-button danger-text"
              disabled={busy || !online}
              onClick={() =>
                void run(async () => {
                  await control(m, "discard");
                  try {
                    localStorage.removeItem(key);
                  } catch {}
                  setConfirming(false);
                })
              }
            >
              Discard unsent
            </button>
          </span>
        )}
      </div>
      {editing && (
        <form
          className="message-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await resend(m, text);
              localStorage.removeItem(key);
              setEditing(false);
            });
          }}
        >
          <textarea
            aria-label="Edit unsent message"
            value={text}
            maxLength={4000}
            onChange={(e) => {
              setText(e.target.value);
              try {
                localStorage.setItem(key, e.target.value);
              } catch {
                setError(
                  "Keep this draft open or copy it before closing; device storage is unavailable.",
                );
              }
            }}
          />
          <div className="message-edit-controls">
            <button
              type="button"
              className="text-button"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Close draft
            </button>
            <button
              className="button secondary"
              disabled={
                busy || !online || (!text.trim() && !m.attachments?.length)
              }
            >
              Send new message
            </button>
          </div>
        </form>
      )}
      {!online && (
        <span className="field-hint">
          Reconnect to reconcile this message before changing it.
        </span>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
