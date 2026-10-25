import { validateHistoryMessage } from "./history-message.mjs";
import { parseArchive } from "./archive-format.mjs";
export { validateHistoryMessage } from "./history-message.mjs";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text = (value, max) => typeof value === "string" && value.length <= max;
const id = (value) => typeof value === "string" && uuid.test(value);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
export function validateHistoryCommand(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !text(value.scope, 512) ||
    !value.scope
  )
    throw new Error("Invalid history scope.");
  switch (value.operation) {
    case "state":
    case "archives":
    case "mediaCleanup":
      break;
    case "mediaCleanupDone":
      if (
        !Array.isArray(value.messageKeys) ||
        value.messageKeys.length > 100 ||
        value.messageKeys.some(
          (key) =>
            typeof key !== "string" ||
            key.split(":").length !== 2 ||
            !key.split(":").every(id),
        )
      )
        throw new Error("Invalid media cleanup acknowledgement.");
      break;
    case "importArchive":
      if (!text(value.name, 128) || !value.name.trim())
        throw new Error("Choose an archive name.");
      return { ...value, archive: parseArchive(value.archive) };
    case "deleteArchive":
      if (typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id))
        throw new Error("Choose an imported archive.");
      break;
    case "bootstrap":
      if (!Array.isArray(value.groups) || value.groups.length > 500)
        throw new Error("Invalid cached conversations.");
      for (const group of value.groups)
        if (
          !group ||
          !id(group.id) ||
          !text(group.name, 128) ||
          !integer(group.createdAt) ||
          !Array.isArray(group.members) ||
          group.members.length > 500 ||
          JSON.stringify(group).length > 262144
        )
          throw new Error("Invalid cached conversation.");
      break;
    case "page":
      if (
        !id(value.groupId) ||
        (value.before !== undefined && !integer(value.before, 1)) ||
        (value.after !== undefined && !integer(value.after)) ||
        value.after === Number.MAX_SAFE_INTEGER ||
        (value.before !== undefined && value.after !== undefined) ||
        (value.limit !== undefined &&
          (!integer(value.limit, 1) || value.limit > 200))
      )
        throw new Error("Invalid local history page.");
      break;
    case "apply":
      if (
        !id(value.groupId) ||
        !Array.isArray(value.messages) ||
        value.messages.length > 200 ||
        (value.cursor !== undefined && !integer(value.cursor)) ||
        (value.changeCursor !== undefined && !integer(value.changeCursor))
      )
        throw new Error("Invalid history transaction.");
      for (const message of value.messages)
        validateHistoryMessage(message, value.groupId);
      if (
        value.cursor !== undefined &&
        value.messages.some((message) => message.sequence > value.cursor)
      )
        throw new Error("History cursor precedes its transaction.");
      break;
    case "queue":
      if (value.replaceClientId !== undefined && !id(value.replaceClientId))
        throw new Error("Invalid draft replacement.");
      validateHistoryMessage(value.message, value.message?.groupId, true);
      break;
    case "lookup":
      if (!id(value.groupId) || !id(value.id))
        throw new Error("Invalid history reference.");
      break;
    case "unread":
      if (
        !id(value.userId) ||
        !value.after ||
        Object.keys(value.after).length > 500 ||
        Object.entries(value.after).some(
          ([key, cutoff]) => !id(key) || !integer(cutoff),
        )
      )
        throw new Error("Invalid reading boundary.");
      break;
    case "archiveMirror":
      if (
        typeof value.id !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.id) ||
        !text(value.name, 128) ||
        !text(value.person, 128)
      )
        throw new Error("Invalid recovery archive.");
      break;
    case "resetSync":
      break;
    case "outboxControl":
      if (
        !id(value.clientId) ||
        (value.discard !== true && typeof value.paused !== "boolean")
      )
        throw new Error("Invalid queue control.");
      break;
    case "fail":
      if (!id(value.clientId)) throw new Error("Invalid queued message.");
      break;
    case "search":
      if (
        !text(value.query, 200) ||
        !value.query.trim() ||
        (value.groupId !== undefined && !id(value.groupId))
      )
        throw new Error("Invalid history search.");
      break;
    default:
      throw new Error("Unsupported history operation.");
  }
  return value;
}
export const normalizeSearch = (value) => value.normalize("NFKC").toLowerCase();
export const historyKey = (scope, id) => JSON.stringify([scope, id]);
export function mediaCleanupTask(message, previous, queued, existingTask) {
  const attachmentIds = [
    ...new Set([
      ...(message.deletedAttachmentIds ?? []),
      ...(previous?.attachments ?? []).map((a) => a.id),
      ...(queued?.attachments ?? []).map((a) => a.id),
      ...(existingTask?.attachmentIds ?? []),
    ]),
  ];
  if (attachmentIds.length > 4)
    throw new Error("Deleted attachment identity changed.");
  return { messageKey: `${message.userId}:${message.clientId}`, attachmentIds };
}
export function assertHistoryIdentity(existing, incoming) {
  if (
    existing &&
    ["id", "groupId", "userId", "clientId", "sequence"].some(
      (key) => existing[key] !== incoming[key],
    )
  )
    throw new Error("A saved message identity cannot be changed.");
}
export function assertQueuedIdentity(existing, incoming) {
  if (
    existing &&
    (["groupId", "userId", "clientId", "body", "replyTo"].some(
      (key) => existing[key] !== incoming[key],
    ) ||
      JSON.stringify(existing.attachments ?? []) !==
        JSON.stringify(incoming.attachments ?? []))
  )
    throw new Error("Queued message ID was already used.");
}

// A restore archive must include messages received before their group bootstrap.
export function mirrorGroups(groups, messages) {
  const byId = new Map(
    groups.map((g) => [g.id, { ...g, inviteCode: "", access: "left" }]),
  );
  for (const message of messages)
    if (!byId.has(message.groupId))
      byId.set(message.groupId, {
        id: message.groupId,
        name: "Saved chat",
        createdAt: message.createdAt,
        inviteCode: "",
        access: "left",
        members: [],
        lastMessage: null,
      });
  for (const group of byId.values()) {
    const rows = messages
      .filter((m) => m.groupId === group.id)
      .sort((a, b) => a.sequence - b.sequence);
    group.lastMessage = rows.at(-1) ?? null;
    if (!group.members.length)
      group.members = [
        ...new Map(
          rows.map((m) => [m.userId, { id: m.userId, name: m.name }]),
        ).values(),
      ];
  }
  return [...byId.values()];
}
