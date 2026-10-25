import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { RealtimeClient } from "./realtime";
import type { Person } from "./types";

export type IncomingRing = {
  groupId: string;
  groupName: string;
  from: Person;
  peers: string[];
  expiresAt: number;
};
export type RingStatus = "ringing" | "declined" | "no-answer";
type ServerRing = Omit<IncomingRing, "expiresAt"> & { expiresIn: number };
type ServerStatus = {
  groupId: string;
  userId: string;
  status: RingStatus | "answered" | "cancelled";
};
// A little longer than the server's 30 seconds, so its verdict normally wins.
const LOCAL_TIMEOUT = 33000;
const LINGER = 8000;

export function useRings(socket: RefObject<RealtimeClient | null>) {
  const [incoming, setIncoming] = useState<IncomingRing[]>([]);
  const [status, setStatus] = useState<
    Record<string, Record<string, RingStatus>>
  >({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const after = useCallback((key: string, ms: number, run: () => void) => {
    clearTimeout(timers.current.get(key));
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        run();
      }, ms),
    );
  }, []);
  const setOne = useCallback(
    (groupId: string, userId: string, value?: RingStatus) =>
      setStatus((current) => {
        const group = { ...current[groupId] };
        if (value) group[userId] = value;
        else delete group[userId];
        return { ...current, [groupId]: group };
      }),
    [],
  );
  const track = useCallback(
    (groupId: string, userId: string, value?: RingStatus) => {
      setOne(groupId, userId, value);
      const key = `out|${groupId}|${userId}`;
      if (value === "ringing")
        after(key, LOCAL_TIMEOUT, () => setOne(groupId, userId, "no-answer"));
      else if (value) after(key, LINGER, () => setOne(groupId, userId));
      else {
        clearTimeout(timers.current.get(key));
        timers.current.delete(key);
      }
    },
    [after, setOne],
  );
  const drop = useCallback((groupId: string) => {
    clearTimeout(timers.current.get(`in|${groupId}`));
    timers.current.delete(`in|${groupId}`);
    setIncoming((current) => current.filter((r) => r.groupId !== groupId));
  }, []);
  const attach = useCallback(
    (client: RealtimeClient) => {
      client.on("call:ring", (ring: ServerRing) => {
        const { expiresIn, ...rest } = ring;
        setIncoming((current) => [
          ...current.filter((r) => r.groupId !== ring.groupId),
          { ...rest, expiresAt: Date.now() + expiresIn },
        ]);
        after(`in|${ring.groupId}`, expiresIn + 1000, () => drop(ring.groupId));
      });
      client.on("call:ring-end", ({ groupId }: { groupId: string }) =>
        drop(groupId),
      );
      client.on("call:ring-status", (event: ServerStatus) =>
        track(
          event.groupId,
          event.userId,
          event.status === "answered" || event.status === "cancelled"
            ? undefined
            : event.status,
        ),
      );
    },
    [after, drop, track],
  );
  const reset = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setIncoming([]);
    setStatus({});
  }, []);
  useEffect(() => reset, [reset]);
  const ring = useCallback(
    async (groupId: string, target: string[] | "all") => {
      const result = (await socket.current?.request("call:ring", {
        groupId,
        ...(target === "all" ? { all: true } : { userIds: target }),
      })) as { ringing: string[] } | undefined;
      return result?.ringing ?? [];
    },
    [socket],
  );
  const cancel = useCallback(
    (groupId: string, userIds?: string[]) =>
      socket.current?.emit("call:ring-cancel", { groupId, userIds }),
    [socket],
  );
  const decline = useCallback(
    (groupId: string) => {
      drop(groupId);
      socket.current?.emit("call:ring-decline", { groupId });
    },
    [drop, socket],
  );
  return { incoming, status, attach, reset, ring, cancel, decline, drop };
}
