import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  ArrowLeft,
  Bell,
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  Download,
  Headphones,
  HeadphoneOff,
  Heart,
  Link,
  LoaderCircle,
  MessageCircle,
  Mic,
  MicOff,
  Minus,
  Monitor,
  Phone,
  PhoneOff,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings,
  HardDrive,
  ShieldCheck,
  Smile,
  Square,
  Users,
  Volume2,
  WifiOff,
  X,
} from "lucide-react";
import {
  api,
  DEFAULT_SERVER,
  normalizeServer,
  parseInvite,
  loadSession,
  request,
  saveSession,
} from "./api";
import { MessageRow, type RowActions } from "./MessageRow";
import { useChat } from "./useChat";
import { useVoice } from "./useVoice";
import { CallStage, CallControls, callStatusLabel } from "./CallStage";
import { IncomingCalls } from "./IncomingCalls";
import type { IncomingRing } from "./useRings";
import { useTheme, type Theme } from "./useTheme";
import { IdentitySettings } from "./IdentitySettings";
import { HistoryTools } from "./HistoryTools";
import { AttachmentView } from "./Attachments";
import { EmojiText, emojiOnlyCount } from "./Emoji";
import { MessageReactions } from "./MessageReactions";
import { MessageActions } from "./MessageActions";
import { GroupDetails } from "./GroupDetails";
import { Landing } from "./Landing";
import { AvatarProvider, AvatarImage, AvatarEditor, Avatar } from "./Avatars";
import { DesktopDownloads } from "./DesktopDownloads";
import { StorageSettings } from "./StorageSettings";
import { EmoticonPicker } from "./EmoticonPicker";
import type { GifSearch } from "./GifPanel";
import { gifUrl } from "../server/gif-policy.mjs";
import {
  readNotificationPreferences,
  saveNotificationPreferences,
} from "./notifications";
import { SoundSettings } from "./SoundSettings";
import { NotificationSettings } from "./NotificationSettings";
import { UpdateBanner, UpdateSettings } from "./Updates";
import { useDismissable } from "./useDismissable";
import { historyScope, history as localHistory } from "./history";
import { downloadArchive, exportArchive } from "./archive";
import type { Group, Person, Session, Message } from "./types";
import { version } from "../package.json";

const cx = (...values: (string | false | undefined)[]) =>
  values.filter(Boolean).join(" ");
