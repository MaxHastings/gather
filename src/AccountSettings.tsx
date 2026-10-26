import { useState } from "react";
import { api } from "./api";
import type { Session } from "./types";

const PHRASE = "delete my account";
/** Permanent deletion of this person's messages, files and place in every chat. */
export function DeleteAccount({
  session,
  onDeleted,
}: {
  session: Session;
  onDeleted: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!open)
    return (
      <button
        type="button"
        className="text-button danger-text delete-account-open"
        onClick={() => setOpen(true)}
      >
        Delete my account…
      </button>
    );
  return (
    <form
      className="delete-account"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        api(session, "/api/account/delete", {
          method: "POST",
          body: JSON.stringify({ confirm: PHRASE }),
        })
          .then(onDeleted)
          .catch((failure: Error) => {
            setError(failure.message || "Could not delete the account.");
            setBusy(false);
          });
      }}
    >
      <p>
        <strong>This cannot be undone.</strong> Your messages and files are
        removed from the server, you leave every chat, and your recovery code
        stops working. If you own a chat, the next person becomes its owner.
        History already saved on this device stays here until you clear it.
      </p>
      <label htmlFor="delete-confirm">
        Type <code>{PHRASE}</code> to confirm
      </label>
      <input
        id="delete-confirm"
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoComplete="off"
      />
      <div className="delete-actions">
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setOpen(false);
            setText("");
            setError("");
          }}
        >
          Keep my account
        </button>
        <button
          className="button danger"
          disabled={busy || text.trim().toLowerCase() !== PHRASE}
        >
          {busy ? "Deleting…" : "Delete everything"}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
