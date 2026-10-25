const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text = (value, max) => typeof value === "string" && value.length <= max;
const id = (value) => typeof value === "string" && uuid.test(value);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
export function validateHistoryMessage(message, groupId, pending = false) {
  if (message?.replyTo !== undefined && !id(message.replyTo))
    throw new Error("Invalid reply reference.");
  if (
    message?.reply !== undefined &&
    (!message.replyTo ||
      message.reply.id !== message.replyTo ||
      !text(message.reply.body, 4000) ||
      !text(message.reply.name, 128) ||
      typeof message.reply.deleted !== "boolean")
  )
    throw new Error("Invalid reply preview.");
  if (
    message?.deletedAttachmentIds !== undefined &&
    (!message.deletedAt ||
      !Array.isArray(message.deletedAttachmentIds) ||
      message.deletedAttachmentIds.length > 4 ||
      new Set(message.deletedAttachmentIds).size !==
        message.deletedAttachmentIds.length ||
      message.deletedAttachmentIds.some((value) => !id(value)))
  )
    throw new Error("Invalid deleted attachment references.");
  for (const key of ["contentRevision", "editedAt", "deletedAt"])
    if (
      message?.[key] !== undefined &&
      (!integer(message[key]) || message[key] > 8_640_000_000_000_000)
    )
      throw new Error("Invalid message change metadata.");
  if (
    message?.deletedAt !== undefined &&
    (pending ||
      message.body !== "" ||
      message.attachments?.length ||
      message.reactions?.length)
  )
    throw new Error("Deleted message still contains content.");
  if (message?.revision !== undefined && !integer(message.revision))
    throw new Error("Invalid message revision.");
  if (
    message?.reactions !== undefined &&
    (!Array.isArray(message.reactions) ||
      message.reactions.length > 8 ||
      message.reactions.reduce((n, r) => n + (r?.userIds?.length ?? 1000), 0) >
        100 ||
      message.reactions.some(
        (r) =>
          !r ||
          !text(r.emoji, 64) ||
          !r.emoji ||
          !Array.isArray(r.userIds) ||
          !r.userIds.length ||
          new Set(r.userIds).size !== r.userIds.length ||
          r.userIds.some((value) => !id(value)),
      ))
  )
    throw new Error("Invalid message reactions.");
  if (
    !message ||
    !id(message.id) ||
    !id(message.clientId) ||
    !id(message.groupId) ||
    !id(message.userId) ||
    message.groupId !== groupId ||
    !text(message.name, 128) ||
    !message.name.trim() ||
    !text(message.body, 4000) ||
    !integer(message.createdAt) ||
    message.createdAt > 8_640_000_000_000_000 ||
    !integer(message.sequence, pending ? 0 : 1) ||
    message.sequence === Number.MAX_SAFE_INTEGER ||
    (pending
      ? message.sequence !== 0 ||
        !["queued", "sending", "failed"].includes(message.status)
      : Boolean(message.status))
  )
    throw new Error("Invalid history message.");
  if (JSON.stringify(message).length > 32768)
    throw new Error("History message is too large.");
  if (
    message.attachments !== undefined &&
    (!Array.isArray(message.attachments) ||
      message.attachments.length > 4 ||
      new Set(message.attachments.map((a) => a?.id)).size !==
        message.attachments.length ||
      message.attachments.some(
        (a) =>
          !a ||
          !id(a.id) ||
          !text(a.name, 180) ||
          !a.name ||
          /[\x00-\x1f\x7f/\\]/.test(a.name) ||
          ![
            "application/octet-stream",
            "audio/mpeg",
            "audio/wav",
            "audio/ogg",
            "audio/mp4",
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            "video/mp4",
          ].includes(a.type) ||
          !integer(a.bytes, 1) ||
          a.bytes > 10_000_000 ||
          typeof a.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(a.sha256),
      ))
  )
    throw new Error("Invalid history attachment.");
}
