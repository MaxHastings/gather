import type { Message, Group } from "../src/types";
import type { Archive } from "./archive-format.mjs";
type Scoped = { scope: string };
export type HistoryCommand = Scoped &
  (
    | { operation: "state" }
    | { operation: "archives" }
    | { operation: "mediaCleanup" }
    | { operation: "mediaCleanupDone"; messageKeys: string[] }
    | { operation: "importArchive"; name: string; archive: Archive }
    | { operation: "deleteArchive"; id: string }
    | { operation: "bootstrap"; groups: Group[] }
    | {
        operation: "page";
        groupId: string;
        before?: number;
        after?: number;
        limit?: number;
      }
    | {
        operation: "apply";
        groupId: string;
        messages: Message[];
        cursor?: number;
        changeCursor?: number;
      }
    | { operation: "queue"; message: Message; replaceClientId?: string }
    | { operation: "archiveMirror"; id: string; name: string; person: string }
    | { operation: "resetSync" }
    | {
        operation: "outboxControl";
        clientId: string;
        paused?: boolean;
        discard?: boolean;
        cancelled?: boolean;
      }
    | { operation: "lookup"; groupId: string; id: string }
    | { operation: "unread"; userId: string; after: Record<string, number> }
    | { operation: "fail"; clientId: string }
    | { operation: "search"; query: string; groupId?: string }
  );
export function validateHistoryCommand(value: unknown): HistoryCommand;
export function validateHistoryMessage(
  message: unknown,
  groupId: string,
  pending?: boolean,
): void;
export function normalizeSearch(value: string): string;
export function historyKey(scope: string, id: string): string;
export type MediaCleanupTask = { messageKey: string; attachmentIds: string[] };
export function mediaCleanupTask(
  message: Message,
  previous?: Message,
  queued?: Message,
  existingTask?: MediaCleanupTask,
): MediaCleanupTask;
export function assertHistoryIdentity(
  existing: Message | undefined,
  incoming: Message,
): void;
export function assertQueuedIdentity(
  existing: Message | undefined,
  incoming: Message,
): void;

export function mirrorGroups(groups: Group[], messages: Message[]): Group[];
