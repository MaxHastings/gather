import { api } from "./api";
import { history, historyScope, type HistoryState } from "./history";
import {
  parseArchive,
  archiveScope,
  MAX_ARCHIVE_FILE_BYTES,
  type Archive,
} from "../server/archive-format.mjs";
import { loadMedia, cacheMedia, digest } from "./media";
import { assertHistoryIdentity } from "../server/history-contract.mjs";
import type { Group, Message, Session } from "./types";

export type LocalArchive = {
  id: string;
  name: string;
  scope: string;
  importedAt: number;
  exportedAt: string;
  person: string;
  groups: number;
  messages: number;
  alreadyImported?: boolean;
  mediaSourceScope?: string;
};
export type HistoryPage = { messages: Message[]; hasMore: boolean };

export async function exportArchive(session: Session) {
  const scope = historyScope(session);
  const local = await history<HistoryState>({ operation: "state", scope });
  const groups = new Map<string, Group & { messages: Message[] }>();
  let count = 0;
  for (const group of local.groups) {
    const messages: Message[] = [];
    let before: number | undefined;
    while (true) {
      const page = await history<HistoryPage>({
        operation: "page",
        scope,
        groupId: group.id,
        before,
        limit: 200,
      });
      messages.push(...page.messages);
      count += page.messages.length;
      if (count > 100000)
        throw new Error(
          "This history needs a larger archive export. Nothing was exported.",
        );
      if (!page.hasMore || !page.messages.length) break;
      before = page.messages[0].sequence;
    }
    groups.set(group.id, { ...group, messages });
  }
  let remote: Archive | undefined;
  let raw: unknown;
  try {
    raw = await api(session, "/api/export");
  } catch (error) {
    const failure = error as { kind?: string; status?: number };
    if (
      failure.kind !== "network" &&
      !(failure.status && failure.status >= 500)
    )
      throw error;
  }
  // Unsupported or malformed server archives must not silently lose records.
  if (raw !== undefined) remote = parseArchive(raw);
  for (const group of remote?.groups ?? []) {
    const records = new Map(
      (groups.get(group.id)?.messages ?? []).map((message) => [
        message.id,
        message,
      ]),
    );
    for (const message of group.messages) {
      assertHistoryIdentity(records.get(message.id), message);
      const previous = records.get(message.id);
      if (
        (!previous?.deletedAt || message.deletedAt) &&
        (previous?.revision ?? 0) <= (message.revision ?? 0)
      )
        records.set(message.id, message);
    }
    groups.set(group.id, { ...group, messages: [...records.values()] });
  }
  const archive = parseArchive({
    format: "gather-archive-v1",
    features: [
      "text",
      "attachments-v1",
      "reactions-v1",
      "message-mutations-v1",
      "replies-v1",
    ],
    exportedAt: new Date().toISOString(),
    user: session.user,
    groups: [...groups.values()],
  });
  let bundleBytes = new TextEncoder().encode(JSON.stringify(archive)).length;
  for (const file of archive.files ?? []) {
    const attachment = archive.groups
      .flatMap((g) => g.messages)
      .flatMap((m) => m.attachments ?? [])
      .find((a) => a.id === file.id)!;
    if (
      bundleBytes + 4 * Math.ceil(attachment.bytes / 3) >
      MAX_ARCHIVE_FILE_BYTES
    )
      throw new Error(
        "This history exceeds the 100 MB portable archive limit. No incomplete archive was exported.",
      );
    let blob: Blob;
    try {
      blob = await loadMedia(session, attachment);
    } catch {
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    file.data = btoa(binary);
    delete file.missing;
    bundleBytes += file.data.length;
  }
  return {
    archive: parseArchive(archive),
    serverIncluded: Boolean(remote),
    missingFiles: archive.files?.filter((file) => file.missing).length ?? 0,
  };
}

export async function importArchive(
  session: Session,
  name: string,
  input: unknown,
) {
  const archive = parseArchive(input),
    scope = historyScope(session);
  const id = await digest(new TextEncoder().encode(JSON.stringify(archive)));
  const target = archiveScope(scope, id);
  const attachments = new Map(
    archive.groups
      .flatMap((g) => g.messages)
      .flatMap((m) => m.attachments ?? [])
      .map((a) => [a.id, a]),
  );
  // Verify all originals before committing history. Partial cache writes are
  // disposable; they cannot grant membership or modify the live sending queue.
  for (const file of archive.files ?? [])
    if (file.data) {
      const attachment = attachments.get(file.id)!;
      const binary = atob(file.data),
        data = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      if (
        data.length !== attachment.bytes ||
        (await digest(data)) !== attachment.sha256
      )
        throw new Error(
          "An archive file failed its checksum. Nothing was imported.",
        );
    }
  for (const file of archive.files ?? [])
    if (file.data) {
      const attachment = attachments.get(file.id)!;
      const data = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
      await cacheMedia({
        operation: "put",
        scope: target,
        ...attachment,
        data,
        pinned: false,
      });
    }
  return history<LocalArchive>({
    operation: "importArchive",
    scope,
    name,
    archive,
  });
}

export function downloadArchive(archive: Archive) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(archive)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "gather-history.json";
  document.body.append(link);
  link.click();
  link.remove();
  // Electron's download starts asynchronously; keep the backing bytes alive.
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}
