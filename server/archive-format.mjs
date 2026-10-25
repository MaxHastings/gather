import { validateHistoryMessage } from "./history-message.mjs";
export const MAX_ARCHIVE_BYTES = 20_000_000;
export const MAX_ARCHIVE_FILE_BYTES = 100_000_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const person = (value) => {
  if (
    !value ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 128
  )
    throw new Error("Archive contains an invalid person.");
  return { id: value.id, name: value.name };
};
// Archives are local evidence of past conversations, never authority to join a
// chat, authenticate a device, or republish historical messages.
export function parseArchive(value) {
  if (
    !value ||
    !["gather-export-v1", "gather-archive-v1"].includes(value.format) ||
    !Array.isArray(value.groups) ||
    value.groups.length > 500
  )
    throw new Error("Choose a supported Gather chat archive.");
  if (
    value.features !== undefined &&
    (!Array.isArray(value.features) ||
      value.features.some(
        (feature) =>
          ![
            "text",
            "attachments-v1",
            "reactions-v1",
            "message-mutations-v1",
            "replies-v1",
          ].includes(feature),
      ))
  )
    throw new Error("This archive needs a newer Gather version.");
  if (typeof value.exportedAt !== "string" || value.exportedAt.length > 64)
    throw new Error("Archive date is invalid.");
  const exportedAt = new Date(value.exportedAt);
  if (!Number.isFinite(exportedAt.getTime()))
    throw new Error("Archive date is invalid.");
  const ids = new Set(),
    clientIds = new Set(),
    groupIds = new Set();
  let count = 0;
  const groups = value.groups
    .map((group) => {
      if (
        !group ||
        typeof group.id !== "string" ||
        !uuid.test(group.id) ||
        groupIds.has(group.id) ||
        typeof group.name !== "string" ||
        !group.name.trim() ||
        group.name.length > 128 ||
        !Number.isSafeInteger(group.createdAt) ||
        group.createdAt < 0 ||
        group.createdAt > 8_640_000_000_000_000 ||
        !Array.isArray(group.members) ||
        group.members.length > 500 ||
        !Array.isArray(group.messages)
      )
        throw new Error("Archive contains an invalid conversation.");
      groupIds.add(group.id);
      const sequences = new Set();
      count += group.messages.length;
      if (count > 100000)
        throw new Error("This archive exceeds the supported message count.");
      const messages = group.messages
        .map((message) => {
          validateHistoryMessage(message, group.id);
          const key = JSON.stringify([message.userId, message.clientId]);
          if (
            ids.has(message.id) ||
            clientIds.has(key) ||
            sequences.has(message.sequence)
          )
            throw new Error("Archive contains duplicate message identities.");
          ids.add(message.id);
          clientIds.add(key);
          sequences.add(message.sequence);
          if (
            message.attachments?.length &&
            !value.features?.includes("attachments-v1")
          )
            throw new Error(
              "This archive needs attachment support from a newer Gather version.",
            );
          return {
            id: message.id,
            clientId: message.clientId,
            sequence: message.sequence,
            groupId: group.id,
            userId: message.userId,
            name: message.name,
            body: message.body,
            createdAt: message.createdAt,
            ...(message.contentRevision !== undefined
              ? { contentRevision: message.contentRevision }
              : {}),
            ...(message.replyTo ? { replyTo: message.replyTo } : {}),
            ...(message.editedAt !== undefined
              ? { editedAt: message.editedAt }
              : {}),
            ...(message.deletedAt !== undefined
              ? { deletedAt: message.deletedAt }
              : {}),
            ...(message.deletedAttachmentIds?.length
              ? { deletedAttachmentIds: [...message.deletedAttachmentIds] }
              : {}),
            ...(message.revision !== undefined
              ? { revision: message.revision }
              : {}),
            ...(message.reactions?.length
              ? {
                  reactions: message.reactions.map((r) => ({
                    emoji: r.emoji,
                    userIds: [...r.userIds],
                  })),
                }
              : {}),
            ...(message.attachments?.length
              ? {
                  attachments: message.attachments.map((a) => ({
                    id: a.id,
                    name: a.name,
                    type: a.type,
                    bytes: a.bytes,
                    sha256: a.sha256,
                  })),
                }
              : {}),
          };
        })
        .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
      return {
        id: group.id,
        name: group.name,
        createdAt: group.createdAt,
        inviteCode: "",
        members: group.members.map(person),
        lastMessage: messages.at(-1) ?? null,
        messages,
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const expectedFiles = new Map();
  for (const group of groups)
    for (const message of group.messages)
      for (const a of message.attachments ?? []) {
        const old = expectedFiles.get(a.id);
        if (old && JSON.stringify(old) !== JSON.stringify(a))
          throw new Error("Archive contains conflicting attachments.");
        expectedFiles.set(a.id, a);
      }
  if (
    value.files !== undefined &&
    (!Array.isArray(value.files) || value.files.length > 10000)
  )
    throw new Error("Archive contains invalid file data.");
  const seenFiles = new Set();
  const files = (value.files ?? [])
    .map((file) => {
      const expected = expectedFiles.get(file?.id);
      if (!expected || seenFiles.has(file.id))
        throw new Error("Archive contains unknown or duplicate files.");
      seenFiles.add(file.id);
      if (file.missing === true && file.data === undefined)
        return { id: file.id, missing: true };
      if (
        typeof file.data !== "string" ||
        file.data.length !== 4 * Math.ceil(expected.bytes / 3) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
      )
        throw new Error("Archive contains invalid file bytes.");
      return { id: file.id, data: file.data };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const id of expectedFiles.keys())
    if (!seenFiles.has(id)) files.push({ id, missing: true });
  files.sort((a, b) => a.id.localeCompare(b.id));
  const result = {
    format: "gather-archive-v1",
    features: [
      "text",
      ...(groups.some((g) => g.messages.some((m) => m.replyTo))
        ? ["replies-v1"]
        : []),
      ...(expectedFiles.size ? ["attachments-v1"] : []),
      ...(groups.some((g) => g.messages.some((m) => m.reactions?.length))
        ? ["reactions-v1"]
        : []),
    ],
    exportedAt: exportedAt.toISOString(),
    user: person(value.user),
    groups,
    ...(expectedFiles.size ? { files } : {}),
  };
  if (
    new TextEncoder().encode(JSON.stringify({ ...result, files: undefined }))
      .byteLength > MAX_ARCHIVE_BYTES
  )
    throw new Error("This archive exceeds the supported text archive size.");
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    MAX_ARCHIVE_FILE_BYTES
  )
    throw new Error("This archive exceeds the 100 MB portable archive limit.");
  return result;
}
export function archiveScope(ownerScope, id) {
  return JSON.stringify([ownerScope, "archive", id]);
}
