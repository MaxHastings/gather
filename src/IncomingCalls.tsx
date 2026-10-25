import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff } from "lucide-react";
import { Avatar } from "./Avatars";
import { playRing } from "./sounds";
import type { IncomingRing } from "./useRings";

export function IncomingCalls({
  rings,
  inCall,
  onAnswer,
  onDecline,
}: {
  rings: IncomingRing[];
  inCall: boolean;
  onAnswer: (ring: IncomingRing) => void;
  onDecline: (ring: IncomingRing) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const notices = useRef(new Map<string, Notification>());
  const ringing = rings.length > 0;
  // One looping ring while any call is waiting; the sound pack decides the tune.
  useEffect(() => {
    if (!ringing) return;
    const stop = playRing();
    return stop;
  }, [ringing]);
  useEffect(() => {
    if (!ringing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ringing]);
  // Tell people who aren't looking at Gather, if they allowed notifications.
  useEffect(() => {
    for (const ring of rings) {
      if (
        notices.current.has(ring.groupId) ||
        !document.hidden ||
        !("Notification" in window) ||
        Notification.permission !== "granted"
      )
        continue;
      try {
        const note = new Notification(`${ring.from.name} is calling`, {
          body: ring.groupName,
          tag: `gather-call-${ring.groupId}`,
          requireInteraction: true,
        });
        note.onclick = () => window.focus();
        notices.current.set(ring.groupId, note);
      } catch {
        /* Notifications are a bonus. */
      }
    }
    for (const [id, note] of notices.current)
      if (!rings.some((r) => r.groupId === id)) {
        note.close();
        notices.current.delete(id);
      }
  }, [rings]);
  useEffect(
    () => () => {
      for (const note of notices.current.values()) note.close();
    },
    [],
  );
  if (!ringing) return null;
  return (
    <div className="incoming-calls" role="region" aria-label="Incoming calls">
      {rings.map((ring) => (
        <div
          className="incoming-call"
          key={ring.groupId}
          role="alertdialog"
          aria-label={`${ring.from.name} is calling ${ring.groupName}`}
        >
          <Avatar person={ring.from} size="large" />
          <div className="incoming-text">
            <strong>{ring.from.name} is calling</strong>
            <span>
              {ring.groupName}
              {ring.peers.length > 1 && ` · ${ring.peers.length} in the call`}
            </span>
            <small>
              {Math.max(0, Math.ceil((ring.expiresAt - now) / 1000))}s
            </small>
          </div>
          <div className="incoming-actions">
            <button
              className="call-control hangup"
              aria-label={`Decline call from ${ring.from.name}`}
              title="Decline"
              onClick={() => onDecline(ring)}
            >
              <PhoneOff size={18} />
            </button>
            <button
              className="call-control answer"
              aria-label={
                inCall
                  ? `Leave your call and join ${ring.groupName}`
                  : `Join ${ring.groupName}`
              }
              title={inCall ? "Leave current call and join" : "Join"}
              onClick={() => onAnswer(ring)}
            >
              <Phone size={18} fill="currentColor" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
