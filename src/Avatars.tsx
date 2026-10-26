import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Camera } from "lucide-react";
import type { AvatarInfo, Person, Session } from "./types";
import { api } from "./api";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const AvatarContext = createContext<((id: string) => Promise<string>) | null>(
  null,
);
export function AvatarProvider({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  const cache = useMemo(() => {
    let controller = new AbortController();
    const values = new Map<string, Promise<string>>(),
      urls = new Set<string>();
    return {
      close() {
        controller.abort();
        for (const url of urls) URL.revokeObjectURL(url);
        urls.clear();
        values.clear();
      },
      async load(id: string) {
        if (controller.signal.aborted) controller = new AbortController();
        const epoch = controller;
        if (!uuid.test(id)) throw new Error("Invalid picture.");
        if (!values.has(id)) {
          if (values.size >= 128) throw new Error("Picture cache is full.");
          const pending = (async () => {
            const response = await fetch(
              `${session.server}/api/avatars/${id}/content`,
              {
                headers: { Authorization: `Bearer ${session.token}` },
                signal: AbortSignal.any([
                  epoch.signal,
                  AbortSignal.timeout(12000),
                ]),
                cache: "no-store",
              },
            );
            if (
              !response.ok ||
              response.headers.get("Content-Type") !== "image/png"
            )
              throw new Error("Picture unavailable.");
            const blob = await response.blob();
            if (blob.size > 300_000 || epoch.signal.aborted)
              throw new Error("Picture unavailable.");
            const url = URL.createObjectURL(blob);
            urls.add(url);
            return url;
          })();
          values.set(id, pending);
          pending.catch(() => {
            if (values.get(id) === pending) values.delete(id);
          });
        }
        return values.get(id)!;
      },
    };
  }, [session.server, session.token]);
  useEffect(() => () => cache.close(), [cache]);
  return (
    <AvatarContext.Provider value={cache.load}>
      {children}
    </AvatarContext.Provider>
  );
}
const initials = (name: string) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
export function Avatar({
  person,
  size = "",
  online = false,
  away = false,
}: {
  person: Person;
  size?: string;
  online?: boolean;
  away?: boolean;
}) {
  const color = [...person.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 5;
  return (
    <span className={`avatar color-${color} ${size}`}>
      {initials(person.name)}
      <AvatarImage id={person.avatarId} />
      {online && <i className={away ? "online-dot away" : "online-dot"} />}
    </span>
  );
}
export function AvatarImage({ id }: { id?: string }) {
  const load = useContext(AvatarContext),
    [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    if (id && load)
      void load(id)
        .then((url) => {
          if (live) setSrc(url);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, load]);
  return src ? (
    <img
      className="avatar-image"
      src={src}
      alt=""
      draggable={false}
      onError={() => setSrc(undefined)}
    />
  ) : null;
}
type Candidate = { id: string; blob: Blob; url: string; baseRevision: number };
export function AvatarEditor({
  session,
  target,
  current,
  online,
  onSaved,
  onBusy,
}: {
  session: Session;
  target: "profile" | string;
  current: AvatarInfo;
  online: boolean;
  onSaved: (value: AvatarInfo) => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [candidate, setCandidate] = useState<Candidate>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    live = useRef(true),
    controller = useRef<AbortController | undefined>(undefined);
  const endpoint =
    target === "profile"
      ? "/api/profile/avatar"
      : `/api/groups/${target}/avatar`;
  const label = target === "profile" ? "Profile picture" : "Group picture";
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
      controller.current?.abort();
      onBusy(false);
    };
  }, [onBusy]);
  useEffect(
    () => () => {
      if (candidate) URL.revokeObjectURL(candidate.url);
    },
    [candidate],
  );
  const select = async (file?: File) => {
    if (!file) return;
    const revision = ++generation.current;
    setError("");
    setBusy(true);
    onBusy(true);
    try {
      if (
        !file.size ||
        file.size > 10_000_000 ||
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          file.type,
        )
      )
        throw new Error("Choose a PNG, JPEG, WebP or GIF under 10 MB.");
      const image = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      let blob: Blob;
      try {
        if (
          !image.width ||
          !image.height ||
          image.width * image.height > 40_000_000
        )
          throw new Error("Choose a smaller image.");
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not prepare this picture.");
        const side = Math.min(image.width, image.height);
        context.drawImage(
          image,
          (image.width - side) / 2,
          (image.height - side) / 2,
          side,
          side,
          0,
          0,
          256,
          256,
        );
        blob = await new Promise<Blob>((yes, no) =>
          canvas.toBlob(
            (value) =>
              value
                ? yes(value)
                : no(new Error("Could not prepare this picture.")),
            "image/png",
          ),
        );
      } finally {
        image.close();
      }
      if (blob.size > 300_000) throw new Error("Choose a simpler image.");
      if (live.current && revision === generation.current)
        setCandidate({
          id: crypto.randomUUID(),
          blob,
          url: URL.createObjectURL(blob),
          baseRevision: current.avatarRevision ?? 0,
        });
    } catch (failure) {
      if (live.current) setError((failure as Error).message);
    } finally {
      if (live.current) setBusy(false);
      onBusy(false);
    }
  };
  const save = async (remove = false) => {
    setError("");
    setBusy(true);
    onBusy(true);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const value = remove
        ? await api<AvatarInfo>(session, endpoint + "/remove", {
            method: "POST",
            body: JSON.stringify({ baseRevision: current.avatarRevision ?? 0 }),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
          })
        : await api<AvatarInfo>(
            session,
            `${endpoint}/content?id=${candidate!.id}&revision=${candidate!.baseRevision}`,
            {
              method: "PUT",
              headers: { "Content-Type": "image/png" },
              body: candidate!.blob,
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(20000),
              ]),
            },
          );
      if (!live.current) return;
      await onSaved(value);
      setCandidate(undefined);
    } catch (failure) {
      if (live.current && !abort.signal.aborted)
        setError((failure as Error).message);
    } finally {
      if (live.current) setBusy(false);
      onBusy(false);
    }
  };
  return (
    <section className="avatar-editor" aria-label={label}>
      <span className="avatar-preview" aria-label={`${label} preview`}>
        <Camera size={24} />
        {candidate ? (
          <img src={candidate.url} alt="Selected picture" />
        ) : (
          <AvatarImage id={current.avatarId} />
        )}
      </span>
      <div className="avatar-editor-actions">
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          aria-label={`Upload ${label.toLowerCase()}`}
          hidden
          onChange={(event) => {
            void select(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <button
          className="button secondary"
          disabled={busy || !online}
          onClick={() => picker.current?.click()}
        >
          <Camera size={16} />
          {current.avatarId ? "Change picture" : "Add picture"}
        </button>
        {candidate ? (
          <>
            <button
              className="button primary"
              disabled={busy || !online}
              onClick={() => void save()}
            >
              Save picture
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setCandidate(undefined)}
            >
              Cancel
            </button>
          </>
        ) : (
          current.avatarId && (
            <button
              className="text-button"
              disabled={busy || !online}
              onClick={() => void save(true)}
            >
              Remove picture
            </button>
          )
        )}
        {busy && (
          <span className="field-hint" role="status">
            Saving picture…
          </span>
        )}
        {candidate && (
          <span className="field-hint">
            Square crop · GIFs use a still frame.
          </span>
        )}
        {!online && (
          <span className="field-hint">Reconnect to change the picture.</span>
        )}
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
