import { useState, useRef, useCallback } from "react";
import { useDismissable } from "./useDismissable";
import { SmilePlus } from "lucide-react";
import { Emoji } from "./Emoji";
import { EmoticonPicker } from "./EmoticonPicker";
import type { Message } from "./types";
export function MessageReactions({
  message,
  userId,
  disabled,
  onReact,
  people = {},
}: {
  message: Message;
  userId: string;
  disabled: boolean;
  onReact: (emoji: string, active: boolean) => Promise<void>;
  people?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const root = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissable(open, root, dismiss);
  const choose = async (emoji: string) => {
    setBusy(true);
    setError("");
    setOpen(false);
    try {
      await onReact(
        emoji,
        !message.reactions?.some(
          (reaction) =>
            reaction.emoji === emoji && reaction.userIds.includes(userId),
        ),
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Reaction could not be saved. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      ref={root}
      className={`message-reactions${!message.reactions?.length && !error ? " empty" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      {message.reactions?.map((reaction) => (
        <button
          key={reaction.emoji}
          className="reaction-pill"
          aria-label={`${reaction.emoji} reaction, ${reaction.userIds.length}`}
          title={reaction.userIds
            .map((id) =>
              id === userId ? "You" : (people[id] ?? "Former member"),
            )
            .join(", ")}
          aria-pressed={reaction.userIds.includes(userId)}
          disabled={disabled || busy}
          onClick={() => void choose(reaction.emoji)}
        >
          <Emoji value={reaction.emoji} />
          <span>{reaction.userIds.length}</span>
        </button>
      ))}
      <button
        className="reaction-add icon-button"
        aria-label="React to message"
        title={disabled ? "Reconnect to react" : "React to message"}
        aria-expanded={open}
        disabled={disabled || busy}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPosition({
            left: Math.max(12, Math.min(window.innerWidth - 380, rect.left)),
            top: Math.max(
              12,
              Math.min(window.innerHeight - 340, rect.top - 330),
            ),
          });
          setOpen(!open);
        }}
      >
        <SmilePlus size={16} />
      </button>
      {open && (
        <div
          className="reaction-picker"
          style={{ position: "fixed", ...position, bottom: "auto" }}
          aria-label="Choose a reaction"
        >
          <EmoticonPicker onSelect={(emoji) => void choose(emoji)} />
        </div>
      )}
      {error && (
        <span className="reaction-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
