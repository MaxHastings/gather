import {
  Bell,
  BellOff,
  Headphones,
  HeadphoneOff,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  Settings,
  Video,
} from "lucide-react";
import { Avatar } from "./Avatars";
import type { CallPerson, Group, Person } from "./types";
import type { RingStatus } from "./useRings";
import type { useVoice } from "./useVoice";

type Call = ReturnType<typeof useVoice>;
const cx = (...names: Array<string | false | undefined>) =>
  names.filter(Boolean).join(" ");

export function callStatusLabel(state: string) {
  return state === "connected"
    ? "Voice connected"
    : state === "partial"
      ? "Connecting a friend…"
      : state === "waiting"
        ? "Waiting for a friend"
        : state === "joining"
          ? "Joining voice…"
          : state === "reconnecting"
            ? "Reconnecting voice…"
            : "Connecting audio…";
}

export function CallControls({
  call,
  onAudioSettings,
}: {
  call: Call;
  onAudioSettings: () => void;
}) {
  return (
    <div className="call-controls">
      <button
        className={cx("call-control", call.muted && "toggled")}
        aria-label={call.muted ? "Unmute microphone" : "Mute microphone"}
        title={
          call.shortcut
            ? `Mute · ${window.desktop?.platform === "darwin" ? "Cmd" : "Ctrl"}+Shift+M`
            : "Mute microphone"
        }
        disabled={call.deafened || call.state === "joining"}
        onClick={call.toggleMute}
      >
        {call.muted ? <MicOff size={19} /> : <Mic size={19} />}
      </button>
      <button
        className={cx("call-control", call.deafened && "toggled")}
        aria-label={call.deafened ? "Undeafen" : "Deafen"}
        disabled={call.state === "joining"}
        title="Deafen"
        onClick={call.toggleDeafen}
      >
        {call.deafened ? <HeadphoneOff size={19} /> : <Headphones size={19} />}
      </button>
      <button
        className="call-control"
        aria-label="Audio settings"
        title="Audio settings"
        onClick={onAudioSettings}
      >
        <Settings size={18} />
      </button>
      <button
        className="call-control hangup"
        aria-label="Leave call"
        title="Leave call"
        onClick={call.leave}
      >
        <PhoneOff size={19} />
      </button>
    </div>
  );
}

const ringText: Record<RingStatus, string> = {
  ringing: "Ringing…",
  declined: "Declined",
  "no-answer": "No answer",
};

export function CallStage({
  group,
  me,
  call,
  online,
  ringStatus,
  chatOpen,
  chatUnread,
  onToggleChat,
  onRing,
  onCancelRing,
  onAudioSettings,
}: {
  group: Group;
  me: string;
  call: Call;
  online: string[];
  ringStatus: Record<string, RingStatus>;
  chatOpen: boolean;
  chatUnread: number;
  onToggleChat: () => void;
  onRing: (userIds: string[] | "all") => void;
  onCancelRing: (userId: string) => void;
  onAudioSettings: () => void;
}) {
  const inCall = new Set(call.people.map((p) => p.id));
  const absent = group.members.filter((p) => p.id !== me && !inCall.has(p.id));
  const ringable = absent.filter(
    (p) => online.includes(p.id) && ringStatus[p.id] !== "ringing",
  );
  const memberOf = (person: CallPerson): Person =>
    group.members.find((m) => m.id === person.id) ?? person;
  return (
    <section className="call-stage" aria-label="Active voice call">
      <div className="stage-top">
        <div className="stage-title">
          <strong>{group.name}</strong>
          <span
            className={cx(
              "stage-state",
              (call.state === "reconnecting" || call.state === "partial") &&
                "recovering",
            )}
          >
            {callStatusLabel(call.state)}
          </span>
        </div>
        <button
          className={cx("stage-chat-toggle", chatOpen && "on")}
          aria-pressed={chatOpen}
          onClick={onToggleChat}
        >
          <MessageSquare size={16} />
          <span>Chat</span>
          {!chatOpen && chatUnread > 0 && (
            <i className="stage-badge" aria-label={`${chatUnread} new`}>
              {chatUnread > 9 ? "9+" : chatUnread}
            </i>
          )}
        </button>
      </div>
      <div
        className="stage-tiles"
        data-count={Math.min(call.people.length, 4)}
        aria-label="People in the call"
      >
        {call.people.map((p) => (
          <div
            key={p.id}
            className={cx("call-tile", p.speaking && "speaking")}
            data-connection={p.connection}
            aria-label={`${p.local ? "You" : p.name}${p.muted ? ", muted" : p.speaking ? ", speaking" : ""}${!p.local && p.connection !== "connected" ? `, ${p.connection}` : ""}`}
          >
            {/* Video and shared screens will fill this slot. */}
            <div className="tile-media">
              <Avatar person={memberOf(p)} size="stage" />
            </div>
            <div className="tile-name">
              {p.muted && <MicOff size={13} aria-label="Muted" />}
              <span>{p.local ? "You" : p.name}</span>
              {!p.local && p.connection !== "connected" && (
                <LoaderCircle
                  className="spin"
                  size={13}
                  aria-label={
                    p.connection === "reconnecting"
                      ? "Reconnecting"
                      : "Connecting"
                  }
                />
              )}
            </div>
          </div>
        ))}
      </div>
      {absent.length > 0 && (
        <div className="stage-invite">
          <div className="stage-invite-head">
            <h3>Not in the call</h3>
            {ringable.length > 1 && (
              <button className="ring-button" onClick={() => onRing("all")}>
                <Bell size={14} /> Ring everyone
              </button>
            )}
          </div>
          <ul>
            {absent.map((p) => {
              const status = ringStatus[p.id];
              const here = online.includes(p.id);
              return (
                <li key={p.id}>
                  <Avatar person={p} size="mini" online={here} />
                  <span className="invite-name">{p.name}</span>
                  {status && (
                    <span className={cx("ring-status", status)} role="status">
                      {ringText[status]}
                    </span>
                  )}
                  {status === "ringing" ? (
                    <button
                      className="ring-button"
                      onClick={() => onCancelRing(p.id)}
                    >
                      <BellOff size={14} /> Cancel
                    </button>
                  ) : (
                    <button
                      className="ring-button"
                      disabled={!here}
                      title={here ? `Ring ${p.name}` : `${p.name} is offline`}
                      aria-label={`Ring ${p.name}`}
                      onClick={() => onRing([p.id])}
                    >
                      <Bell size={14} /> {here ? "Ring" : "Offline"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="stage-dock">
        <CallControls call={call} onAudioSettings={onAudioSettings} />
      </div>
    </section>
  );
}
