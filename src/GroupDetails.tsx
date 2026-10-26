import { useState } from "react";
import type { Group } from "./types";
export function GroupDetails({
  group,
  online,
  rename,
  userId,
  membership,
  onLeave,
  muteChoice,
  muteText,
  onMuteChange,
}: {
  group: Group;
  online: boolean;
  rename: (name: string) => Promise<void>;
  userId: string;
  membership?: (
    group: Group,
    action: "remove" | "rotate" | "transfer" | "leave",
    userId?: string,
  ) => Promise<void>;
  onLeave: () => void;
  muteChoice?: string;
  muteText?: string;
  onMuteChange?: (choice: string) => void;
}) {
  const [name, setName] = useState(group.name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const [pending, setPending] = useState<{
    group: Group;
    action: "remove" | "rotate" | "transfer" | "leave";
    userId?: string;
    name?: string;
  } | null>(null);
  const [status, setStatus] = useState("");
  const owner = group.ownerId === userId;
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        setSaved(false);
        try {
          await rename(name);
          setSaved(true);
        } catch (failure) {
          setError((failure as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="chat-name">Chat name</label>
      <div className="input-action">
        <input
          id="chat-name"
          maxLength={48}
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
        />
        <button
          className="button secondary"
          disabled={
            busy || !online || !name.trim() || name.trim() === group.name
          }
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="field-hint">
        {group.members.length} people · Anyone in this chat can update its name
        or picture.
      </p>
      {!online && <p className="field-hint">Reconnect to save changes.</p>}
      {saved && (
        <p className="field-hint" role="status">
          Chat name updated.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {onMuteChange && (
        <div className="preference-select chat-mute">
          <label htmlFor="chat-mute">Notifications</label>
          <select
            id="chat-mute"
            value={muteChoice}
            onChange={(event) => onMuteChange(event.target.value)}
          >
            {muteChoice === "timed" && (
              <option value="timed">{muteText || "Muted for now"}</option>
            )}
            <option value="off">On</option>
            <option value="1h">Mute for 1 hour</option>
            <option value="8h">Mute for 8 hours</option>
            <option value="tomorrow">Mute until tomorrow morning</option>
            <option value="forever">Mute until I unmute</option>
          </select>
        </div>
      )}
      {membership && (
        <section className="group-membership" aria-label="Chat membership">
          <h3>People</h3>
          <div className="membership-list">
            {group.members.map((person) => (
              <div className="membership-row" key={person.id}>
                <div>
                  <strong>
                    {person.name}
                    {person.id === userId ? " (you)" : ""}
                  </strong>
                  {person.id === group.ownerId && (
                    <span className="owner-badge">Owner</span>
                  )}
                </div>
                {owner && person.id !== userId && (
                  <div className="membership-actions">
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`Make ${person.name} owner`}
                      disabled={busy || !online}
                      onClick={() => {
                        setError("");
                        setPending({
                          group,
                          action: "transfer",
                          userId: person.id,
                          name: person.name,
                        });
                      }}
                    >
                      Make owner
                    </button>
                    <button
                      type="button"
                      className="text-button danger-text"
                      aria-label={`Remove ${person.name}`}
                      disabled={busy || !online}
                      onClick={() => {
                        setError("");
                        setPending({
                          group,
                          action: "remove",
                          userId: person.id,
                          name: person.name,
                        });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {owner && (
            <button
              type="button"
              className="button secondary full"
              disabled={busy || !online}
              onClick={() => {
                setError("");
                setPending({ group, action: "rotate" });
              }}
            >
              Replace invite link
            </button>
          )}
          <button
            type="button"
            className="text-button danger-text leave-chat"
            disabled={busy || !online || (owner && group.members.length > 1)}
            onClick={() => {
              setError("");
              setPending({ group, action: "leave" });
            }}
          >
            Leave chat
          </button>
          {owner && group.members.length > 1 && (
            <p className="field-hint">
              Make someone else the owner before leaving.
            </p>
          )}
          {pending && (
            <div
              className="membership-confirm"
              role="group"
              aria-label="Confirm membership change"
            >
              <strong>
                {pending.action === "remove"
                  ? `Remove ${pending.name}?`
                  : pending.action === "transfer"
                    ? `Make ${pending.name} the owner?`
                    : pending.action === "rotate"
                      ? "Replace this invite link?"
                      : "Leave this chat?"}
              </strong>
              <p>
                {pending.action === "remove"
                  ? "They’ll leave the call and lose access to new messages and files. The old invite link will stop working for everyone."
                  : pending.action === "transfer"
                    ? "They’ll manage members and invites. You’ll remain a member."
                    : pending.action === "rotate"
                      ? "The old link will stop working. Share the new link with anyone you want to invite."
                      : "Your saved history stays on this device. You’ll need a working invite to rejoin."}
              </p>
              <div className="membership-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setPending(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || !online}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    setStatus("");
                    try {
                      await membership(
                        pending.group,
                        pending.action,
                        pending.userId,
                      );
                      setStatus(
                        pending.action === "rotate"
                          ? "Invite link replaced."
                          : pending.action === "transfer"
                            ? "Chat owner updated."
                            : "Member removed.",
                      );
                      setPending(null);
                      if (pending.action === "leave") onLeave();
                    } catch (failure) {
                      setError((failure as Error).message);
                      setPending(null);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Updating…" : "Confirm"}
                </button>
              </div>
            </div>
          )}
          {status && (
            <p className="field-hint" role="status">
              {status}
            </p>
          )}
        </section>
      )}
    </form>
  );
}
