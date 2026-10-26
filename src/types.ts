export type AvatarInfo = { avatarId?: string; avatarRevision?: number };
export type Person = {
  id: string;
  name: string;
  status?: string;
} & AvatarInfo;
export type Attachment = {
  id: string;
  name: string;
  type: string;
  bytes: number;
  sha256: string;
};
export type Message = {
  replyTo?: string;
  reply?: {
    id: string;
    name: string;
    body: string;
    deleted: boolean;
    revision?: number;
  };
  paused?: boolean;
  cancelled?: boolean;

  revision?: number;
  contentRevision?: number;
  editedAt?: number;
  deletedAt?: number;
  deletedAttachmentIds?: string[];
  reactions?: { emoji: string; userIds: string[] }[];
  id: string;
  sequence: number;
  clientId: string;
  groupId: string;
  userId: string;
  name: string;
  body: string;
  attachments?: Attachment[];
  createdAt: number;
  status?: "queued" | "sending" | "failed";
};
export type Group = AvatarInfo & {
  ownerId?: string | null;
  controlRevision?: number;
  access?: "active" | "left" | "removed";
  id: string;
  name: string;
  inviteCode: string;
  createdAt: number;
  members: Person[];
  reads?: Record<string, number>;
  lastMessage: Message | null;
};
export type Bootstrap = {
  generation?: string;
  departures?: {
    groupId: string;
    access: "left" | "removed";
    controlRevision: number;
  }[];
  capabilities?: string[];
  user: Person;
  groups: Group[];
  onlineIds: string[];
  awayIds?: string[];
  voice: Record<string, string[]>;
  voiceAvailable: boolean;
  voiceLimit?: number;
};
export type Session = { server: string; token: string; user: Person };
export type UpdateState = {
  phase:
    | "idle"
    | "waiting"
    | "checking"
    | "current"
    | "downloading"
    | "ready"
    | "installing"
    | "error"
    | "unsupported";
  version: string;
  percent: number;
  error: string;
};
export type CallPerson = Person & {
  muted: boolean;
  speaking: boolean;
  local: boolean;
  connection: "local" | "connecting" | "connected" | "reconnecting";
};

declare global {
  interface Window {
    desktop?: {
      platform: string;
      defaultServer: string;
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      openExternal: (url: string) => Promise<void>;
      copyText: (text: string) => Promise<void>;
      copyInvite: (value: string) => Promise<void>;
      onToggleMute: (callback: () => void) => () => void;
      setInCall: (active: boolean) => Promise<boolean>;
      getDesktopPrefs?: () => Promise<{
        closeToTray: boolean;
        startOnLogin: boolean;
        supportsTray: boolean;
        supportsStartOnLogin: boolean;
      }>;
      setDesktopPrefs?: (patch: {
        closeToTray?: boolean;
        startOnLogin?: boolean;
      }) => Promise<{
        closeToTray: boolean;
        startOnLogin: boolean;
        supportsTray: boolean;
        supportsStartOnLogin: boolean;
      }>;
      setUnreadCount?: (count: number) => Promise<void>;
      history: (command: unknown) => Promise<unknown>;
      media: (command: unknown) => Promise<unknown>;
      notificationsSupported: () => Promise<boolean>;
      updateStatus: () => Promise<UpdateState>;
      checkForUpdates: () => Promise<unknown>;
      restartToUpdate: () => Promise<{ ok: boolean; reason?: string }>;
      setUpdateBusy: (busy: boolean) => Promise<void>;
      onUpdateState: (callback: (state: UpdateState) => void) => () => void;
      showNotification: (value: {
        scope: string;
        groupId: string;
        messageId: string;
        title: string;
        body: string;
      }) => Promise<boolean>;
      clearNotifications: (scope: string) => Promise<void>;
      onNotificationOpen: (
        callback: (value: { scope: string; groupId: string }) => void,
      ) => () => void;
      copyRecoveryCode: (code: string) => Promise<void>;
      readSession: () => Promise<{
        initialized: boolean;
        session: Session | null;
      }>;
      writeSession: (
        value: Session | null,
        expectedToken: string | null,
      ) => Promise<Session | null>;
    };
  }
}
