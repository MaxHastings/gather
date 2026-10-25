import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RealtimeClient } from "./realtime";
import { useRings } from "./useRings";
import { api } from "./api";
import { history, historyScope, type HistoryState } from "./history";
import type { Bootstrap, Group, Message, Session, Attachment } from "./types";
import {
  stageFile,
  uploadMedia,
  loadMedia,
  unpinMedia,
  cacheMedia,
  AttachmentInputError,
  flushMediaCleanup,
} from "./media";
import {
  createMessageNotifier,
  readNotificationPreferences,
} from "./notifications";
import { playSound } from "./sounds";
import { mediaMessageKey } from "../server/media-contract.mjs";
type Typing = {
  groupId: string;
  connectionId: string;
  userId: string;
  name: string;
  active: boolean;
  until: number;
};

export function mergeMessages(current: Message[], incoming: Message[]) {
  const map = new Map(
    current.map((message) => [
      `${message.userId}:${message.clientId}`,
      message,
    ]),
  );
  for (const message of incoming) {
    const key = `${message.userId}:${message.clientId}`;
    if (
      (map.get(key)?.revision ?? 0) > (message.revision ?? 0) ||
      (map.get(key)?.deletedAt && !message.deletedAt)
    )
      continue;
    map.set(key, message);
  }
  return [...map.values()].sort(
    (a, b) =>
      (a.status ? Number.MAX_SAFE_INTEGER : a.sequence) -
        (b.status ? Number.MAX_SAFE_INTEGER : b.sequence) ||
      a.createdAt - b.createdAt,
  );
}
export function useChat(session: Session) {
  const transport = useMemo(
    () => session,
    [session.server, session.token, session.user.id],
  );
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState(
    localStorage.getItem(`gather.selected.${session.user.id}`) || "",
  );
  const selectionRevision = useRef(0);
  function select(id: string) {
    selectionRevision.current++;
    setSelected(id);
  }
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const focusedWindows = useRef(new Set<string>());
  const [hasNewer, setHasNewer] = useState<Record<string, boolean>>({});
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [online, setOnline] = useState<string[]>([]);
  const [voice, setVoice] = useState<Record<string, string[]>>({});
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voiceLimit, setVoiceLimit] = useState(2);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [typists, setTypists] = useState<Record<string, Typing>>({});
  const typingSent = useRef({ groupId: "", at: 0, active: false });
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "offline"
  >("connecting");
  const [error, setError] = useState("");
  const [transfers, setTransfers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const socket = useRef<RealtimeClient | null>(null);
  const rings = useRings(socket);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const accessChanges = useRef(
    new Map<string, NonNullable<Bootstrap["departures"]>[number]>(),
  );
  const applyGroups = useCallback((incoming: Group[]) => {
    const next = [...groupsRef.current];
    const accepted: Group[] = [];
    for (const received of incoming) {
      const departure = accessChanges.current.get(received.id);
      const group =
        departure &&
        departure.controlRevision >= (received.controlRevision ?? 0)
          ? { ...received, ...departure, inviteCode: "", members: [] }
          : received;
      const index = next.findIndex((g) => g.id === group.id);
      const previous = next[index];
      if (
        previous &&
        ((previous.controlRevision ?? 0) > (group.controlRevision ?? 0) ||
          ((previous.controlRevision ?? 0) === (group.controlRevision ?? 0) &&
            previous.access &&
            previous.access !== "active" &&
            group.access === "active"))
      )
        continue;
      const updated =
        previous?.lastMessage &&
        previous.lastMessage.sequence > (group.lastMessage?.sequence ?? 0)
          ? { ...group, lastMessage: previous.lastMessage }
          : group;
      if (index < 0) next.push(updated);
      else next[index] = updated;
      accepted.push(updated);
    }
    groupsRef.current = next;
    setGroups(next);
    return accepted;
  }, []);
  const outboxKey = `gather.outbox.${session.server}.${session.user.id}`;
  const scope = historyScope(session);
  const saveGroups = useCallback(
    async (incoming: Group[]) => {
      const accepted = applyGroups(incoming);
      if (accepted.length)
        await history({ operation: "bootstrap", scope, groups: accepted });
    },
    [applyGroups, scope],
  );
  const loseAccess = useCallback(
    async (departure: NonNullable<Bootstrap["departures"]>[number]) => {
      if (
        (accessChanges.current.get(departure.groupId)?.controlRevision ?? -1) >
        departure.controlRevision
      )
        return;
      accessChanges.current.set(departure.groupId, departure);
      const group = groupsRef.current.find((g) => g.id === departure.groupId);
      if (!group || (group.controlRevision ?? 0) > departure.controlRevision)
        return;
      setVoice((current) => ({ ...current, [group.id]: [] }));
      setTypists((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([, p]) => p.groupId !== group.id),
        ),
      );
      await saveGroups([
        { ...group, ...departure, inviteCode: "", members: [] },
      ]);
    },
    [saveGroups],
  );
  const outbox = useRef<Message[]>([]);
  const storageReady = useRef<Promise<void> | null>(null);
  const lifetime = useRef(0);
  const syncEpoch = useRef(0);
  const syncReady = useRef(false);
  const refreshTask = useRef<Promise<void> | null>(null);
  const prepareStorage = useCallback(() => {
    if (!storageReady.current)
      storageReady.current = (async () => {
        const old = localStorage.getItem(outboxKey);
        if (old !== null) {
          const pending = JSON.parse(old);
          if (!Array.isArray(pending))
            throw new Error(
              "Your saved sending queue could not be migrated. It has been preserved.",
            );
          for (const message of pending)
            await history({
              operation: "queue",
              scope,
              message: { ...message, status: "failed" },
            });
          // Clear legacy storage only after every entry has committed. Repeating
          // a migration interrupted before this line is idempotent.
          localStorage.removeItem(outboxKey);
        }
      })().catch((error) => {
        storageReady.current = null;
        throw error;
      });
    return storageReady.current;
  }, [scope, outboxKey]);
  useEffect(() => {
    let active = true;
    const flush = () =>
      void flushMediaCleanup(scope).catch(() => {
        if (active)
          setError(
            "Some deleted files could not be removed from this device. Free storage and reopen Gather to retry.",
          );
      });
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.scope === scope) flush();
    };
    flush();
    window.addEventListener("gather:history-updated", changed);
    window.addEventListener("focus", flush);
    return () => {
      active = false;
      window.removeEventListener("gather:history-updated", changed);
      window.removeEventListener("focus", flush);
    };
  }, [scope]);
  const inFlight = useRef(new Set<string>());
  const queuedDeliveries = useRef(new Set<string>());
  const deliveryChains = useRef(new Map<string, Promise<void>>());
  const blockedGroups = useRef(new Map<string, string>());
  const sendControllers = useRef(new Map<string, AbortController>());

  const cursors = useRef(new Map<string, number>());
  const changeCursors = useRef(new Map<string, number>());
  const changing = useRef(new Map<string, Promise<void>>());
  const loads = useRef(new Map<string, Promise<void>>());
  const backfills = useRef(new Set<string>());
  const archiveQueue = useRef<Promise<void>>(Promise.resolve());
  function noteTyping(active: boolean) {
    const previous = typingSent.current;
    if (previous.active && (!active || previous.groupId !== selected)) {
      socket.current?.emit("typing", {
        groupId: previous.groupId,
        active: false,
      });
      previous.active = false;
    }
    if (
      active &&
      !groupsRef.current
        .find((g) => g.id === selected)
        ?.access?.match(/left|removed/) &&
      selected &&
      socket.current?.connected &&
      (!previous.active ||
        previous.groupId !== selected ||
        Date.now() - previous.at >= 1500)
    ) {
      socket.current.emit("typing", { groupId: selected, active: true });
      typingSent.current = { groupId: selected, at: Date.now(), active: true };
    }
  }
  useEffect(() => () => noteTyping(false), [selected]);
  useEffect(() => {
    const entries = Object.values(typists);
    if (!entries.length) return;
    const timer = setTimeout(
      () =>
        setTypists((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([, person]) => person.until > Date.now(),
            ),
          ),
        ),
      Math.max(0, Math.min(...entries.map((p) => p.until)) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [typists]);
  const displayMessage = useCallback((message: Message) => {
    outbox.current = outbox.current.filter(
      (m) => m.clientId !== message.clientId || m.userId !== message.userId,
    );
    setMessages((current) => {
      const rows = current[message.groupId] ?? [];
      if (
        focusedWindows.current.has(message.groupId) &&
        !rows.some((m) => m.id === message.id) &&
        (message.sequence > (rows.at(-1)?.sequence ?? 0) ||
          message.sequence < (rows[0]?.sequence ?? 0))
      ) {
        setHasNewer((state) => ({ ...state, [message.groupId]: true }));
        return current;
      }
      return { ...current, [message.groupId]: mergeMessages(rows, [message]) };
    });
    setGroups((current) =>
      current.map((g) =>
        g.id === message.groupId &&
        (!g.lastMessage ||
          g.lastMessage.sequence < message.sequence ||
          (g.lastMessage.sequence === message.sequence &&
            (g.lastMessage.revision ?? 0) <= (message.revision ?? 0)))
          ? { ...g, lastMessage: message }
          : g,
      ),
    );
  }, []);
  const accept = useCallback(
    async (message: Message) => {
      const epoch = lifetime.current;
      try {
        await prepareStorage();
        await history({
          operation: "apply",
          scope,
          groupId: message.groupId,
          messages: [message],
        });
        if (message.attachments?.length)
          void cacheMedia({
            operation: "observe",
            scope,
            messageKey: mediaMessageKey(message),
            deleted: false,
            attachments: message.attachments,
          }).catch(() => {});
      } catch {
        if (epoch === lifetime.current)
          setError(
            "A message reached the server but could not be saved on this device. Check free storage; keep Gather open.",
          );
      }
      if (epoch === lifetime.current) displayMessage(message);
    },
    [scope, prepareStorage, displayMessage],
  );
  const loadMessages = useCallback(
    (id: string, before?: number): Promise<void> => {
      const key = `${lifetime.current}:${syncEpoch.current}:${id}:${before ?? "latest"}`;
      const pending = loads.current.get(key);
      if (pending) return pending;
      const task = (async () => {
        const epoch = lifetime.current;
        const syncVersion = syncEpoch.current;
        await prepareStorage();
        const cached = await history<{ messages: Message[]; hasMore: boolean }>(
          { operation: "page", scope, groupId: id, before },
        );
        if (epoch !== lifetime.current || syncVersion !== syncEpoch.current)
          return;
        const show = before !== undefined || !focusedWindows.current.has(id);
        if (
          cached.messages.length &&
          show &&
          (before === undefined || !syncReady.current)
        ) {
          setMessages((current) => ({
            ...current,
            [id]: mergeMessages(current[id] || [], cached.messages),
          }));
          setHasMore((current) => ({
            ...current,
            [id]: cached.hasMore || (before === undefined && current[id]),
          }));
        }
        if (
          groupsRef.current
            .find((g) => g.id === id)
            ?.access?.match(/left|removed/)
        ) {
          setHasMore((current) => ({ ...current, [id]: cached.hasMore }));
          return;
        }

        if (!syncReady.current) return;
        let more = true;
        while (
          more &&
          !groupsRef.current
            .find((g) => g.id === id)
            ?.access?.match(/left|removed/)
        ) {
          const after =
            before === undefined ? cursors.current.get(id) : undefined;
          let result: { messages: Message[]; hasMore: boolean };
          try {
            result = await api(
              transport,
              `/api/groups/${id}/messages${before !== undefined ? `?before=${before}` : after !== undefined ? `?after=${after}` : ""}`,
            );
          } catch (error) {
            if (cached.messages.length) {
              if (show)
                setMessages((current) => ({
                  ...current,
                  [id]: mergeMessages(current[id] ?? [], cached.messages),
                }));
              setHasMore((current) => ({ ...current, [id]: cached.hasMore }));
              return;
            }
            throw error;
          }
          if (syncVersion !== syncEpoch.current) return;
          const nextCursor = result.messages.at(-1)?.sequence ?? after ?? 0;
          await history({
            operation: "apply",
            scope,
            groupId: id,
            messages: result.messages,
            ...(before === undefined ? { cursor: nextCursor } : {}),
          });
          for (const m of result.messages)
            if (m.attachments?.length)
              void cacheMedia({
                operation: "observe",
                scope,
                messageKey: mediaMessageKey(m),
                deleted: false,
                attachments: m.attachments,
              }).catch(() => {});
          if (epoch !== lifetime.current) return;
          const received = new Set(
            result.messages.map((m) => `${m.userId}:${m.clientId}`),
          );
          outbox.current = outbox.current.filter(
            (m) => !received.has(`${m.userId}:${m.clientId}`),
          );
          if (show)
            setMessages((current) => ({
              ...current,
              [id]: mergeMessages(current[id] || [], result.messages),
            }));
          // hasMore describes the oldest displayed history, not catch-up pages.
          if (show && (before !== undefined || after === undefined))
            setHasMore((current) => ({
              ...current,
              [id]: result.hasMore || (before === undefined && cached.hasMore),
            }));
          if (before === undefined) cursors.current.set(id, nextCursor);
          more =
            after !== undefined && result.hasMore && result.messages.length > 0;
        }
      })().finally(() => loads.current.delete(key));
      loads.current.set(key, task);
      return task;
    },
    [transport, scope, prepareStorage],
  );
  const archiveOlder = useCallback(
    (id: string) => {
      const epoch = lifetime.current;
      const syncVersion = syncEpoch.current;
      const key = `${epoch}:${id}`;
      if (backfills.current.has(key)) return;
      backfills.current.add(key);
      archiveQueue.current = archiveQueue.current
        .catch(() => {})
        .then(async () => {
          let before: number | undefined;
          while (
            epoch === lifetime.current &&
            !groupsRef.current
              .find((g) => g.id === id)
              ?.access?.match(/left|removed/)
          ) {
            const cached = await history<{ messages: Message[] }>({
              operation: "page",
              scope,
              groupId: id,
              before,
            });
            if (cached.messages.length) {
              before = cached.messages[0].sequence;
              continue;
            }
            if (before === undefined) return;
            const result = await api<{ messages: Message[]; hasMore: boolean }>(
              transport,
              `/api/groups/${id}/messages?before=${before}`,
            );
            if (syncVersion !== syncEpoch.current) return;
            await history({
              operation: "apply",
              scope,
              groupId: id,
              messages: result.messages,
            });
            if (!result.hasMore || !result.messages.length) return;
            before = result.messages[0].sequence;
            // Background history should leave request capacity for active chat.
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        })
        .catch(() => {
          // Foreground synchronization reports connectivity/storage failures. An
          // incomplete archive resumes from its oldest saved page next refresh.
        })
        .finally(() => backfills.current.delete(key));
    },
    [scope, transport],
  );
  const syncChanges = useCallback(
    (groupId: string) => {
      const pending = changing.current.get(groupId);
      if (pending) return pending;
      const epoch = lifetime.current;
      const task = (async () => {
        const syncVersion = syncEpoch.current;
        while (
          epoch === lifetime.current &&
          !groupsRef.current
            .find((g) => g.id === groupId)
            ?.access?.match(/left|removed/)
        ) {
          const result = await api<{
            changes: { sequence: number; message: Message }[];
            hasMore: boolean;
          }>(
            transport,
            `/api/groups/${groupId}/changes?after=${changeCursors.current.get(groupId) ?? 0}`,
          );
          if (syncVersion !== syncEpoch.current) return;
          const cursor = result.changes.at(-1)?.sequence;
          if (cursor === undefined) return;
          const records = [
            ...new Map(
              result.changes.map((change) => [
                change.message.id,
                change.message,
              ]),
            ).values(),
          ];
          await history({
            operation: "apply",
            scope,
            groupId,
            messages: records,
            changeCursor: cursor,
          });
          if (epoch !== lifetime.current) return;
          changeCursors.current.set(groupId, cursor);
          setMessages((current) => ({
            ...current,
            [groupId]: (current[groupId] ?? []).map((message) => {
              const updated = records.find(
                (record) => record.id === message.id,
              );
              return updated &&
                (updated.revision ?? 0) >= (message.revision ?? 0)
                ? updated
                : message;
            }),
          }));
          if (!result.hasMore) return;
        }
      })().finally(() => changing.current.delete(groupId));
      changing.current.set(groupId, task);
      return task;
    },
    [scope, transport],
  );
  const refresh = useCallback((): Promise<void> => {
    if (refreshTask.current) return refreshTask.current;
    const task = (async () => {
      const epoch = lifetime.current;
      const requestEpoch = syncEpoch.current;
      const revision = selectionRevision.current;
      let restored = false;
      await prepareStorage();
      const known = new Map(
        groupsRef.current.map((group) => [
          group.id,
          group.controlRevision ?? 0,
        ]),
      );
      const data = await api<Bootstrap>(transport, "/api/bootstrap");
      if (epoch !== lifetime.current || requestEpoch !== syncEpoch.current)
        return;
      for (const departure of data.departures ?? [])
        await loseAccess(departure);
      if (data.generation) {
        const key = `gather.generation.${scope}`,
          previous = localStorage.getItem(key);
        if (previous && previous !== data.generation) {
          restored = true;
          syncEpoch.current++;
          for (const controller of sendControllers.current.values())
            controller.abort();
          const archiveId = [
            ...new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`${previous}:${data.generation}`),
              ),
            ),
          ]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          await history({
            operation: "archiveMirror",
            scope,
            id: archiveId,
            name: `Before server restore · ${new Date().toLocaleDateString()}`,
            person: session.user.name,
          });
          focusedWindows.current.clear();
          setHasMore({});
          setHasNewer({});
          setMessages({});

          cursors.current.clear();
          changeCursors.current.clear();
          accessChanges.current.clear();
          for (const message of outbox.current) {
            await history({
              operation: "outboxControl",
              scope,
              clientId: message.clientId,
              paused: true,
            });
            message.paused = true;
          }
          setMessages(
            Object.fromEntries(
              [...new Set(outbox.current.map((m) => m.groupId))].map((id) => [
                id,
                outbox.current.filter((m) => m.groupId === id),
              ]),
            ),
          );
          window.dispatchEvent(
            new CustomEvent("gather:server-restored", { detail: { scope } }),
          );
          groupsRef.current = groupsRef.current.map((g) => ({
            ...g,
            controlRevision: -1,
            access: "removed" as const,
            inviteCode: "",
            members: [],
            lastMessage: null,
          }));
          setGroups(groupsRef.current);
          setError(
            "The server was restored. Earlier history is in History & archives; unsent messages are paused for review.",
          );
        }
        try {
          localStorage.setItem(key, data.generation);
        } catch {
          throw new Error(
            "Could not save synchronization state. Your unsent messages remain on this device.",
          );
        }
      }
      syncReady.current = true;
      await saveGroups(data.groups);
      for (const group of groupsRef.current.filter(
        (g) =>
          !data.groups.some((remote) => remote.id === g.id) &&
          (data.departures?.some((d) => d.groupId === g.id) ||
            known.get(g.id) === (g.controlRevision ?? 0)),
      ))
        await loseAccess(
          data.departures?.find((d) => d.groupId === group.id) ?? {
            groupId: group.id,
            access: group.access === "left" ? "left" : "removed",
            controlRevision: group.controlRevision ?? 0,
          },
        );
      setOnline(data.onlineIds);
      setVoice(data.voice);
      setVoiceAvailable(data.voiceAvailable);
      setVoiceLimit(data.voiceLimit ?? 2);
      setCapabilities(data.capabilities ?? []);
      if (revision === selectionRevision.current)
        setSelected((current) =>
          groupsRef.current.some((g) => g.id === current)
            ? current
            : data.groups[0]?.id || "",
        );
      setInitialized(true);
      setError(
        restored
          ? "The server was restored. Earlier history is in History & archives; unsent messages are paused for review."
          : "",
      );
      // One bounded sync stream per conversation. Sequential background work
      // avoids a request burst when somebody returns to many conversations.
      if (selectedRef.current) await loadMessages(selectedRef.current);
      for (const group of data.groups) {
        if (epoch !== lifetime.current) return;
        if (group.id !== selectedRef.current) await loadMessages(group.id);
        if (data.capabilities?.includes("message-changes-v1"))
          await syncChanges(group.id);
        archiveOlder(group.id);
      }
    })().finally(() => {
      if (refreshTask.current === task) refreshTask.current = null;
    });
    refreshTask.current = task;
    return task;
  }, [
    transport,
    scope,
    loadMessages,
    prepareStorage,
    archiveOlder,
    syncChanges,
    saveGroups,
    loseAccess,
  ]);
  useEffect(() => {
    const epoch = ++lifetime.current;
    let active = true;
    let client: RealtimeClient | undefined;
    let bootstrapRetry: ReturnType<typeof setTimeout> | undefined;
    let bootstrapDelay = 1000;
    const notifier = createMessageNotifier(transport, () => ({
      selected: selectedRef.current,
      groups: groupsRef.current,
    }));
    void (async () => {
      await prepareStorage();
      const cached = await history<HistoryState>({ operation: "state", scope });
      if (!active) return;
      outbox.current = cached.outbox
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((message) => ({
          ...message,
          status: "failed",
        }));
      cursors.current = new Map(Object.entries(cached.cursors));
      changeCursors.current = new Map(
        Object.entries(cached.changeCursors ?? {}),
      );
      if (!groupsRef.current.length) applyGroups(cached.groups);
      setSelected((current) => current || cached.groups[0]?.id || "");
      if (cached.groups.length) setInitialized(true);
      for (const message of outbox.current)
        setMessages((current) => ({
          ...current,
          [message.groupId]: mergeMessages(current[message.groupId] || [], [
            message,
          ]),
        }));
      client = new RealtimeClient(transport);
      socket.current = client;
      const synchronizeConnection = () => {
        clearTimeout(bootstrapRetry);
        void (async () => {
          do {
            await refresh();
          } while (active && client?.connected && !syncReady.current);
          if (!active || !client?.connected || !syncReady.current) return;
          bootstrapDelay = 1000;
          setConnection("connected");
          blockedGroups.current.clear();
          for (const message of outbox.current) void deliver(message);
        })().catch((e) => {
          if (!active) return;
          setError(e.message);
          if (client?.connected) {
            bootstrapRetry = setTimeout(synchronizeConnection, bootstrapDelay);
            bootstrapDelay = Math.min(30000, bootstrapDelay * 2);
          }
        });
      };
      client.on("connect", () => {
        setConnection("connecting");
        synchronizeConnection();
      });
      client.on("disconnect", () => {
        clearTimeout(bootstrapRetry);
        syncReady.current = false;
        syncEpoch.current++;
        setConnection("offline");
        setTypists({});
        typingSent.current.active = false;
        rings.reset();
      });
      rings.attach(client);
      client.on("typing", (person: Typing) => {
        if (person.userId === session.user.id) return;
        setTypists((current) => {
          const next = { ...current };
          if (person.active)
            next[person.connectionId] = { ...person, until: Date.now() + 5000 };
          else if (next[person.connectionId]?.groupId === person.groupId)
            delete next[person.connectionId];
          return next;
        });
      });
      client.on("connect_error", () => setConnection("offline"));
      client.on(
        "message",
        ({ changeKind, ...message }: Message & { changeKind?: string }) => {
          if (syncReady.current) {
            void accept(message);
            void notifier.receive(message, changeKind);
            if (
              changeKind === "create" &&
              message.userId !== session.user.id &&
              !readNotificationPreferences(session).muted.includes(
                message.groupId,
              )
            )
              playSound("message");
          }
        },
      );
      client.on("group", (group: Group) => {
        if (!syncReady.current) return;
        void saveGroups([group]).catch(() => {
          setError(
            "A conversation update could not be saved on this device. Check free storage.",
          );
        });
      });
      client.on(
        "group-access",
        (departure: NonNullable<Bootstrap["departures"]>[number]) => {
          void loseAccess(departure).catch(() =>
            setError(
              "Your membership changed, but could not be saved on this device. Reconnect to refresh.",
            ),
          );
        },
      );
      client.on("state", (state: Pick<Bootstrap, "onlineIds" | "voice">) => {
        setOnline(state.onlineIds);
        setVoice(state.voice);
      });
      client.on(
        "membership-state",
        (state: Pick<Bootstrap, "onlineIds" | "voice">) => {
          setOnline(state.onlineIds);
          setVoice(state.voice);
        },
      );
      client.on(
        "presence",
        ({ userId, online: isOnline }: { userId: string; online: boolean }) =>
          setOnline((current) =>
            isOnline
              ? [...new Set([...current, userId])]
              : current.filter((id) => id !== userId),
          ),
      );
      client.on(
        "voice",
        ({ groupId, userIds }: { groupId: string; userIds: string[] }) =>
          setVoice((current) => ({ ...current, [groupId]: userIds })),
      );
      refresh().catch((e) => setError(e.message));
    })().catch((error) => {
      if (active)
        setError(error.message || "Your local history could not be opened.");
    });
    return () => {
      active = false;
      clearTimeout(bootstrapRetry);
      notifier.dispose();
      if (lifetime.current === epoch) lifetime.current++;
      client?.disconnect();
      for (const controller of sendControllers.current.values())
        controller.abort();
      if (socket.current === client) socket.current = null;
    };
  }, [
    transport,
    scope,
    prepareStorage,
    rings.attach,
    rings.reset,
    accept,
    refresh,
    applyGroups,
    saveGroups,
    loseAccess,
  ]);
  useEffect(() => {
    if (!selected) return;
    localStorage.setItem(`gather.selected.${session.user.id}`, selected);
    let active = true;
    if (focusedWindows.current.has(selected)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    loadMessages(selected)
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected, loadMessages, session.user.id]);
  function deliver(message: Message, force = false): Promise<void> {
    if (message.paused || queuedDeliveries.current.has(message.clientId))
      return Promise.resolve();
    queuedDeliveries.current.add(message.clientId);
    const epoch = lifetime.current;
    const task = (
      deliveryChains.current.get(message.groupId) ?? Promise.resolve()
    )
      .catch(() => {})
      .then(async () => {
        if (epoch !== lifetime.current) return;
        const current = outbox.current.find(
          (m) => m.clientId === message.clientId,
        );
        const blocker = blockedGroups.current.get(message.groupId);
        if (
          blocker &&
          !outbox.current.some((m) => m.clientId === blocker && !m.paused)
        )
          blockedGroups.current.delete(message.groupId);
        if (
          !current ||
          current.paused ||
          (blockedGroups.current.has(message.groupId) && !force)
        )
          return;
        await attempt(current);
        if (
          outbox.current.some(
            (m) => m.clientId === message.clientId && !m.paused,
          )
        )
          blockedGroups.current.set(message.groupId, message.clientId);
        else {
          blockedGroups.current.delete(message.groupId);
          for (const pending of outbox.current.filter(
            (m) => m.groupId === message.groupId && !m.paused,
          ))
            void deliver(pending);
        }
      })
      .finally(() => {
        queuedDeliveries.current.delete(message.clientId);
        if (deliveryChains.current.get(message.groupId) === task)
          deliveryChains.current.delete(message.groupId);
      });
    deliveryChains.current.set(message.groupId, task);
    return task;
  }
  async function attempt(message: Message) {
    if (!syncReady.current) return;
    if (
      groupsRef.current
        .find((g) => g.id === message.groupId)
        ?.access?.match(/left|removed/)
    )
      return;
    if (inFlight.current.has(message.clientId)) return;
    inFlight.current.add(message.clientId);
    const controller = new AbortController();
    sendControllers.current.set(message.clientId, controller);
    setMessages((current) => ({
      ...current,
      [message.groupId]: (current[message.groupId] || []).map((m) =>
        m.clientId === message.clientId ? { ...m, status: "sending" } : m,
      ),
    }));
    try {
      for (const [index, attachment] of (message.attachments ?? []).entries()) {
        setTransfers((current) => ({
          ...current,
          [message.clientId]: `Uploading ${index + 1} of ${message.attachments!.length}…`,
        }));
        await uploadMedia(
          session,
          message.groupId,
          attachment,
          AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
        );
      }
      setTransfers((current) => ({
        ...current,
        [message.clientId]: "Sending…",
      }));
      const result = await api<Message>(
        session,
        `/api/groups/${message.groupId}/messages`,
        {
          method: "POST",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(12000),
          ]),
          body: JSON.stringify({
            replyTo: message.replyTo,
            clientId: message.clientId,
            body: message.body,
            attachmentIds: message.attachments?.map((a) => a.id) ?? [],
          }),
        },
      );
      await accept(result);
    } catch (error) {
      if (message.attachments?.length && !controller.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : "Your file could not be sent. It is saved for retry.",
        );
      // A socket acknowledgement may have arrived even when the HTTP response was lost.
      if (outbox.current.some((m) => m.clientId === message.clientId)) {
        outbox.current = outbox.current.map((m) =>
          m.clientId === message.clientId ? { ...m, status: "failed" } : m,
        );
        await history({
          operation: "fail",
          scope,
          clientId: message.clientId,
        }).catch(() => {
          setError(
            "Your sending queue could not be updated. Your message remains saved for retry.",
          );
        });
        setMessages((current) => ({
          ...current,
          [message.groupId]: (current[message.groupId] || []).map((m) =>
            m.clientId === message.clientId ? { ...m, status: "failed" } : m,
          ),
        }));
      }
    } finally {
      inFlight.current.delete(message.clientId);
      sendControllers.current.delete(message.clientId);
      setTransfers((current) => {
        const next = { ...current };
        delete next[message.clientId];
        return next;
      });
    }
  }
  async function showLatest(groupId: string) {
    focusedWindows.current.delete(groupId);
    setHasNewer((current) => ({ ...current, [groupId]: false }));
    cursors.current.delete(groupId);
    setMessages((current) => ({
      ...current,
      [groupId]: outbox.current.filter((m) => m.groupId === groupId),
    }));
    await loadMessages(groupId);
  }
  async function send(body: string, files: File[] = [], replyTo?: string) {
    if (
      groupsRef.current
        .find((g) => g.id === selected)
        ?.access?.match(/left|removed/)
    )
      return false;
    if ((!body.trim() && !files.length) || !selected) return false;
    if (files.length > 4) {
      setError("Choose up to four files per message.");
      return false;
    }
    noteTyping(false);
    const message: Message = {
      replyTo,
      id: crypto.randomUUID(),
      clientId: crypto.randomUUID(),
      sequence: 0,
      groupId: selected,
      userId: session.user.id,
      name: session.user.name,
      body:
        body.trim() ||
        files
          .map((file) => file.name)
          .join(", ")
          .slice(0, 4000),
      createdAt: Date.now(),
      status: "queued",
    };
    try {
      await prepareStorage();
      const attachments: Attachment[] = [];
      try {
        for (const file of files)
          attachments.push(
            await stageFile(session, file, mediaMessageKey(message)),
          );
      } catch (error) {
        for (const attachment of attachments)
          void unpinMedia(session, attachment.id).catch(() => {});
        throw error;
      }
      if (attachments.length) message.attachments = attachments;
      await history({ operation: "queue", scope, message });
      playSound("sent");
    } catch (error) {
      for (const attachment of message.attachments ?? [])
        void unpinMedia(session, attachment.id).catch(() => {});
      setError(
        error instanceof AttachmentInputError
          ? `${error.message} Your draft has been kept.`
          : "Your message could not be saved on this device. Check free storage; your draft has been kept.",
      );
      return false;
    }
    outbox.current.push(message);
    if (focusedWindows.current.has(selected))
      void showLatest(selected).catch(() => {});
    setMessages((current) => ({
      ...current,
      [selected]: mergeMessages(current[selected] || [], [message]),
    }));
    void deliver(message);
    return true;
  }
  async function createGroup(name: string) {
    const group = await api<Group>(session, "/api/groups", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await saveGroups([group]);
    select(group.id);
  }
  async function joinGroup(code: string) {
    const group = await api<Group>(session, "/api/groups/join", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    await saveGroups([group]);
    select(group.id);
  }
  return {
    groups,
    selected,
    select,
    messages: messages[selected] || [],
    online,
    voice,
    voiceAvailable,
    voiceLimit,
    rings,
    capabilities,
    typing: [
      ...new Map(
        Object.values(typists)
          .filter((p) => p.groupId === selected)
          .map((p) => [p.userId, p]),
      ).values(),
    ],
    noteTyping,
    connection,
    error,
    setError,
    loading,
    initialized,
    hasMore: hasMore[selected],
    hasNewer: hasNewer[selected] ?? false,
    loadLatest: () => showLatest(selected),
    loadNewer: async () => {
      const after =
        messages[selected]?.filter((m) => !m.status).at(-1)?.sequence ?? 0;
      let page = await history<{ messages: Message[]; hasMore: boolean }>({
        operation: "page",
        scope,
        groupId: selected,
        after,
      });
      const group = groupsRef.current.find((g) => g.id === selected);
      if (
        page.messages.length < 50 &&
        (!group?.access || group.access === "active")
      ) {
        const remote = await api<{ messages: Message[]; hasMore: boolean }>(
          session,
          `/api/groups/${selected}/messages?after=${after}`,
        );
        await history({
          operation: "apply",
          scope,
          groupId: selected,
          messages: remote.messages,
        });
        page = {
          messages: mergeMessages(page.messages, remote.messages),
          hasMore: page.hasMore || remote.hasMore,
        };
      }
      setMessages((current) => ({
        ...current,
        [selected]: mergeMessages(current[selected] ?? [], page.messages),
      }));
      const remaining =
        page.hasMore ||
        (page.messages.at(-1)?.sequence ?? after) <
          (group?.lastMessage?.sequence ?? 0);
      setHasNewer((current) => ({ ...current, [selected]: remaining }));
      if (!remaining) focusedWindows.current.delete(selected);
    },
    loadOlder: () =>
      loadMessages(
        selected,
        messages[selected]?.find((m) => !m.status)?.sequence,
      ),
    send,
    retry: (m: Message) => deliver({ ...m, paused: false }, true),
    queueControl: async (
      message: Message,
      action: "pause" | "resume" | "edit" | "discard",
    ) => {
      if (!outbox.current.some((m) => m.clientId === message.clientId))
        return false;
      const blocker = blockedGroups.current.get(message.groupId);
      if (
        action === "resume" &&
        blocker &&
        blocker !== message.clientId &&
        outbox.current.some((m) => m.clientId === blocker && !m.paused)
      )
        throw new Error("Retry or pause the earlier unsent message first.");
      if (action === "pause" || action === "resume") {
        await history({
          operation: "outboxControl",
          scope,
          clientId: message.clientId,
          paused: action === "pause",
        });
        const updated = {
          ...message,
          paused: action === "pause",
          status: "failed" as const,
        };
        outbox.current = outbox.current.map((m) =>
          m.clientId === message.clientId ? updated : m,
        );
        setMessages((current) => ({
          ...current,
          [message.groupId]: (current[message.groupId] ?? []).map((m) =>
            m.clientId === message.clientId ? updated : m,
          ),
        }));
        if (action === "pause") {
          sendControllers.current.get(message.clientId)?.abort();
          if (blockedGroups.current.get(message.groupId) === message.clientId) {
            blockedGroups.current.delete(message.groupId);
            for (const pending of outbox.current.filter(
              (m) => m.groupId === message.groupId && !m.paused,
            ))
              void deliver(pending);
          }
        } else void deliver(updated, true);
        return true;
      }
      await history({
        operation: "outboxControl",
        scope,
        clientId: message.clientId,
        paused: true,
      });
      outbox.current = outbox.current.map((m) =>
        m.clientId === message.clientId ? { ...m, paused: true } : m,
      );
      sendControllers.current.get(message.clientId)?.abort();
      const result = await api<{ message: Message | null }>(
        session,
        `/api/groups/${message.groupId}/outbox/${message.clientId}`,
        {
          method: "POST",
          body: JSON.stringify({
            action: "cancel",
            ...(action === "discard"
              ? {
                  discardAttachments:
                    message.attachments?.map((a) => a.id) ?? [],
                }
              : {}),
          }),
        },
      );
      if (result.message) {
        await accept(result.message);
        if (blockedGroups.current.get(message.groupId) === message.clientId) {
          blockedGroups.current.delete(message.groupId);
          for (const pending of outbox.current.filter(
            (m) => m.groupId === message.groupId && !m.paused,
          ))
            void deliver(pending);
        }
        return false;
      }
      if (action === "discard") {
        await history({
          operation: "outboxControl",
          scope,
          clientId: message.clientId,
          discard: true,
        });
        outbox.current = outbox.current.filter(
          (m) => m.clientId !== message.clientId,
        );
        if (blockedGroups.current.get(message.groupId) === message.clientId) {
          blockedGroups.current.delete(message.groupId);
          for (const pending of outbox.current.filter(
            (m) => m.groupId === message.groupId && !m.paused,
          ))
            void deliver(pending);
        }
        setMessages((current) => ({
          ...current,
          [message.groupId]: (current[message.groupId] ?? []).filter(
            (m) => m.clientId !== message.clientId,
          ),
        }));
        for (const a of message.attachments ?? [])
          void unpinMedia(session, a.id).catch(() => {});
      } else {
        const updated = {
          ...message,
          paused: true,
          cancelled: true,
          status: "failed" as const,
        };
        // Keep originals and the immutable original until a replacement is durably queued.
        outbox.current = outbox.current.map((m) =>
          m.clientId === message.clientId ? updated : m,
        );
        await history({
          operation: "outboxControl",
          scope,
          clientId: message.clientId,
          paused: true,
          cancelled: true,
        });
        setMessages((current) => ({
          ...current,
          [message.groupId]: (current[message.groupId] ?? []).map((m) =>
            m.clientId === message.clientId ? updated : m,
          ),
        }));
      }
      return true;
    },
    resendDraft: async (message: Message, body: string) => {
      if (!body.trim() && !message.attachments?.length)
        throw new Error("Enter a message.");
      const next = {
        ...message,
        id: crypto.randomUUID(),
        clientId: crypto.randomUUID(),
        body: body.trim(),
        createdAt: Date.now(),
        paused: false,
        cancelled: false,
        status: "queued" as const,
      };
      const staged: Attachment[] = [];
      try {
        for (const attachment of message.attachments ?? []) {
          const blob = await loadMedia(
            session,
            attachment,
            undefined,
            scope,
            false,
            mediaMessageKey(message),
          );
          staged.push(
            await stageFile(
              session,
              new File([blob], attachment.name, { type: attachment.type }),
              mediaMessageKey(next),
            ),
          );
        }
        next.attachments = staged;
        await history({
          operation: "queue",
          scope,
          message: next,
          replaceClientId: message.clientId,
        });
      } catch (error) {
        for (const file of staged)
          void unpinMedia(session, file.id).catch(() => {});
        throw error;
      }
      for (const attachment of message.attachments ?? []) {
        void unpinMedia(session, attachment.id).catch(() => {});
        void api(session, `/api/uploads/${attachment.id}/cancel`, {
          method: "POST",
        }).catch(() => {});
      }

      outbox.current = outbox.current.filter(
        (m) => m.clientId !== message.clientId,
      );
      outbox.current.push(next);
      setMessages((current) => ({
        ...current,
        [message.groupId]: mergeMessages(
          (current[message.groupId] ?? []).filter(
            (m) => m.clientId !== message.clientId,
          ),
          [next],
        ),
      }));
      void deliver(next, true);
    },
    jumpTo: async (groupId: string, id: string) => {
      let found = await history<Message | null>({
        operation: "lookup",
        scope,
        groupId,
        id,
      });
      if (!found)
        found = await api<Message>(
          session,
          `/api/groups/${groupId}/message/${id}`,
        );
      const [before, after] = await Promise.all([
        history<{ messages: Message[]; hasMore: boolean }>({
          operation: "page",
          scope,
          groupId,
          before: found.sequence + 1,
        }),
        history<{ messages: Message[]; hasMore: boolean }>({
          operation: "page",
          scope,
          groupId,
          after: found.sequence,
        }),
      ]);
      if (!before.messages.some((m) => m.id === id))
        before.messages.push(found);
      await history({
        operation: "apply",
        scope,
        groupId,
        messages: [...before.messages, ...after.messages],
      });
      focusedWindows.current.add(groupId);
      setMessages((current) => ({
        ...current,
        [groupId]: mergeMessages([], [...before.messages, ...after.messages]),
      }));
      setHasMore((current) => ({ ...current, [groupId]: before.hasMore }));
      setHasNewer((current) => ({
        ...current,
        [groupId]:
          after.hasMore ||
          (after.messages.at(-1)?.sequence ?? found.sequence) <
            (groupsRef.current.find((g) => g.id === groupId)?.lastMessage
              ?.sequence ?? 0),
      }));
      select(groupId);
    },
    react: async (message: Message, emoji: string, active: boolean) => {
      const updated = await api<Message>(
        session,
        `/api/messages/${message.id}/reactions`,
        { method: "POST", body: JSON.stringify({ emoji, active }) },
      );
      await accept(updated);
    },
    transfers,
    membership: async (
      group: Group,
      action: "remove" | "rotate" | "transfer" | "leave",
      userId?: string,
    ) => {
      if (!socket.current?.connected)
        throw new Error("Reconnect before changing chat membership.");
      try {
        const result = await api<
          Group | NonNullable<Bootstrap["departures"]>[number]
        >(session, `/api/groups/${group.id}/membership`, {
          method: "POST",
          body: JSON.stringify({
            action,
            userId,
            revision: group.controlRevision,
          }),
        });
        if ("groupId" in result) await loseAccess(result);
        else await saveGroups([result]);
      } catch (error) {
        // Recover the authoritative outcome after a lost response or a concurrent owner action.
        await refresh().catch(() => {});
        throw error;
      }
    },
    renameGroup: async (id: string, name: string) => {
      if (!socket.current?.connected)
        throw new Error("Reconnect before changing the chat name.");
      const group = await api<Group>(session, `/api/groups/${id}/profile`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      await saveGroups([group]);
    },
    edit: async (message: Message, body: string, baseRevision: number) => {
      if (!socket.current?.connected)
        throw new Error("Reconnect before saving. Your edit is still here.");
      const updated = await api<Message>(
        session,
        `/api/messages/${message.id}/edit`,
        { method: "POST", body: JSON.stringify({ body, baseRevision }) },
      );
      await accept(updated);
    },
    deleteMessage: async (message: Message) => {
      if (!socket.current?.connected)
        throw new Error("Reconnect before deleting this message.");
      const updated = await api<Message>(
        session,
        `/api/messages/${message.id}/delete`,
        { method: "POST" },
      );
      await accept(updated);
    },
    createGroup,
    joinGroup,
    socket,
    refresh,
  };
}
