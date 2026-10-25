import { memo } from "react";
import { MessageText } from "./MessageText";
import { QueueActions } from "./QueueActions";
import { CheckCheck } from "lucide-react";
import { EmojiText, emojiOnlyCount } from "./Emoji";
import { AvatarImage } from "./Avatars";
import { AttachmentView } from "./Attachments";
import { MessageActions } from "./MessageActions";
import { MessageReactions } from "./MessageReactions";
import { historyScope } from "./history";
import type { Message, Session, Person } from "./types";
const cx = (...v: (string | false | undefined)[]) =>
  v.filter(Boolean).join(" ");
function Avatar({ person }: { person: Person; size?: string }) {
  const color = [...person.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 5;
  return (
    <span className={`avatar color-${color} mini`}>
      {person.name
        .split(" ")
        .slice(0, 2)
        .map((s) => s[0])
        .join("")
        .toUpperCase()}
      <AvatarImage id={person.avatarId} />
    </span>
  );
}
export type RowActions = {
  react: (m: Message, emoji: string, active: boolean) => Promise<void>;
  edit: (m: Message, body: string, revision: number) => Promise<void>;
  deleteMessage: (m: Message) => Promise<void>;
  retry: (m: Message) => Promise<void>;
  reply: (m: Message) => void;
  jump: (groupId: string, id: string) => void;
  queueControl: (
    m: Message,
    a: "pause" | "resume" | "edit" | "discard",
  ) => Promise<boolean>;
  resendDraft: (m: Message, text: string) => Promise<void>;
};
export const MessageRow = memo(function MessageRow({
  message: m,
  grouped,
  session,
  readOnly,
  online,
  reactions,
  mutations,
  personName,
  avatarId,
  last,
  transfer,
  actions,
  replyTarget,
  people,
  day,
  firstUnread,
  highlighted,
}: {
  message: Message;
  grouped: boolean;
  session: Session;
  readOnly: boolean;
  online: boolean;
  reactions: boolean;
  mutations: boolean;
  personName: string;
  avatarId?: string;
  last: boolean;
  transfer?: string;
  actions: RowActions;
  replyTarget?: Message;
  people: Record<string, string>;
  day?: string;
  firstUnread?: boolean;
  highlighted?: boolean;
}) {
  const own = m.userId === session.user.id;
  return (
    <>
      {day && (
        <div className="date-divider">
          <span>{day}</span>
        </div>
      )}
      {firstUnread && (
        <div className="unread-divider" role="separator">
          New messages
        </div>
      )}
      <div
        data-message-id={m.id}
        className={cx(
          "message-row",
          highlighted && "message-highlight",
          own && "own",
          grouped && "grouped",
        )}
      >
        <div className="message-avatar">
          {!grouped && (
            <Avatar
              person={{ id: m.userId, name: personName, avatarId }}
              size="mini"
            />
          )}
        </div>
        <div className="message-content">
          {!grouped && (
            <div className="message-meta">
              <strong>{own ? "You" : m.name}</strong>
              <time dateTime={new Date(m.createdAt).toISOString()}>
                {new Date(m.createdAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            </div>
          )}
          {m.replyTo && (
            <button
              className="reply-reference"
              onClick={() => actions.jump(m.groupId, m.replyTo!)}
            >
              <strong>{replyTarget?.name ?? m.reply?.name ?? "Reply"}</strong>
              <span>
                {replyTarget?.deletedAt || m.reply?.deleted
                  ? "Message deleted"
                  : (replyTarget?.body ??
                    m.reply?.body ??
                    "View original message")}
              </span>
            </button>
          )}
          <div
            className={cx(
              "message-bubble",
              !m.deletedAt &&
                !m.attachments?.length &&
                emojiOnlyCount(m.body) > 0 &&
                "emoji-message",
              !m.deletedAt &&
                !m.attachments?.length &&
                emojiOnlyCount(m.body) > 3 &&
                "emoji-message-many",
              m.status === "failed" && "failed",
            )}
          >
            {m.deletedAt ? (
              <span className="message-deleted">Message deleted</span>
            ) : (
              <MessageText text={m.body} />
            )}
            {m.editedAt && !m.deletedAt && (
              <small
                className="message-edited"
                title={new Date(m.editedAt).toLocaleString()}
              >
                edited
              </small>
            )}
            {m.attachments?.map((attachment) => (
              <AttachmentView
                key={attachment.id}
                session={session}
                attachment={attachment}
                remote={!readOnly}
                messageKey={`${m.userId}:${m.clientId}`}
              />
            ))}
          </div>
          {!m.status && !m.deletedAt && reactions && (
            <MessageReactions
              message={m}
              people={people}
              userId={session.user.id}
              disabled={readOnly || !online}
              onReact={(emoji, active) => actions.react(m, emoji, active)}
            />
          )}
          {!m.deletedAt && !m.status && (
            <MessageActions
              message={m}
              canEdit={own && !readOnly && mutations}
              onReply={!readOnly ? () => actions.reply(m) : undefined}
              scope={historyScope(session)}
              online={online}
              onEdit={(body, revision) => actions.edit(m, body, revision)}
              onDelete={() => actions.deleteMessage(m)}
            />
          )}
          {m.status ? (
            readOnly ? (
              <span className="delivery-state">
                Not sent · Saved on this device
              </span>
            ) : (
              <QueueActions
                message={m}
                scope={historyScope(session)}
                control={actions.queueControl}
                resend={actions.resendDraft}
                online={online}
                transfer={transfer}
              />
            )
          ) : own && last ? (
            <span className="delivery-state">
              <CheckCheck size={12} />
              Saved to chat
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
});
