import { archiveScope } from "./archive-format.mjs";
export const LOCAL_MEDIA_LIMIT = 500_000_000;
export const LOCAL_MEDIA_ENTRIES = 10_000;
export const MIN_MEDIA_LIMIT = 20_000_000;
export const MAX_MEDIA_LIMIT = 2_000_000_000;
export const MEDIA_PENDING = 1;
export const MEDIA_KEPT = 2;
export function createMediaClock({
  wall = Date.now,
  mono = () => performance.now(),
  nonce = () => crypto.randomUUID(),
} = {}) {
  let referenceWall = wall(),
    referenceMono = mono(),
    proofTag = nonce();
  return {
    read() {
      const currentWall = wall(),
        now = mono();
      if (
        Math.abs(currentWall - referenceWall - (now - referenceMono)) > 2000
      ) {
        proofTag = nonce();
        referenceWall = currentWall;
        referenceMono = now;
      }
      return { now, wall: currentWall, proofTag };
    },
  };
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const validMessageKey = (value) =>
  typeof value === "string" &&
  value.split(":").length === 2 &&
  value.split(":").every((id) => uuid.test(id));
export const mediaKey = (scope, id) => JSON.stringify([scope, id]);
export const mediaMessageKey = (message) =>
  `${message.userId}:${message.clientId}`;
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
const ownsArchive = (owner, scope) => {
  try {
    const parts = JSON.parse(scope);
    return (
      Array.isArray(parts) &&
      parts.length === 3 &&
      parts[0] === owner &&
      parts[1] === "archive" &&
      /^[a-f0-9]{64}$/.test(parts[2])
    );
  } catch {
    return false;
  }
};
export function validateLocalMedia(c) {
  if (
    !c ||
    typeof c.scope !== "string" ||
    !c.scope ||
    c.scope.length > 512 ||
    ![
      "put",
      "get",
      "unpin",
      "status",
      "entry",
      "list",
      "keep",
      "configure",
      "remove",
      "clear",
      "observe",
      "clearArchive",
    ].includes(c.operation)
  )
    throw new Error("Invalid media cache operation.");
  if (
    c.operation === "configure" &&
    ((c.limitBytes !== undefined &&
      (!integer(c.limitBytes, MIN_MEDIA_LIMIT) ||
        c.limitBytes > MAX_MEDIA_LIMIT)) ||
      (c.autoDownload !== undefined && typeof c.autoDownload !== "boolean"))
  )
    throw new Error("Choose a device media limit between 20 MB and 2 GB.");
  if (
    c.operation === "list" &&
    ((c.offset !== undefined &&
      (!integer(c.offset) || c.offset > LOCAL_MEDIA_ENTRIES)) ||
      (c.limit !== undefined && (!integer(c.limit, 1) || c.limit > 100)) ||
      (c.query !== undefined &&
        (typeof c.query !== "string" || c.query.length > 200)) ||
      (c.onlyKept !== undefined && typeof c.onlyKept !== "boolean") ||
      (c.includeArchives !== undefined &&
        typeof c.includeArchives !== "boolean"))
  )
    throw new Error("Invalid file list.");
  if (
    ["clear", "remove"].includes(c.operation) &&
    ((c.allowUnconfirmed !== undefined &&
      typeof c.allowUnconfirmed !== "boolean") ||
      (c.allowKept !== undefined && typeof c.allowKept !== "boolean"))
  )
    throw new Error("Invalid file removal.");
  if (c.operation === "observe") {
    if (
      !validMessageKey(c.messageKey) ||
      typeof c.deleted !== "boolean" ||
      !Array.isArray(c.attachments) ||
      c.attachments.length > 4
    )
      throw new Error("Invalid attachment reconciliation.");
    if (
      c.attachmentIds !== undefined &&
      (!c.deleted ||
        !Array.isArray(c.attachmentIds) ||
        c.attachmentIds.length > 4 ||
        c.attachmentIds.some((id) => !uuid.test(id)))
    )
      throw new Error("Invalid deleted attachment references.");
    for (const file of c.attachments)
      if (
        !uuid.test(file?.id) ||
        typeof file.name !== "string" ||
        file.name.length > 180 ||
        !integer(file.bytes, 1) ||
        file.bytes > 10_000_000 ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        throw new Error("Invalid attachment reconciliation.");
    return c;
  }
  if (["status", "configure", "list", "clear"].includes(c.operation)) return c;
  if (c.operation === "clearArchive") {
    if (!/^[a-f0-9]{64}$/.test(c.id))
      throw new Error("Choose an imported archive.");
    return c;
  }
  if (typeof c.id !== "string" || !uuid.test(c.id))
    throw new Error("Invalid attachment ID.");
  if (c.operation === "keep" && typeof c.active !== "boolean")
    throw new Error("Choose whether to keep this file.");
  if (
    c.operation === "put" &&
    (!(c.data instanceof Uint8Array) ||
      c.data.byteLength < 1 ||
      c.data.byteLength > 10_000_000 ||
      !/^[a-f0-9]{64}$/.test(c.sha256) ||
      typeof c.pinned !== "boolean" ||
      (c.name !== undefined &&
        (typeof c.name !== "string" || c.name.length > 180)) ||
      (c.type !== undefined &&
        (typeof c.type !== "string" || c.type.length > 100)) ||
      (c.messageKey !== undefined && !validMessageKey(c.messageKey)) ||
      c.cloudUntil !== undefined ||
      (c.cloudForMs !== undefined &&
        (!integer(c.cloudForMs) || c.cloudForMs > 31_536_000_000)))
  )
    throw new Error("Invalid attachment bytes.");
  return c;
}
export function mediaSettings(value, autoDownload = false) {
  const limitBytes = value?.limitBytes ?? LOCAL_MEDIA_LIMIT;
  validateLocalMedia({
    scope: "settings",
    operation: "configure",
    limitBytes,
    autoDownload: value?.autoDownload ?? autoDownload,
  });
  return { limitBytes, autoDownload: value?.autoDownload ?? autoDownload };
}
export const mediaCanEvict = (row, clock) =>
  !row.flags && row.proofTag === clock.proofTag && row.cloudUntil > clock.now;
export function publicMedia(row, clock) {
  if (!row) return null;
  return {
    ...row,
    pending: Boolean(row.flags & MEDIA_PENDING),
    kept: Boolean(row.flags & MEDIA_KEPT),
    cloudConfirmed:
      row.proofTag === clock.proofTag && row.cloudUntil > clock.now,
  };
}
export function mediaStatus(rows, settings, scope, clock) {
  const selected = rows.filter((r) => r.scope === scope);
  const archives = rows.filter((r) => ownsArchive(scope, r.scope));
  const profile = [...selected, ...archives];
  const sum = (list) => list.reduce((n, r) => n + r.bytes, 0);
  return {
    ...settings,
    bytes: sum(rows),
    count: rows.length,
    maxEntries: LOCAL_MEDIA_ENTRIES,
    scopeBytes: sum(profile),
    scopeCount: profile.length,
    archiveBytes: sum(archives),
    keptBytes: sum(profile.filter((r) => r.flags & MEDIA_KEPT)),
    pendingBytes: sum(profile.filter((r) => r.flags & MEDIA_PENDING)),
    clearableBytes: sum(selected.filter((r) => !r.flags)),
    clearableCount: selected.filter((r) => !r.flags).length,
    unconfirmedCount: selected.filter(
      (r) => !r.flags && !mediaCanEvict(r, clock),
    ).length,
  };
}
// Both stores apply this plan in a single durable transaction. Bytes never enter
// the policy model, so listing/managing files does not read every original.
export function planMediaChange(
  rows,
  prefs,
  c,
  clock,
  entryLimit = LOCAL_MEDIA_ENTRIES,
) {
  const map = new Map(rows.map((r) => [mediaKey(r.scope, r.id), r])),
    upserts = new Map(),
    removed = new Set();
  let settings = prefs,
    response = { ok: true };
  const key = mediaKey(c.scope, c.id),
    old = map.get(key);
  const write = (r) => {
    const k = mediaKey(r.scope, r.id);
    map.set(k, r);
    upserts.set(k, r);
    removed.delete(k);
  };
  const remove = (r) => {
    const k = mediaKey(r.scope, r.id);
    map.delete(k);
    removed.add(k);
    upserts.delete(k);
  };
  const room = (extra, extraEntries) => {
    let bytes = [...map.values()].reduce((n, r) => n + r.bytes, 0);
    for (const row of [...map.values()]
      .filter((r) => mediaCanEvict(r, clock))
      .sort((a, b) => a.touched - b.touched)) {
      if (
        bytes + extra <= settings.limitBytes &&
        map.size + extraEntries <= entryLimit
      )
        break;
      remove(row);
      bytes -= row.bytes;
    }
    if (
      bytes + extra > settings.limitBytes ||
      map.size + extraEntries > entryLimit
    )
      throw new Error(
        "Device file storage is full. Increase its limit or remove downloaded files in Settings. Kept files and pending messages stay protected.",
      );
  };
  if (c.operation === "status")
    response = mediaStatus(rows, prefs, c.scope, clock);
  else if (c.operation === "entry") response = publicMedia(old, clock);
  else if (c.operation === "list") {
    const selected = rows
      .filter(
        (r) =>
          (r.scope === c.scope ||
            (c.includeArchives && ownsArchive(c.scope, r.scope))) &&
          (!c.onlyKept || r.flags & MEDIA_KEPT) &&
          (!c.query || r.name.toLowerCase().includes(c.query.toLowerCase())),
      )
      .sort((a, b) => b.touched - a.touched || a.id.localeCompare(b.id));
    const offset = c.offset ?? 0,
      limit = c.limit ?? 50;
    response = {
      files: selected
        .slice(offset, offset + limit)
        .map((r) => publicMedia(r, clock)),
      hasMore: selected.length > offset + limit,
      total: selected.length,
    };
  } else if (c.operation === "configure") {
    settings = mediaSettings({
      ...prefs,
      ...Object.fromEntries(
        ["limitBytes", "autoDownload"]
          .filter((key) => c[key] !== undefined)
          .map((key) => [key, c[key]]),
      ),
    });
    room(0, 0);
    response = mediaStatus([...map.values()], settings, c.scope, clock);
  } else if (c.operation === "unpin" && old)
    write({ ...old, flags: old.flags & ~MEDIA_PENDING });
  else if (c.operation === "keep") {
    if (!old)
      throw new Error(
        "This file could not be saved on this device. Try again online or save the original to a folder.",
      );
    write({
      ...old,
      flags: c.active ? old.flags | MEDIA_KEPT : old.flags & ~MEDIA_KEPT,
    });
  } else if (c.operation === "put") {
    if (old && (old.sha256 !== c.sha256 || old.bytes !== c.data.byteLength))
      throw new Error("Attachment ID was already used.");
    if (old?.messageKey && c.messageKey && old.messageKey !== c.messageKey)
      throw new Error("This file belongs to another message.");
    if (!old) room(c.data.byteLength, 1);
    write({
      ...old,
      scope: c.scope,
      id: c.id,
      sha256: c.sha256,
      bytes: c.data.byteLength,
      flags: (old?.flags ?? 0) | (c.pinned ? MEDIA_PENDING : 0),
      touched: clock.wall,
      name: c.name ?? old?.name ?? "File",
      type: c.type ?? old?.type ?? "application/octet-stream",
      messageKey: c.messageKey ?? old?.messageKey ?? "",
      cloudUntil:
        c.cloudForMs !== undefined
          ? clock.now + Math.max(0, c.cloudForMs - 5000)
          : (old?.cloudUntil ?? 0),
      proofTag:
        c.cloudForMs !== undefined ? clock.proofTag : (old?.proofTag ?? ""),
    });
  } else if (c.operation === "remove" && old) {
    if (old.flags & MEDIA_PENDING)
      throw new Error(
        "This file belongs to a pending message and cannot be removed yet.",
      );
    if (old.flags & MEDIA_KEPT && !c.allowKept)
      throw new Error(
        "This file is kept on this device. Confirm its removal first.",
      );
    if (!mediaCanEvict({ ...old, flags: 0 }, clock) && !c.allowUnconfirmed)
      throw new Error(
        "This may be the last available copy. Confirm removal from this device first.",
      );
    remove(old);
  } else if (c.operation === "clear") {
    const selected = rows.filter((r) => r.scope === c.scope && !r.flags);
    if (selected.some((r) => !mediaCanEvict(r, clock)) && !c.allowUnconfirmed)
      throw new Error(
        "Some files have no confirmed cloud copy. Confirm removal before clearing them.",
      );
    selected.forEach(remove);
    response = {
      ok: true,
      removedCount: selected.length,
      removedBytes: selected.reduce((n, r) => n + r.bytes, 0),
    };
  } else if (c.operation === "clearArchive") {
    rows.filter((r) => r.scope === archiveScope(c.scope, c.id)).forEach(remove);
  } else if (c.operation === "observe") {
    const files = new Map([
      ...c.attachments.map((a) => [a.id, a]),
      ...(c.attachmentIds ?? []).map((id) => [id, undefined]),
    ]);
    for (const row of rows.filter(
      (r) =>
        r.scope === c.scope &&
        (r.messageKey === c.messageKey || files.has(r.id)),
    )) {
      if (c.deleted) remove(row);
      else {
        const file = files.get(row.id);
        if (file && (row.sha256 !== file.sha256 || row.bytes !== file.bytes))
          throw new Error("Attachment identity changed.");
        write({
          ...row,
          name: file?.name ?? row.name,
          messageKey: c.messageKey,
          flags: row.flags & ~MEDIA_PENDING,
        });
      }
    }
  }
  return {
    settings,
    response,
    upserts: [...upserts.values()],
    removed: [...removed],
  };
}
