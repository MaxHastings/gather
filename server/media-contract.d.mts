export const LOCAL_MEDIA_LIMIT: number;
export const LOCAL_MEDIA_ENTRIES: number;
export const MIN_MEDIA_LIMIT: number;
export const MAX_MEDIA_LIMIT: number;
export const MEDIA_PENDING: number;
export const MEDIA_KEPT: number;
export type MediaPreferences = { limitBytes: number; autoDownload: boolean };
export type MediaRow = {
  scope: string;
  id: string;
  sha256: string;
  bytes: number;
  flags: number;
  touched: number;
  name: string;
  type: string;
  messageKey: string;
  cloudUntil: number;
  proofTag: string;
};
export type MediaEntry = MediaRow & {
  pending: boolean;
  kept: boolean;
  cloudConfirmed: boolean;
};
export type MediaStatus = MediaPreferences & {
  bytes: number;
  count: number;
  maxEntries: number;
  scopeBytes: number;
  scopeCount: number;
  archiveBytes: number;
  keptBytes: number;
  pendingBytes: number;
  clearableBytes: number;
  clearableCount: number;
  unconfirmedCount: number;
  freeBytes?: number;
  allocatedBytes?: number;
};
export type MediaCommand = {
  operation:
    | "put"
    | "get"
    | "unpin"
    | "status"
    | "entry"
    | "list"
    | "keep"
    | "configure"
    | "remove"
    | "clear"
    | "observe"
    | "clearArchive";
  scope: string;
  id?: string;
  data?: Uint8Array;
  sha256?: string;
  pinned?: boolean;
  name?: string;
  type?: string;
  messageKey?: string;
  cloudForMs?: number;
  limitBytes?: number;
  autoDownload?: boolean;
  active?: boolean;
  onlyKept?: boolean;
  includeArchives?: boolean;
  query?: string;
  offset?: number;
  limit?: number;
  allowKept?: boolean;
  allowUnconfirmed?: boolean;
  deleted?: boolean;
  attachments?: { id: string; name: string; bytes: number; sha256: string }[];
  attachmentIds?: string[];
};
export function validateLocalMedia(command: unknown): MediaCommand;
export function mediaKey(scope: string, id?: string): string;
export function mediaMessageKey(message: {
  userId: string;
  clientId: string;
}): string;
export function mediaSettings(
  value?: Partial<MediaPreferences>,
  autoDownload?: boolean,
): MediaPreferences;
export function mediaCanEvict(row: MediaRow, clock: MediaClockReading): boolean;
export function publicMedia(
  row: MediaRow | undefined,
  clock: MediaClockReading,
): MediaEntry | null;
export function mediaStatus(
  rows: MediaRow[],
  settings: MediaPreferences,
  scope: string,
  clock: MediaClockReading,
): MediaStatus;
export function planMediaChange(
  rows: MediaRow[],
  prefs: MediaPreferences,
  command: MediaCommand,
  clock: MediaClockReading,
  entryLimit?: number,
): {
  settings: MediaPreferences;
  response: unknown;
  upserts: MediaRow[];
  removed: string[];
};

export type MediaClockReading = { now: number; wall: number; proofTag: string };
export function createMediaClock(options?: {
  wall?: () => number;
  mono?: () => number;
  nonce?: () => string;
}): { read: () => MediaClockReading };
