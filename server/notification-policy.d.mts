import type { Message, Group } from "../src/types";
export function notificationCandidate(input: {
  message: Message;
  changeKind?: string;
  userId: string;
  group?: Group;
  selected: string;
  focused: boolean;
  preferences: {
    enabled: boolean;
    preview: boolean;
    muted: string[];
    mutedUntil?: Record<string, number>;
    dndUntil?: number;
  };
  now: number;
  mentioned?: boolean;
}): { groupId: string; messageId: string; title: string; body: string } | null;
