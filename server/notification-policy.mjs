// Live creation events are distinct from history replay and materialized edits.
// This function has no OS, storage or transport side effects.
export function notificationCandidate({
  message,
  changeKind,
  userId,
  group,
  selected,
  focused,
  preferences,
  now,
  mentioned = false,
}) {
  const muted =
    group &&
    (preferences.muted.includes(group.id) ||
      (preferences.mutedUntil?.[group.id] ?? 0) > now);
  // Do Not Disturb silences everything; a mention gets through a muted chat.
  if ((preferences.dndUntil ?? 0) > now || (muted && !mentioned)) return null;
  if (
    changeKind !== "create" ||
    !group ||
    message.groupId !== group.id ||
    message.userId === userId ||
    message.status ||
    !preferences.enabled ||
    (focused && selected === group.id) ||
    !Number.isFinite(message.createdAt) ||
    now - message.createdAt > 120_000 ||
    message.createdAt - now > 30_000
  )
    return null;
  const clean = (value, length) =>
    String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, length);
  return {
    groupId: group.id,
    messageId: message.id,
    title: preferences.preview
      ? clean(
          mentioned
            ? `${message.name} mentioned you · ${group.name}`
            : `${message.name} · ${group.name}`,
          100,
        )
      : "Gather",
    body: preferences.preview
      ? clean(
          message.body ||
            (message.attachments?.length === 1
              ? message.attachments[0].name
              : `${message.attachments?.length || 0} files`),
          300,
        )
      : "New message",
  };
}
