import type { Group, Message, Person } from "../src/types";
export type Archive = {
  format: "gather-archive-v1";
  features: string[];
  exportedAt: string;
  user: Person;
  groups: (Group & { messages: Message[] })[];
  files?: { id: string; data?: string; missing?: boolean }[];
};
export const MAX_ARCHIVE_BYTES: number;
export const MAX_ARCHIVE_FILE_BYTES: number;
export function parseArchive(value: unknown): Archive;
export function archiveScope(ownerScope: string, id: string): string;