function GroupIcon({
  index = 0,
  small = false,
  avatarId,
}: {
  index?: number;
  small?: boolean;
  avatarId?: string;
}) {
  return (
    <span
      className={cx("group-icon", `group-color-${index % 4}`, small && "small")}
    >
      {index % 3 === 0 ? (
        <Users />
      ) : index % 3 === 1 ? (
        <Heart />
      ) : (
        <MessageCircle />
      )}
      <AvatarImage id={avatarId} />
    </span>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <MessageCircle size={23} fill="currentColor" strokeWidth={0} />
        <i />
        <i />
      </span>
      <span>
        gather<span className="brand-period">.</span>
      </span>
    </div>
  );
}
function Titlebar() {
  return (
    <header
      className={cx(
        "titlebar",
        window.desktop?.platform === "darwin" && "titlebar-mac",
      )}
    >
      <div className="titlebar-name">
        <span className="tiny-mark" /> Gather
      </div>
      {window.desktop && window.desktop.platform !== "darwin" ? (
        <div className="window-buttons">
          <button
            aria-label="Minimize"
            onClick={() => window.desktop?.minimize()}
          >
            <Minus size={14} />
          </button>
          <button
            aria-label="Maximize"
            onClick={() => window.desktop?.maximize()}
          >
            <Square size={11} />
          </button>
          <button
            className="window-close"
            aria-label="Close Gather"
            onClick={() => window.desktop?.close()}
          >
            <X size={16} />
          </button>
        </div>
      ) : !window.desktop ? (
        <span className="web-label">
          <Monitor size={12} /> Web
        </span>
      ) : null}
    </header>
  );
}
function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
  onBack,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  onBack?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const elements = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          "button,input,select,textarea,a[href]",
        ) || [],
      ).filter((el) => !el.hasAttribute("disabled"));
    elements()[1]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") (onBack ?? onClose)();
      if (e.key === "Tab") {
        const list = elements();
        if (e.shiftKey && document.activeElement === list[0]) {
          e.preventDefault();
          list.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === list.at(-1)) {
          e.preventDefault();
          list[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose, onBack]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={cx("modal", wide && "modal-wide")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <button
          className="icon-button modal-close"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        {onBack && (
          <button className="text-button settings-back" onClick={onBack}>
            <ArrowLeft size={16} /> Back to settings
          </button>
        )}
        <h2>{title}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}
function Onboarding({
  onSession,
}: {
  onSession: (session: Session) => Promise<void>;
}) {
  const initialInvite = /^\/join\//.test(location.pathname)
    ? location.href
    : "";
  const [name, setName] = useState("");
  const [server, setServer] = useState(
    window.desktop?.defaultServer ||
      import.meta.env.VITE_GATHER_SERVER ||
      (location.protocol.startsWith("http") && location.port !== "5173"
        ? location.origin
        : DEFAULT_SERVER),
  );
  const [invite, setInvite] = useState(initialInvite);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingProfile, setPendingProfile] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(false);
  const [invitePreview, setInvitePreview] = useState<{
    name: string;
    memberCount: number;
  } | null>(null);
  useEffect(() => {
    if (!initialInvite) return;
    const parsed = parseInvite(initialInvite);
    const controller = new AbortController();
    request<{ name: string; memberCount: number }>(
      normalizeServer(parsed.server || server),
      `/api/invites/${encodeURIComponent(parsed.code)}`,
      { signal: controller.signal },
    )
      .then(setInvitePreview)
      .catch((e) => {
        if (controller.signal.aborted) return;
        // Only a definite "not found" is worth showing before the person types a name.
        if (e instanceof Error && /invite was not found/.test(e.message))
          setError(e.message);
      });
    return () => controller.abort();
  }, []);
  const [started, setStarted] = useState(
    Boolean(window.desktop) ||
      Boolean(initialInvite) ||
      new URLSearchParams(location.search).has("start"),
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const parsed = invite.trim() ? parseInvite(invite) : undefined;
      const address = normalizeServer(parsed?.server || server);
      const data = await request<{ token: string; user: Person }>(
        address,
        recovering ? "/api/recover" : "/api/sessions",
        {
          method: "POST",
          body: JSON.stringify({
            deviceName: window.desktop
              ? `${({ win32: "Windows", darwin: "Mac", linux: "Linux" } as Record<string, string>)[window.desktop.platform] || "Gather"} desktop`
              : "Web browser",
            ...(recovering
              ? { code: recoveryCode.trim(), signOutOthers }
              : { name, ...(parsed ? { inviteCode: parsed.code } : {}) }),
          }),
        },
      );
      if (recovering && parsed) {
        try {
          await request(
            address,
            "/api/groups/join",
            { method: "POST", body: JSON.stringify({ code: parsed.code }) },
            data.token,
          );
        } catch {
          // Recovery has already succeeded. Keep the recovered identity even
          // if a separate invite is no longer valid or its request fails.
          sessionStorage.setItem(
            "gather.recovery-invite-error",
            "Your profile was restored, but the invite could not be joined. You can retry it from Join a chat.",
          );
        }
      }
      const created = { server: address, ...data };
      setPendingProfile(created);
      await onSession(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t connect. Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (pendingProfile)
    return (
      <div className="onboarding simple-onboarding">
        <div className="connect-form">
          <Brand />
          <h1>Save your profile</h1>
          <p className="field-hint">
            Keep Gather open while saving is retried.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary full"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void onSession(pendingProfile)
                .catch((failure) => setError(failure.message))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Saving…" : "Try again"}
          </button>
        </div>
      </div>
    );
  if (!started)
    return (
      <div className="onboarding landing-shell">
        <Landing
          onStart={() => setStarted(true)}
          onRestore={() => {
            setRecovering(true);
            setStarted(true);
          }}
        />
      </div>
    );
  return (
    <div className="onboarding simple-onboarding">
      <form className="connect-form" onSubmit={submit}>
        <Brand />
        <h1>
          {recovering
            ? "Restore your profile"
            : initialInvite
              ? invitePreview
                ? `Join ${invitePreview.name}`
                : "Join chat"
              : "Welcome to Gather"}
        </h1>
        {!recovering && initialInvite && invitePreview && (
          <p className="muted invite-preview">
            You’ve been invited · {invitePreview.memberCount}{" "}
            {invitePreview.memberCount === 1 ? "person" : "people"} so far.
            Pick a name your friends will recognize.
          </p>
        )}
        {recovering ? (
          <>
            <label htmlFor="restore-code">Recovery code</label>
            <input
              id="restore-code"
              type="password"
              autoComplete="off"
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
              required
              autoFocus
            />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={signOutOthers}
                onChange={(event) => setSignOutOthers(event.target.checked)}
              />
              Sign out other devices
            </label>
          </>
        ) : (
          <>
            <label htmlFor="your-name">Your name</label>
            <input
              id="your-name"
              placeholder="Name"
              autoComplete="given-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              required
              autoFocus
            />
          </>
        )}
        {!initialInvite && (
          <>
            <label htmlFor="welcome-invite">
              Invite link <span className="optional">Optional</span>
            </label>
            <input
              id="welcome-invite"
              placeholder="Paste an invite to join a chat"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
            <button
              type="button"
              className="text-button advanced-toggle"
              onClick={() => setAdvanced(!advanced)}
            >
              <ChevronDown size={14} className={advanced ? "rotated" : ""} />{" "}
              Server
            </button>
            {advanced && (
              <div className="advanced-field">
                <label htmlFor="welcome-server">Server address</label>
                <input
                  id="welcome-server"
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  required
                />
              </div>
            )}
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary welcome-submit"
          disabled={busy || !(recovering ? recoveryCode.trim() : name.trim())}
        >
          {busy ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <>
              {recovering
                ? "Restore profile"
                : invite
                  ? "Join chat"
                  : "Continue"}
              <ArrowRight size={18} />
            </>
          )}
        </button>
        <button
          type="button"
          className="text-button recovery-toggle"
          disabled={busy}
          onClick={() => {
            setRecovering(!recovering);
            setError("");
          }}
        >
          {recovering ? "Create a new profile" : "Restore a profile"}
        </button>
        {!window.desktop && (
          <div className="desktop-download">
            <DesktopDownloads
              onDownload={() => {
                if (initialInvite)
                  void navigator.clipboard
                    .writeText(initialInvite)
                    .then(() => setInviteCopied(true))
                    .catch(() => {});
              }}
            />
            {inviteCopied && (
              <p className="field-hint">
                Invite copied. Paste it into Gather after opening the app.
              </p>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
function Workspace({
  session,
  onSession,
  theme,
  onTheme,
  onUpdateBusy,
}: {
  session: Session;
  onSession: (session: Session | null) => Promise<void>;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onUpdateBusy: (busy: boolean) => void;
}) {
  const chat = useChat(session);
  const self =
    chat.groups
      .flatMap((group) => group.members)
      .find((person) => person.id === session.user.id) ?? session.user;
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const notify = useCallback((text: string) => setNotice(text), []);
  const call = useVoice(session, chat.socket, notify);
  const [reply, setReply] = useState<Record<string, Message | undefined>>({});
  const jumpHandler = useRef<(groupId: string, id: string) => void>(() => {});
  const chatActions = useRef(chat);
  chatActions.current = chat;
  const rowActions = useMemo<RowActions>(
    () => ({
      react: (...a) => chatActions.current.react(...a),
      edit: (...a) => chatActions.current.edit(...a),
      deleteMessage: (m) => chatActions.current.deleteMessage(m),
      retry: (m) => chatActions.current.retry(m),
      reply: (m) => {
        setReply((current) => ({ ...current, [m.groupId]: m }));
        requestAnimationFrame(() => composer.current?.focus());
      },
      jump: (groupId, id) => jumpHandler.current(groupId, id),
      queueControl: (...a) => chatActions.current.queueControl(...a),
      resendDraft: (...a) => chatActions.current.resendDraft(...a),
    }),
    [],
  );

  const [query, setQuery] = useState("");
  const [modal, setModal] = useState<
    | "new"
    | "invite"
    | "settings"
    | "identity"
    | "audio"
    | "history"
    | "notifications"
    | "sounds"
    | "group"
    | "storage"
    | null
  >(null);
  const [settingsParent, setSettingsParent] = useState(false);
  // On phones the chat list and the conversation are separate full-screen panes.
  const [phonePane, setPhonePane] = useState<"list" | "chat">("chat");
  const closeModal = useCallback(() => {
    setModal(null);
    setSettingsParent(false);
  }, []);
  const backToSettings = useCallback(() => {
    setModal("settings");
    setSettingsParent(false);
  }, []);
  const openSettingsSection = (
    section:
      "audio" | "identity" | "history" | "notifications" | "sounds" | "storage",
  ) => {
    setSettingsParent(true);
    setModal(section);
  };
  useEffect(() => {
    const message = sessionStorage.getItem("gather.recovery-invite-error");
    if (message) {
      notify(message);
      sessionStorage.removeItem("gather.recovery-invite-error");
    }
  }, [notify]);
  const [showSavedChats, setShowSavedChats] = useState(false);
  const [mutedChats, setMutedChats] = useState(
    () => readNotificationPreferences(session).muted,
  );
  const [showPeople, setShowPeople] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(
        localStorage.getItem(`gather.drafts.${session.user.id}`) || "{}",
      );
    } catch {
      return {};
    }
  });
  const [newName, setNewName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [profileName, setProfileName] = useState(session.user.name);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [copied, setCopied] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiPanel = useRef<HTMLDivElement>(null);
  const emojiTrigger = useRef<HTMLButtonElement>(null);
  const dismissEmoji = useCallback(() => setEmojiOpen(false), []);
  useDismissable(emojiOpen, emojiPanel, dismissEmoji, emojiTrigger);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const caret = useRef({ groupId: "", start: 0, end: 0 });
  const emojiUndo = useRef<{
    groupId: string;
    before: string;
    after: string;
    start: number;
    end: number;
  } | null>(null);

  const filePicker = useRef<HTMLInputElement>(null);
  const [filesByGroup, setFilesByGroup] = useState<Record<string, File[]>>({});
  const [savingFiles, setSavingFiles] = useState(false);
  const updateBusy =
    Boolean(call.group) ||
    call.state !== "idle" ||
    avatarBusy ||
    savingFiles ||
    Object.values(filesByGroup).some((files) => files.length > 0) ||
    Object.keys(chat.transfers).length > 0;
  useEffect(() => {
    onUpdateBusy(updateBusy);
    return () => onUpdateBusy(false);
  }, [updateBusy, onUpdateBusy]);
  const savingDraft = useRef(false);
  const selectedChat = useRef(chat.selected);
  selectedChat.current = chat.selected;
  const nearBottom = useRef(true);
  type ReadingPoint = { id?: string; offset: number; bottom: boolean };
  const readingKey = `gather.reading.${historyScope(session)}`;
  const reading = useRef<Record<string, ReadingPoint>>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(readingKey) || "{}");
      } catch {
        return {};
      }
    })(),
  );
  const restoring = useRef<{ groupId: string; point: ReadingPoint } | null>(
    null,
  );
  const readingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  function saveReading() {
    const element = list.current;
    if (!element) return;
    const rows = element.querySelectorAll<HTMLElement>(".message-row");
    const top = element.getBoundingClientRect().top;
    let lo = 0,
      hi = rows.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (rows[mid].getBoundingClientRect().bottom < top) lo = mid + 1;
      else hi = mid;
    }
    const row = rows[lo];
    if (!row) return;
    reading.current[chat.selected] = {
      id: row.dataset.messageId,
      offset: row.getBoundingClientRect().top - top,
      bottom: nearBottom.current && !chat.hasNewer,
    };
    try {
      localStorage.setItem(readingKey, JSON.stringify(reading.current));
    } catch {}
  }
  const saveReadingRef = useRef(saveReading);
  saveReadingRef.current = saveReading;
  function chooseChat(id: string) {
    saveReadingRef.current();
    chat.select(id);
    setPhonePane("chat");
  }
  useEffect(() => setPhonePane("chat"), [chat.selected]);
  useEffect(() => {
    const save = () => saveReadingRef.current();
    window.addEventListener("pagehide", save);
    window.addEventListener("blur", save);
    return () => {
      clearTimeout(readingTimer.current);
      window.removeEventListener("pagehide", save);
      window.removeEventListener("blur", save);
    };
  }, []);

  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const historyAnchor = useRef<{
    groupId: string;
    firstId?: string;
    height: number;
    top: number;
    messageId?: string;
    y?: number;
  } | null>(null);
  const group = chat.groups.find((g) => g.id === chat.selected);
  const readOnly = Boolean(group?.access && group.access !== "active");
  useEffect(() => {
    if (readOnly) setShowSavedChats(true);
  }, [readOnly]);
  useEffect(() => {
    if (
      call.group &&
      chat.groups.some(
        (g) => g.id === call.group?.id && g.access && g.access !== "active",
      )
    )
      call.leave();
    if (readOnly) {
      setEmojiOpen(false);
      if (modal === "group" || modal === "invite") closeModal();
    }
  }, [chat.groups, call.group, readOnly, modal, closeModal]);
  const people = useMemo(
    () => Object.fromEntries(group?.members.map((p) => [p.id, p.name]) ?? []),
    [group?.members],
  );
  const messageIndex = useMemo(
    () => new Map(chat.messages.map((m) => [m.id, m])),
    [chat.messages],
  );
  const [jumpTarget, setJumpTarget] = useState<{
    groupId: string;
    id: string;
  } | null>(null);
  const [highlight, setHighlight] = useState("");
  jumpHandler.current = (groupId, id) => {
    nearBottom.current = false;
    void chatActions.current
      .jumpTo(groupId, id)
      .then(() => {
        closeModal();
        setJumpTarget({ groupId, id });
      })
      .catch((e) => notify(e.message));
  };
  useLayoutEffect(() => {
    if (!jumpTarget || jumpTarget.groupId !== chat.selected) return;
    const target = list.current?.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(jumpTarget.id)}"]`,
    );
    if (!target) return;
    nearBottom.current = false;
    target.scrollIntoView({ block: "center" });
    setAwayFromBottom(true);
    setHighlight(jumpTarget.id);
    setJumpTarget(null);
  }, [jumpTarget, chat.selected, chat.messages]);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(""), 2000);
    return () => clearTimeout(timer);
  }, [highlight]);
  const notificationGroups = useRef(chat.groups);
  notificationGroups.current = chat.groups;
  useEffect(() => {
    function open(value: { scope: string; groupId: string }) {
      if (
        value?.scope !== historyScope(session) ||
        !notificationGroups.current.some((g) => g.id === value.groupId)
      )
        return;
      chooseChat(value.groupId);
      closeModal();
      setTimeout(() => composer.current?.focus(), 0);
    }
    const listener = (event: Event) => open((event as CustomEvent).detail);
    window.addEventListener("gather:open-notification", listener);
    const remove = window.desktop?.onNotificationOpen(open);
    return () => {
      remove?.();
      window.removeEventListener("gather:open-notification", listener);
    };
  }, [session.server, session.user.id, closeModal]);
  const draft = drafts[chat.selected] || "";
  const pendingFiles = filesByGroup[chat.selected] || [];
  useEffect(() => {
    if (
      window.desktop ||
      !Object.values(filesByGroup).some((files) => files.length)
    )
      return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [filesByGroup]);

  function addFiles(files: File[]) {
    if (!chat.capabilities.includes("attachments-v1")) return;
    if (files.some((file) => !file.size || file.size > 10_000_000)) {
      chat.setError("Choose files under 10 MB for cloud sharing.");
      return;
    }
    if (pendingFiles.length + files.length > 4) {
      chat.setError("Choose up to four files per message.");
      return;
    }
    setFilesByGroup((current) => ({
      ...current,
      [chat.selected]: [...(current[chat.selected] || []), ...files],
    }));
  }
  const groupIndex = chat.groups.findIndex((g) => g.id === chat.selected);
  const peersInVoice = chat.voice[chat.selected] || [];
  const voiceFull =
    peersInVoice.length >= chat.voiceLimit &&
    !peersInVoice.includes(session.user.id);
  const isCurrentCall = call.group?.id === group?.id;
  const wideLayout = () => window.matchMedia("(min-width: 861px)").matches;
  // In a call the main area is the call stage, with chat beside it (or a tab
  // on narrow windows). Entering a call opens chat only where there's room.
  const [chatOpen, setChatOpen] = useState(wideLayout);
  const [chatUnread, setChatUnread] = useState(0);
  const staged = isCurrentCall && !readOnly;
  useEffect(() => {
    if (staged) setChatOpen(wideLayout());
  }, [staged]);
  const lastMessage = chat.messages[chat.messages.length - 1];
  const seenMessage = useRef(lastMessage?.id);
  useEffect(() => {
    const changed = seenMessage.current !== lastMessage?.id;
    seenMessage.current = lastMessage?.id;
    if (!changed || !lastMessage) return;
    if (staged && !chatOpen && lastMessage.userId !== session.user.id)
      setChatUnread((n) => n + 1);
  }, [lastMessage?.id]);
  useEffect(() => {
    if (chatOpen || !staged) setChatUnread(0);
  }, [chatOpen, staged]);
  function answerRing(ring: IncomingRing) {
    chat.rings.drop(ring.groupId);
    const target = chat.groups.find((g) => g.id === ring.groupId);
    if (!target) return;
    if (call.group && call.group.id !== target.id) call.leave();
    chat.select(target.id);
    if (call.group?.id !== target.id) void call.join(target);
  }
  function audioSettings() {
    void call.refreshDevices();
    setModal("audio");
  }
  const appliedInvite = useRef("");
  useEffect(() => {
    if (
      window.desktop ||
      !chat.initialized ||
      !location.pathname.startsWith("/join/") ||
      appliedInvite.current === location.href
    )
      return;
    appliedInvite.current = location.href;
    try {
      const invite = parseInvite(location.href);
      if (invite.server === session.server) {
        const existing = chat.groups.find((g) => g.inviteCode === invite.code);
        if (existing) {
          chooseChat(existing.id);
          history.replaceState(null, "", "/");
          return;
        }
        void chat
          .joinGroup(invite.code)
          .then(() => history.replaceState(null, "", "/"))
          .catch((e) => notify(e.message));
      }
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "That invite is not valid.",
      );
    }
  }, [session, notify, chat.initialized]);
  const [lastRead, setLastRead] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(
        localStorage.getItem(`gather.read.${session.user.id}`) || "{}",
      );
    } catch {
      return {};
    }
  });
  useEffect(() => {
    const restored = (event: Event) => {
      if ((event as CustomEvent).detail?.scope !== historyScope(session))
        return;
      reading.current = {};
      setLastRead({});
      setUnread({});
      try {
        localStorage.removeItem(readingKey);
        localStorage.removeItem(`gather.read.${session.user.id}`);
      } catch {}
    };
    window.addEventListener("gather:server-restored", restored);
    return () => window.removeEventListener("gather:server-restored", restored);
  }, [readingKey, session.server, session.user.id]);
  useEffect(() => {
    try {
      localStorage.setItem(
        `gather.drafts.${session.user.id}`,
        JSON.stringify(drafts),
      );
    } catch {
      notify(
        "Your draft could not be saved on this device. Keep Gather open or copy it before leaving.",
      );
    }
  }, [drafts, session.user.id]);
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    const element = list.current;
    if (!anchor || !element) return;
    if (anchor.groupId !== chat.selected) {
      historyAnchor.current = null;
      return;
    }
    if (chat.messages[0]?.id !== anchor.firstId) {
      const bubble = anchor.messageId
        ? element.querySelector(
            `[data-message-id="${CSS.escape(anchor.messageId)}"] .message-bubble`,
          )
        : null;
      if (bubble && anchor.y !== undefined)
        element.scrollTop += bubble.getBoundingClientRect().top - anchor.y;
      else
        element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
      historyAnchor.current = null;
    } else if (!olderLoading) historyAnchor.current = null;
  }, [chat.messages[0]?.id, chat.selected, olderLoading]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const keepBottom = () => {
      if (nearBottom.current) element.scrollTop = element.scrollHeight;
    };
    keepBottom();
    const observer = new ResizeObserver(keepBottom);
    observer.observe(element);
    // Images and GIFs grow the list after they load; stay pinned to the latest message.
    element.addEventListener("load", keepBottom, true);
    return () => {
      observer.disconnect();
      element.removeEventListener("load", keepBottom, true);
    };
  }, [group?.id, call.group?.id]);
  useLayoutEffect(() => {
    // Follow appended messages before the browser's scroll anchoring can turn
    // a growing message list into an apparent manual scroll into old history.
    if (nearBottom.current && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [chat.messages.length, chat.messages.at(-1)?.status]);
  useLayoutEffect(() => {
    const point = reading.current[chat.selected];
    restoring.current =
      point && !point.bottom ? { groupId: chat.selected, point } : null;
    nearBottom.current = !point || point.bottom;
    setAwayFromBottom(!nearBottom.current);
    setEmojiOpen(false);
    if (!point || point.bottom) {
      bottom.current?.scrollIntoView({ behavior: "instant" });
      return;
    }
    if (point.id && !chat.messages.some((m) => m.id === point.id))
      void chatActions.current.jumpTo(chat.selected, point.id).catch(() => {
        restoring.current = null;
        notify(
          "Your earlier reading point is unavailable. Saved history is still searchable.",
        );
      });
  }, [chat.selected]);
  useLayoutEffect(() => {
    const pending = restoring.current,
      element = list.current;
    if (!pending || pending.groupId !== chat.selected || !element) return;
    const row = element.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(pending.point.id ?? "")}"]`,
    );
    if (!row) return;
    nearBottom.current = false;
    element.scrollTop +=
      row.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      pending.point.offset;
    restoring.current = null;
  }, [chat.messages, chat.selected]);
  const latestSequence = chat.messages
    .filter((m) => !m.status)
    .at(-1)?.sequence;
  const markRead = useCallback(() => {
    if (latestSequence && nearBottom.current && document.hasFocus())
      setLastRead((current) => {
        if ((current[chat.selected] || 0) >= latestSequence) return current;
        const next = { ...current, [chat.selected]: latestSequence };
        try {
          localStorage.setItem(
            `gather.read.${session.user.id}`,
            JSON.stringify(next),
          );
        } catch {}
        return next;
      });
  }, [latestSequence, chat.selected, session.user.id]);
  useEffect(() => {
    markRead();
    window.addEventListener("focus", markRead);
    document.addEventListener("visibilitychange", markRead);
    return () => {
      window.removeEventListener("focus", markRead);
      document.removeEventListener("visibilitychange", markRead);
    };
  }, [markRead]);
  const [unreadInfo, setUnreadInfo] = useState<
    Record<string, { count: number; firstId?: string }>
  >({});
  const groupIdsKey = chat.groups.map((g) => g.id).join(",");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          void localHistory<
            Record<string, { count: number; firstId?: string }>
          >({
            operation: "unread",
            scope: historyScope(session),
            userId: session.user.id,
            after: Object.fromEntries(
              groupIdsKey
                .split(",")
                .filter(Boolean)
                .map((id) => [id, lastRead[id] ?? 0]),
            ),
          })
            .then((result) => {
              if (active) {
                setUnreadInfo(result);
                setUnread(
                  Object.fromEntries(
                    Object.entries(result).map(([id, value]) => [
                      id,
                      value.count,
                    ]),
                  ),
                );
              }
            })
            .catch(() => {}),
        150,
      );
    };
    update();
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail?.scope === historyScope(session))
        update();
    };
    window.addEventListener("gather:history-updated", changed);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("gather:history-updated", changed);
    };
  }, [groupIdsKey, lastRead, session.server, session.user.id]);
  useEffect(() => {
    setFormError("");
    setCopied(false);
  }, [modal]);
  const invite = group ? `${session.server}/join/${group.inviteCode}` : "";
  const local =
    new URL(session.server).hostname === "127.0.0.1" ||
    new URL(session.server).hostname === "localhost";
  function updateDraft(value: string) {
    setDrafts((current) => ({ ...current, [chat.selected]: value }));
    chat.noteTyping(Boolean(value.trim()));
  }
  const newMessages = chat.messages.filter(
    (m) =>
      !m.status &&
      m.userId !== session.user.id &&
      m.sequence > (lastRead[chat.selected] || 0),
  ).length;
  const typingNames = chat.typing.slice(0, 2).map((person) => person.name);
  const typingText = typingNames.length
    ? `${typingNames.join(" and ")}${chat.typing.length > 2 ? " and others" : ""} ${chat.typing.length === 1 ? "is" : "are"} typing`
    : "";
  async function send(e?: FormEvent) {
    e?.preventDefault();
    if ((!draft.trim() && !pendingFiles.length) || savingDraft.current) return;
    savingDraft.current = true;
    const submitted = draft;
    const target = chat.selected;
    const submittedFiles = pendingFiles;
    setSavingFiles(true);
    let saved = false;
    try {
      saved = await chat.send(submitted, submittedFiles, reply[target]?.id);
    } finally {
      savingDraft.current = false;
      setSavingFiles(false);
    }
    if (!saved) return;
    setReply((current) => ({ ...current, [target]: undefined }));
    setFilesByGroup((current) => ({
      ...current,
      [target]: (current[target] || []).filter(
        (file) => !submittedFiles.includes(file),
      ),
    }));
    setDrafts((current) =>
      current[target] === submitted ? { ...current, [target]: "" } : current,
    );
    if (selectedChat.current !== target) return;
    setEmojiOpen(false);
    nearBottom.current = true;
    setAwayFromBottom(false);
    composer.current?.focus();
  }
  const gifSearch = useCallback<GifSearch>(
    (query, page, signal) =>
      api(
        session,
        `/api/gifs/${query ? "search" : "trending"}?${new URLSearchParams({ q: query, page: String(page) })}`,
        { signal },
      ),
    [session],
  );
  async function sendGif(url: string) {
    const target = chat.selected;
    if (!(await chat.send(url, [], reply[target]?.id))) return;
    setReply((current) => ({ ...current, [target]: undefined }));
    if (selectedChat.current !== target) return;
    setEmojiOpen(false);
    nearBottom.current = true;
    setAwayFromBottom(false);
    composer.current?.focus();
  }
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setFormError("");
    try {
      await task();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function copyInvite() {
    try {
      if (window.desktop) await window.desktop.copyInvite(invite);
      else await navigator.clipboard.writeText(invite);
      setCopied(true);
    } catch {
      setFormError("Copy the invite from the field below.");
    }
  }
  async function exportHistory() {
    await action(async () => {
      const result = await exportArchive(session);
      downloadArchive(result.archive);
      if (result.missingFiles)
        notify(
          `Exported history. ${result.missingFiles} original files were unavailable and are marked missing.`,
        );
      else if (!result.serverIncluded)
        notify("Exported this device’s saved history. Server unavailable.");
    });
  }
  return (
    <div className="workspace" data-pane={group ? phonePane : "list"}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Brand />
        </div>
        <div className="search-field">
          <Search size={17} />
          <input
            aria-label="Search conversations"
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="sidebar-section">
          <h2>{showSavedChats ? "Saved chats" : "Chats"}</h2>
          <button
            className="icon-button"
            aria-label="New chat"
            title="New chat"
            onClick={() => setModal("new")}
          >
            <Plus size={19} />
          </button>
        </div>
        <nav className="chat-list" aria-label="Conversations">
          {chat.groups
            .filter((g) =>
              showSavedChats
                ? Boolean(g.access && g.access !== "active")
                : !g.access || g.access === "active",
            )
            .filter((g) => g.name.toLowerCase().includes(query.toLowerCase()))
            .map((g) => (
              <button
                key={g.id}
                className={cx(
                  "chat-item",
                  chat.selected === g.id && "selected",
                )}
                onClick={() => chooseChat(g.id)}
              >
                <GroupIcon
                  index={chat.groups.indexOf(g)}
                  small
                  avatarId={g.avatarId}
                />
                <span className="chat-item-text">
                  <span className="chat-item-name">{g.name}</span>
                  <span
                    className={cx(
                      "chat-preview",
                      Boolean(chat.voice[g.id]?.length) && "voice-preview",
                    )}
                  >
                    {chat.voice[g.id]?.length ? (
                      <>
                        <AudioLines size={13} /> {chat.voice[g.id].length} in
                        voice
                      </>
                    ) : g.lastMessage ? (
                      g.lastMessage.deletedAt ? (
                        "Message deleted"
                      ) : (
                        `${g.lastMessage.userId === session.user.id ? "You" : g.lastMessage.name}: ${g.lastMessage.body}`
                      )
                    ) : (
                      "No messages yet"
                    )}
                  </span>
                </span>
                {unread[g.id] ? (
                  <span className="unread-dot" aria-label="Unread messages" />
                ) : (
                  <span className="chat-item-time">
                    {g.lastMessage
                      ? new Date(g.lastMessage.createdAt).toLocaleTimeString(
                          [],
                          { hour: "numeric", minute: "2-digit" },
                        )
                      : ""}
                  </span>
                )}
              </button>
            ))}
          {query &&
            !chat.groups.some((g) =>
              g.name.toLowerCase().includes(query.toLowerCase()),
            ) && (
              <p className="empty-search">No conversations called “{query}”.</p>
            )}
        </nav>
        {chat.groups.some((g) => g.access && g.access !== "active") && (
          <button
            className="text-button saved-chats-toggle"
            onClick={() => setShowSavedChats((value) => !value)}
          >
            {showSavedChats ? "Back to active chats" : "Saved chats"}
          </button>
        )}
        <button className="sidebar-invite" onClick={() => setModal("new")}>
          <Link size={16} />
          <span>Join a chat</span>
        </button>
        <div className="sidebar-bottom">
          <div className="profile-bar">
            <Avatar person={self} online={chat.connection === "connected"} />
            <div>
              <strong>{session.user.name}</strong>
              <span>
                {chat.connection === "connected" ? "Online" : "Reconnecting…"}
              </span>
            </div>
            <button
              className="icon-button"
              aria-label="Settings"
              title="Settings"
              onClick={() => setModal("settings")}
            >
              <Settings size={19} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-panel">
        {group ? (
          <>
            <header className="conversation-header">
              <button
                className="icon-button header-back"
                aria-label="Back to chats"
                title="Back to chats"
                onClick={() => setPhonePane("list")}
              >
                <ArrowLeft size={22} />
              </button>
              <GroupIcon index={groupIndex} avatarId={group.avatarId} />
              <div className="conversation-heading">
                <h1>
                  {!readOnly &&
                  chat.capabilities.includes("group-profile-v1") ? (
                    <button
                      className="group-title-button"
                      title="Chat details"
                      onClick={() => setModal("group")}
                    >
                      {group.name}
                      <ChevronDown size={13} />
                    </button>
                  ) : (
                    group.name
                  )}
                </h1>
                <button
                  disabled={readOnly}
                  onClick={() => setShowPeople(!showPeople)}
                >
                  {readOnly ? (
                    "Saved history · No longer a member"
                  ) : (
                    <>
                      {group.members.length}{" "}
                      {group.members.length === 1 ? "person" : "people"}
                      <span>·</span>
                      {
                        group.members.filter((p) => chat.online.includes(p.id))
                          .length
                      }{" "}
                      online
                      <ChevronDown size={12} />
                    </>
                  )}
                </button>
              </div>
              <div className="header-actions">
                <button
                  className="icon-button"
                  title="Search messages"
                  aria-label="Search messages"
                  onClick={() => setModal("history")}
                >
                  <Search size={20} />
                </button>
                {!readOnly && (
                  <button
                    className="icon-button"
                    title="Invite a friend"
                    aria-label="Invite a friend"
                    onClick={() => setModal("invite")}
                  >
                    <Users size={20} />
                  </button>
                )}
                <span className="action-divider" />
                {isCurrentCall ? (
                  <span className="button soft-green" role="status">
                    <Phone size={16} fill="currentColor" />{" "}
                    <span className="btn-label">In voice</span>
                  </span>
                ) : !readOnly ? (
                  <button
                    className="button primary"
                    disabled={
                      !!call.group ||
                      chat.connection !== "connected" ||
                      voiceFull
                    }
                    title={
                      call.group
                        ? "Leave your current call before joining this chat’s call."
                        : voiceFull
                          ? `This call is full (${chat.voiceLimit} people).`
                          : chat.connection !== "connected"
                            ? "Waiting for your connection to recover."
                            : "Join voice"
                    }
                    onClick={() => void call.join(group)}
                  >
                    <Phone size={16} fill="currentColor" />{" "}
                    <span className="btn-label">
                      {voiceFull ? "Voice full" : "Join voice"}
                    </span>
                  </button>
                ) : null}
              </div>
            </header>
            {chat.connection !== "connected" && (
              <div className="connection-banner" role="status">
                <WifiOff size={15} />
                <span>
                  {chat.connection === "connecting"
                    ? "Connecting…"
                    : "Reconnecting… Your drafts are saved."}
                </span>
              </div>
            )}
            {(notice || chat.error) && (
              <div className="notice" role="alert">
                <span>{notice || chat.error}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss notice"
                  onClick={() => {
                    setNotice("");
                    chat.setError("");
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {!staged && !readOnly && peersInVoice.length > 0 && (
              <div className="voice-banner" role="status">
                <span className="voice-banner-people">
                  {peersInVoice.slice(0, 4).map((id) => {
                    const person = group.members.find((m) => m.id === id);
                    return person ? (
                      <Avatar key={id} person={person} size="mini" />
                    ) : null;
                  })}
                </span>
                <span>
                  {(() => {
                    const names = peersInVoice
                      .map((id) => group.members.find((m) => m.id === id)?.name)
                      .filter(Boolean) as string[];
                    return names.length > 2
                      ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more are in voice`
                      : `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} in voice`;
                  })()}
                </span>
                <button
                  className="button primary"
                  disabled={
                    !!call.group || chat.connection !== "connected" || voiceFull
                  }
                  onClick={() => void call.join(group)}
                >
                  <Phone size={14} fill="currentColor" />{" "}
                  {voiceFull ? "Voice full" : "Join"}
                </button>
              </div>
            )}
            <div
              className={cx("conversation-body", staged && "staged")}
              data-chat={staged ? String(chatOpen) : undefined}
            >
              {staged && (
                <CallStage
                  group={group}
                  me={session.user.id}
                  call={call}
                  online={chat.online}
                  ringStatus={chat.rings.status[group.id] ?? {}}
                  chatOpen={chatOpen}
                  chatUnread={chatUnread}
                  onToggleChat={() => setChatOpen((open) => !open)}
                  onRing={(target) =>
                    void chat.rings
                      .ring(group.id, target)
                      .catch((e) => notify(e.message))
                  }
                  onCancelRing={(id) => chat.rings.cancel(group.id, [id])}
                  onAudioSettings={audioSettings}
                />
              )}
              <div className="chat-column">
                <div
                  className="message-scroll"
                  ref={list}
                  onScroll={() => {
                    if (list.current) {
                      clearTimeout(readingTimer.current);
                      readingTimer.current = setTimeout(
                        () => saveReadingRef.current(),
                        120,
                      );
                      nearBottom.current =
                        list.current.scrollHeight -
                          list.current.scrollTop -
                          list.current.clientHeight <
                        100;
                      setAwayFromBottom(!nearBottom.current);
                      if (nearBottom.current) markRead();
                    }
                  }}
                >
                  {chat.hasMore && (
                    <button
                      className="load-older text-button"
                      disabled={olderLoading}
                      onClick={() => {
                        if (olderLoading || !list.current) return;
                        const row = [
                          ...list.current.querySelectorAll<HTMLElement>(
                            ".message-row",
                          ),
                        ].find(
                          (element) =>
                            element.getBoundingClientRect().bottom >
                            list.current!.getBoundingClientRect().top,
                        );
                        historyAnchor.current = {
                          groupId: chat.selected,
                          firstId: chat.messages[0]?.id,
                          height: list.current.scrollHeight,
                          top: list.current.scrollTop,
                          messageId: row?.dataset.messageId,
                          y: row
                            ?.querySelector(".message-bubble")
                            ?.getBoundingClientRect().top,
                        };
                        nearBottom.current = false;
                        setAwayFromBottom(true);
                        setOlderLoading(true);
                        void chat
                          .loadOlder()
                          .catch((e) => notify(e.message))
                          .finally(() => setOlderLoading(false));
                      }}
                    >
                      Load earlier messages
                    </button>
                  )}
                  {chat.loading && !chat.messages.length ? (
                    <p className="loading-text">
                      <LoaderCircle className="spin" size={16} /> Loading
                      messages…
                    </p>
                  ) : !chat.messages.length ? (
                    <div className="empty-conversation">
                      <MessageCircle size={30} />
                      <h3>No messages yet</h3>
                      <button
                        className="text-button"
                        hidden={readOnly}
                        onClick={() => setModal("invite")}
                      >
                        Invite a friend <ArrowRight size={14} />
                      </button>
                    </div>
                  ) : (
                    <div
                      className="messages"
                      aria-live="polite"
                      aria-relevant="additions"
                    >
                      {chat.messages.map((m, i) => {
                        const previous = chat.messages[i - 1];
                        const person = group.members.find(
                          (p) => p.id === m.userId,
                        );
                        return (
                          <MessageRow
                            key={`${m.userId}:${m.clientId}`}
                            message={m}
                            grouped={
                              previous?.userId === m.userId &&
                              m.createdAt - previous.createdAt < 180000 &&
                              new Date(previous.createdAt).toDateString() ===
                                new Date(m.createdAt).toDateString()
                            }
                            session={session}
                            readOnly={readOnly}
                            online={chat.connection === "connected"}
                            reactions={chat.capabilities.includes(
                              "reactions-v1",
                            )}
                            mutations={chat.capabilities.includes(
                              "message-mutations-v1",
                            )}
                            personName={person?.name ?? m.name}
                            avatarId={person?.avatarId}
                            last={i === chat.messages.length - 1}
                            transfer={chat.transfers[m.clientId]}
                            actions={rowActions}
                            people={people}
                            replyTarget={
                              m.replyTo
                                ? messageIndex.get(m.replyTo)
                                : undefined
                            }
                            day={
                              !previous ||
                              new Date(previous.createdAt).toDateString() !==
                                new Date(m.createdAt).toDateString()
                                ? new Date(m.createdAt).toLocaleDateString(
                                    undefined,
                                    {
                                      weekday: "short",
                                      month: "short",
                                      day: "numeric",
                                      year: "numeric",
                                    },
                                  )
                                : undefined
                            }
                            firstUnread={
                              unreadInfo[chat.selected]?.firstId === m.id
                            }
                            highlighted={highlight === m.id}
                          />
                        );
                      })}
                    </div>
                  )}
                  {chat.hasNewer && (
                    <button
                      className="load-older text-button"
                      onClick={() =>
                        void chat.loadNewer().catch((e) => notify(e.message))
                      }
                    >
                      Load newer messages
                    </button>
                  )}
                  <div ref={bottom} />
                </div>
                {readOnly ? (
                  <div className="chat-readonly" role="status">
                    <strong>
                      {group.access === "left"
                        ? "You left this chat."
                        : "You’re no longer a member of this chat."}
                    </strong>
                    <span>
                      Your saved messages and files stay on this device. A new
                      invite is needed to rejoin.
                    </span>
                  </div>
                ) : (
                  <form
                    className="composer-area"
                    onSubmit={send}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes("Files"))
                        e.preventDefault();
                    }}
                    onDrop={(e) => {
                      if (e.dataTransfer.files.length) {
                        e.preventDefault();
                        addFiles([...e.dataTransfer.files]);
                      }
                    }}
                    onPaste={(e) => {
                      if (e.clipboardData.files.length) {
                        e.preventDefault();
                        addFiles([...e.clipboardData.files]);
                      }
                    }}
                  >
                    {unreadInfo[chat.selected]?.firstId && awayFromBottom && (
                      <button
                        type="button"
                        className="text-button first-unread-jump"
                        onClick={() =>
                          jumpHandler.current(
                            chat.selected,
                            unreadInfo[chat.selected].firstId!,
                          )
                        }
                      >
                        First unread message
                      </button>
                    )}
                    {(awayFromBottom || chat.hasNewer) && (
                      <button
                        type="button"
                        className="jump-latest"
                        onClick={() => {
                          if (chat.hasNewer) {
                            void chat
                              .loadLatest()
                              .catch((e) => notify(e.message));
                          }
                          nearBottom.current = true;
                          setAwayFromBottom(false);
                          bottom.current?.scrollIntoView({
                            behavior: "instant",
                          });
                          markRead();
                        }}
                      >
                        {newMessages
                          ? `${newMessages} new ${newMessages === 1 ? "message" : "messages"}`
                          : "Latest messages"}{" "}
                        <ChevronDown size={14} />
                      </button>
                    )}
                    <div
                      className="typing-indicator"
                      role="status"
                      aria-live="polite"
                    >
                      {typingText && (
                        <>
                          <span className="typing-dots" aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                          <span>{typingText}</span>
                        </>
                      )}
                    </div>
                    {emojiOpen && (
                      <div
                        ref={emojiPanel}
                        className="emoji-picker"
                        aria-label="Choose an emoji"
                      >
                        <EmoticonPicker
                          gifSearch={
                            chat.capabilities.includes("gif-search-v1")
                              ? gifSearch
                              : undefined
                          }
                          onGif={(url) => void sendGif(url)}
                          onSelect={(value) => {
                            const position =
                              caret.current.groupId === chat.selected
                                ? caret.current
                                : { start: draft.length, end: draft.length };
                            const next =
                              draft.slice(0, position.start) +
                              value +
                              draft.slice(position.end);
                            if (next.length > 4000) {
                              notify("Your message is at the character limit.");
                              return;
                            }
                            emojiUndo.current = {
                              groupId: chat.selected,
                              before: draft,
                              after: next,
                              start: position.start,
                              end: position.end,
                            };
                            updateDraft(next);
                            setEmojiOpen(false);
                            requestAnimationFrame(() => {
                              composer.current?.focus();
                              composer.current?.setSelectionRange(
                                position.start + value.length,
                                position.start + value.length,
                              );
                            });
                          }}
                        />
                      </div>
                    )}
                    {reply[chat.selected] && (
                      <div className="composer-reply">
                        <span>
                          <strong>Reply to {reply[chat.selected]!.name}</strong>
                          <small>
                            {messageIndex.get(reply[chat.selected]!.id)
                              ?.deletedAt
                              ? "Message deleted"
                              : (messageIndex.get(reply[chat.selected]!.id)
                                  ?.body ?? reply[chat.selected]!.body)}
                          </small>
                        </span>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Cancel reply"
                          onClick={() =>
                            setReply((current) => ({
                              ...current,
                              [chat.selected]: undefined,
                            }))
                          }
                        >
                          <X size={16} />
                        </button>
                      </div>
                    )}
                    <div className="composer">
                      {chat.capabilities.includes("attachments-v1") && (
                        <>
                          <input
                            ref={filePicker}
                            type="file"
                            multiple
                            hidden
                            onChange={(e) => {
                              addFiles([...(e.target.files || [])]);
                              e.target.value = "";
                            }}
                          />
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Attach files"
                            title="Share files · 10 MB each through cloud"
                            disabled={savingFiles}
                            onClick={() => filePicker.current?.click()}
                          >
                            <Paperclip size={20} />
                          </button>
                        </>
                      )}
                      <textarea
                        ref={composer}
                        aria-label="Message"
                        placeholder={`Message ${group.name}…`}
                        value={draft}
                        maxLength={4000}
                        rows={1}
                        onChange={(e) => updateDraft(e.target.value)}
                        onSelect={(event) => {
                          caret.current = {
                            groupId: chat.selected,
                            start: event.currentTarget.selectionStart,
                            end: event.currentTarget.selectionEnd,
                          };
                        }}
                        onBlur={(event) => {
                          caret.current = {
                            groupId: chat.selected,
                            start: event.currentTarget.selectionStart,
                            end: event.currentTarget.selectionEnd,
                          };
                          chat.noteTyping(false);
                        }}
                        onKeyDown={(e) => {
                          const undo = emojiUndo.current;
                          if (
                            (e.ctrlKey || e.metaKey) &&
                            !e.shiftKey &&
                            e.key.toLowerCase() === "z" &&
                            undo?.groupId === chat.selected &&
                            draft === undo.after
                          ) {
                            e.preventDefault();
                            updateDraft(undo.before);
                            emojiUndo.current = null;
                            requestAnimationFrame(() =>
                              composer.current?.setSelectionRange(
                                undo.start,
                                undo.end,
                              ),
                            );
                            return;
                          }
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.nativeEvent.isComposing
                          ) {
                            e.preventDefault();
                            send();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="icon-button emoji-button"
                        ref={emojiTrigger}
                        aria-label="Add emoji"
                        aria-expanded={emojiOpen}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setEmojiOpen(!emojiOpen)}
                      >
                        <Smile size={21} />
                      </button>
                      <button
                        className="send-button"
                        aria-label="Send message"
                        disabled={
                          savingFiles || (!draft.trim() && !pendingFiles.length)
                        }
                      >
                        <Send size={18} />
                      </button>
                    </div>
                    {pendingFiles.length > 0 && (
                      <div className="pending-files">
                        {pendingFiles.map((file, index) => (
                          <div key={index}>
                            <span>{file.name}</span>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label={`Remove ${file.name}`}
                              disabled={savingFiles}
                              onClick={() =>
                                setFilesByGroup((current) => ({
                                  ...current,
                                  [chat.selected]: (
                                    current[chat.selected] || []
                                  ).filter((_, i) => i !== index),
                                }))
                              }
                            >
                              <X size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="composer-hint">
                      <span>
                        <kbd>Enter</kbd> to send <span>·</span>{" "}
                        <kbd>Shift + Enter</kbd> for a new line
                      </span>
                      <span>
                        {draft.length > 3500 ? `${draft.length}/4000` : ""}
                      </span>
                    </div>
                  </form>
                )}
              </div>
              {showPeople && !readOnly && (
                <aside className="people-panel">
                  <div className="people-title">
                    <h3>People</h3>
                    <button
                      className="icon-button"
                      aria-label="Close people panel"
                      onClick={() => setShowPeople(false)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  {group.members.map((p) => (
                    <div className="person-row" key={p.id}>
                      <Avatar person={p} online={chat.online.includes(p.id)} />
                      <div>
                        <strong>
                          {p.name}
                          {p.id === session.user.id ? " (you)" : ""}
                        </strong>
                        <span>
                          {chat.online.includes(p.id)
                            ? "Around"
                            : "Away for now"}
                        </span>
                      </div>
                    </div>
                  ))}
                  <button
                    className="button secondary"
                    onClick={() => setModal("invite")}
                  >
                    <Plus size={15} /> Invite a friend
                  </button>
                </aside>
              )}
            </div>
          </>
        ) : (
          <div className="workspace-loading">
            <LoaderCircle className="spin" />
            <h2>Loading chats…</h2>
            {chat.error && (
              <>
                <p>{chat.error}</p>
                <button
                  className="button secondary"
                  onClick={() =>
                    void chat.refresh().catch((e) => notify(e.message))
                  }
                >
                  Try again
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void onSession(null).catch((failure) =>
                      notify(failure.message),
                    )
                  }
                >
                  Change connection
                </button>
              </>
            )}
          </div>
        )}
        {call.group && !staged && (
          <section className="call-bar" aria-label="Active voice call">
            <div className="call-status">
              <span
                className={cx(
                  "call-indicator",
                  (call.state === "reconnecting" || call.state === "partial") &&
                    "recovering",
                )}
              >
                <AudioLines size={19} />
              </span>
              <div>
                <strong>{callStatusLabel(call.state)}</strong>
                <button onClick={() => chat.select(call.group!.id)}>
                  {chat.groups.find((g) => g.id === call.group?.id)?.name ??
                    call.group.name}
                </button>
              </div>
            </div>
            <div className="call-people">
              {call.people.map((p) => (
                <span
                  className={cx("call-person", p.speaking && "speaking")}
                  key={p.id}
                  aria-label={`${p.local ? "You" : p.name}${p.muted ? ", muted" : p.speaking ? ", speaking" : ""}${!p.local && p.connection !== "connected" ? `, ${p.connection}` : ""}`}
                  title={`${p.local ? "You" : p.name}${p.muted ? " · Muted" : ""}${!p.local && p.connection !== "connected" ? ` · ${p.connection === "reconnecting" ? "Reconnecting" : "Connecting"}` : ""}`}
                  data-connection={p.connection}
                >
                  <Avatar
                    person={
                      chat.groups
                        .flatMap((group) => group.members)
                        .find((person) => person.id === p.id) ?? p
                    }
                    size="mini"
                  />
                  <span>{p.local ? "You" : p.name}</span>
                  {!p.local && p.connection !== "connected" ? (
                    <LoaderCircle className="spin" size={12} />
                  ) : (
                    p.muted && <MicOff size={12} />
                  )}
                </span>
              ))}
            </div>
            <CallControls call={call} onAudioSettings={audioSettings} />
          </section>
        )}
      </main>
      <IncomingCalls
        rings={chat.rings.incoming}
        inCall={!!call.group}
        onAnswer={answerRing}
        onDecline={(ring) => chat.rings.decline(ring.groupId)}
      />
      {modal === "new" && (
        <Modal title="New chat" onClose={closeModal}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await chat.createGroup(newName);
                setNewName("");
                closeModal();
              });
            }}
          >
            <label htmlFor="group-name">Chat name</label>
            <input
              id="group-name"
              placeholder="Friday night crew"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              maxLength={48}
            />
            <button
              className="button primary full"
              disabled={busy || !newName.trim()}
            >
              <Plus size={16} /> Create chat
            </button>
          </form>
          <div className="or-divider">or join a chat</div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const parsed = parseInvite(joinCode);
                if (parsed.server && parsed.server !== session.server)
                  throw new Error(
                    "This invite uses a different server. Sign out in Settings, then join with this link.",
                  );
                await chat.joinGroup(parsed.code);
                setJoinCode("");
                closeModal();
              });
            }}
          >
            <label htmlFor="join-code">Invite link or code</label>
            <input
              id="join-code"
              placeholder="Paste an invite"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              required
            />
            <button
              className="button secondary full"
              disabled={busy || !joinCode.trim()}
            >
              <Link size={16} /> Join chat
            </button>
          </form>
          {formError && (
            <p className="form-error" role="alert">
              {formError}
            </p>
          )}
        </Modal>
      )}
      {modal === "invite" && group && !readOnly && (
        <Modal title="Invite a friend" onClose={closeModal}>
          <div className="invite-summary">
            <GroupIcon index={groupIndex} avatarId={group.avatarId} />
            <div>
              <strong>{group.name}</strong>
              <span>
                {group.members.length}{" "}
                {group.members.length === 1 ? "person" : "people"} · Private
                conversation
              </span>
            </div>
          </div>
          <label htmlFor="invite-link">Your invite link</label>
          <input
            id="invite-link"
            readOnly
            value={invite}
            onFocus={(e) => e.target.select()}
          />
          <button
            className="button primary full"
            onClick={() => void copyInvite()}
          >
            {copied ? <Check size={17} /> : <Copy size={17} />}
            {copied ? "Copied" : "Copy invite link"}
          </button>
          <p className="field-hint">
            Anyone with this link can join. Share it privately.
          </p>
          {group.ownerId === session.user.id && (
            <button className="text-button" onClick={() => setModal("group")}>
              Manage members and invite link
            </button>
          )}
          {local && (
            <p className="local-warning">
              This workspace is on your computer. Friends need a shared server
              address to connect from another computer.
            </p>
          )}
          {formError && <p className="form-error">{formError}</p>}
        </Modal>
      )}
      {modal === "group" && group && !readOnly && (
        <Modal title="Chat details" onClose={closeModal}>
          {chat.capabilities.includes("avatars-v1") && (
            <AvatarEditor
              session={session}
              target={group.id}
              current={group}
              online={chat.connection === "connected"}
              onSaved={async () => {
                await chat.refresh();
              }}
              onBusy={setAvatarBusy}
            />
          )}
          <GroupDetails
            key={group.id}
            group={group}
            userId={session.user.id}
            membership={
              chat.capabilities.includes("group-membership-v1")
                ? chat.membership
                : undefined
            }
            onLeave={closeModal}
            muted={mutedChats.includes(group.id)}
            onMute={() => {
              try {
                const preferences = readNotificationPreferences(session),
                  next = preferences.muted.includes(group.id)
                    ? preferences.muted.filter((id) => id !== group.id)
                    : [...preferences.muted, group.id];
                saveNotificationPreferences(session, {
                  ...preferences,
                  muted: next,
                });
                setMutedChats(next);
              } catch {
                notify(
                  "Could not save notification settings. Please try again.",
                );
              }
            }}
            online={chat.connection === "connected"}
            rename={(name) => chat.renameGroup(group.id, name)}
          />
        </Modal>
      )}
      {modal === "settings" && (
        <Modal title="Settings" onClose={closeModal}>
          {chat.capabilities.includes("avatars-v1") && (
            <AvatarEditor
              session={session}
              target="profile"
              current={self}
              online={chat.connection === "connected"}
              onSaved={async (info) => {
                await onSession({
                  ...session,
                  user: { id: self.id, name: self.name, ...info },
                });
              }}
              onBusy={setAvatarBusy}
            />
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const user = await api<Person>(session, "/api/profile", {
                  method: "POST",
                  body: JSON.stringify({ name: profileName }),
                });
                await onSession({ ...session, user });
                notify("Your name has been updated.");
              });
            }}
          >
            <label htmlFor="profile-name">Your name</label>
            <div className="input-action">
              <input
                id="profile-name"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                maxLength={32}
                required
              />
              <button
                className="button secondary"
                disabled={busy || profileName.trim() === session.user.name}
              >
                Save
              </button>
            </div>
          </form>
          <div className="settings-block">
            <label htmlFor="appearance">Appearance</label>
            <select
              id="appearance"
              value={theme}
              onChange={(event) => onTheme(event.target.value as Theme)}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div className="settings-block">
            <label>Connected to</label>
            <div className="server-display">
              <span className="green-dot" />
              {session.server}
            </div>
            <p className="field-hint">
              Changing servers requires a separate sign-in.
            </p>
          </div>
          <button
            className="settings-row"
            onClick={() => {
              void call.refreshDevices();
              openSettingsSection("audio");
            }}
          >
            <Headphones size={18} />
            <span>Microphone & headphones</span>
            <ArrowRight size={15} />
          </button>
          <button
            className="settings-row"
            onClick={() => void exportHistory()}
            disabled={busy}
          >
            <Download size={18} />
            <span>Export your chat history</span>
            <ArrowRight size={15} />
          </button>
          {chat.capabilities.includes("identity-recovery") && (
            <button
              className="settings-row"
              onClick={() => openSettingsSection("identity")}
            >
              <ShieldCheck size={18} />
              <span>Recovery & devices</span>
              <ArrowRight size={15} />
            </button>
          )}
          <button
            className="settings-row"
            onClick={() => openSettingsSection("history")}
          >
            <Search size={18} />
            <span>History & archives</span>
            <ArrowRight size={15} />
          </button>
          <button
            className="settings-row"
            onClick={() => openSettingsSection("notifications")}
          >
            <Bell size={18} />
            <span>Notifications</span>
            <ArrowRight size={15} />
          </button>
          <button
            className="settings-row"
            onClick={() => openSettingsSection("sounds")}
          >
            <Volume2 size={18} />
            <span>Sounds</span>
            <ArrowRight size={15} />
          </button>
          <button
            className="settings-row"
            onClick={() => openSettingsSection("storage")}
          >
            <HardDrive size={18} />
            <span>Files on this device</span>
            <ArrowRight size={15} />
          </button>
          <div className="settings-footer">
            <span>Gather {version}</span>
            <button
              className="text-button danger-text"
              onClick={() =>
                void action(async () => {
                  await api(session, "/api/sign-out", { method: "POST" });
                  call.leave();
                  await onSession(null);
                })
              }
            >
              Sign out
            </button>
          </div>
          <UpdateSettings busy={updateBusy} />
          <p className="field-hint">
            Emoji artwork:{" "}
            <a href="https://github.com/EmojiTwo/emojitwo">EmojiTwo</a> · CC BY
            4.0
            {" · "}
            <a href="https://github.com/bernzrdo/msn-emoticons">Classic MSN</a>
          </p>
          <p className="field-hint">
            {chat.capabilities.includes("identity-recovery")
              ? "Save your recovery code before signing out."
              : "A new sign-in creates a new profile."}
          </p>
          {formError && <p className="form-error">{formError}</p>}
        </Modal>
      )}
      {modal === "identity" && (
        <Modal
          title="Recovery & devices"
          onClose={closeModal}
          onBack={settingsParent ? backToSettings : undefined}
        >
          <IdentitySettings session={session} />
        </Modal>
      )}
      {modal === "notifications" && (
        <Modal
          title="Notifications"
          onClose={closeModal}
          onBack={settingsParent ? backToSettings : undefined}
        >
          <NotificationSettings session={session} groups={chat.groups} />
        </Modal>
      )}
      {modal === "sounds" && (
        <Modal
          title="Sounds"
          onClose={closeModal}
          onBack={settingsParent ? backToSettings : undefined}
        >
          <SoundSettings />
        </Modal>
      )}
      {modal === "history" && (
        <Modal
          title="History & archives"
          onClose={closeModal}
          onBack={settingsParent ? backToSettings : undefined}
          wide
        >
          <HistoryTools
            session={session}
            initialGroup={group?.id}
            onOpenMessage={(groupId, id) => jumpHandler.current(groupId, id)}
          />
        </Modal>
      )}
      {modal === "storage" && (
        <Modal
          title="Files on this device"
          onClose={closeModal}
          onBack={settingsParent ? backToSettings : undefined}
        >
          <StorageSettings session={session} />
        </Modal>
      )}
      {modal === "audio" && (
        <Modal
          title="Audio settings"
          onClose={closeModal}
          onBack={settingsParent ? backToSettings : undefined}
        >
          <label htmlFor="microphone">
            <Mic size={14} /> Microphone
          </label>
          <select
            id="microphone"
            value={call.input}
            onChange={(e) =>
              void call.changeDevice("audioinput", e.target.value)
            }
          >
            <option value="default">System default microphone</option>
            {call.devices
              .filter(
                (d) => d.kind === "audioinput" && d.deviceId !== "default",
              )
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
          </select>
          <label htmlFor="speaker">
            <Headphones size={14} /> Headphones / speakers
          </label>
          <select
            id="speaker"
            value={call.output}
            disabled={
              typeof HTMLMediaElement.prototype.setSinkId !== "function"
            }
            onChange={(e) =>
              void call.changeDevice("audiooutput", e.target.value)
            }
          >
            <option value="default">System default output</option>
            {call.devices
              .filter(
                (d) => d.kind === "audiooutput" && d.deviceId !== "default",
              )
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Output ${i + 1}`}
                </option>
              ))}
          </select>
          {typeof HTMLMediaElement.prototype.setSinkId !== "function" && (
            <p className="field-hint">
              This browser uses your system default output.
            </p>
          )}
          <div className="audio-note">
            <ShieldCheck size={18} />
            <p>Echo cancellation and noise suppression enabled.</p>
          </div>
          {call.group && (
            <>
              <button
                className="button secondary full"
                onClick={call.enableSound}
              >
                <Volume2 size={16} /> Enable sound
              </button>
              <p className="field-hint">
                Audio route:{" "}
                {call.relay
                  ? "direct when possible, relay available"
                  : "direct only; the host has not configured a TURN relay"}
              </p>
            </>
          )}
          <p className="shortcut-note">
            {window.desktop ? (
              <>
                <kbd>
                  {window.desktop?.platform === "darwin" ? "Cmd" : "Ctrl"}
                </kbd>{" "}
                + <kbd>Shift</kbd> + <kbd>M</kbd> to mute while gaming.
                {call.group && !call.shortcut && (
                  <span>
                    {" "}
                    The shortcut is unavailable. Another app may have registered
                    it.
                  </span>
                )}
              </>
            ) : (
              "The global mute shortcut is available in the desktop app."
            )}
          </p>
        </Modal>
      )}
    </div>
  );
}
export default function App() {
  const appearance = useTheme();
  const [session, setSession] = useState<Session | null>();
  const current = useRef<Session | null>(null);
  const mutation = useRef(0);
  const pendingClear = useRef<string | null | undefined>(undefined);
  const [startupError, setStartupError] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  useEffect(() => {
    void window.desktop?.setUpdateBusy(updateBusy).catch(() => {});
  }, [updateBusy]);
  const changeSession = useCallback(
    async (next: Session | null, expectedToken: string | null) => {
      if (
        (current.current?.token ?? null) !== expectedToken &&
        !(next === null && pendingClear.current === expectedToken)
      )
        throw new Error("Your profile changed. Try again.");
      const attempt = ++mutation.current;
      if (!next) {
        pendingClear.current = expectedToken;
        current.current = null;
        setStartupError("");
        // Unmount voice immediately, even if credential persistence later fails.
        setSession(undefined);
      }
      try {
        await saveSession(next, expectedToken);
        if (mutation.current !== attempt) return;
        current.current = next;
        pendingClear.current = undefined;
        setSession(next);
      } catch (failure) {
        if (!next && mutation.current === attempt)
          setStartupError(
            (failure as Error).message ||
              "Your sign-out could not be saved. Try again.",
          );
        throw failure;
      }
    },
    [],
  );
  const openProfile = useCallback(async () => {
    setStartupError("");
    try {
      if (pendingClear.current !== undefined)
        await changeSession(null, pendingClear.current);
      else {
        const saved = await loadSession();
        current.current = saved;
        setSession(saved);
      }
    } catch (failure) {
      setStartupError(
        (failure as Error).message ||
          "Your saved profile could not be opened. Try again.",
      );
    }
  }, [changeSession]);
  useEffect(() => {
    void openProfile();
  }, [openProfile]);
  useEffect(() => {
    const expired = (event: Event) => {
      const token = (event as CustomEvent).detail?.token;
      if (token === current.current?.token)
        void changeSession(null, token).catch(() => {});
    };
    window.addEventListener("gather:session-expired", expired);
    return () => window.removeEventListener("gather:session-expired", expired);
  }, [changeSession]);
  return (
    <div className="app">
      <Titlebar />
      <UpdateBanner busy={updateBusy} />
      {session === undefined ? (
        <div className="workspace-loading">
          <LoaderCircle className="spin" />
          <h2>
            {startupError ? "Couldn’t open your profile" : "Opening Gather…"}
          </h2>
          {startupError && (
            <>
              <p role="alert">{startupError}</p>
              <button
                className="button secondary"
                onClick={() => void openProfile()}
              >
                Try again
              </button>
            </>
          )}
        </div>
      ) : session ? (
        <AvatarProvider
          session={session}
          key={session.server + session.user.id}
        >
          <Workspace
            key={session.server + session.user.id}
            session={session}
            onSession={(next) => changeSession(next, session.token)}
            theme={appearance.theme}
            onTheme={appearance.setTheme}
            onUpdateBusy={setUpdateBusy}
          />
        </AvatarProvider>
      ) : (
        <Onboarding onSession={(next) => changeSession(next, null)} />
      )}
    </div>
  );
}
