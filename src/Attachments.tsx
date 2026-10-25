import { useEffect, useRef, useState, useCallback } from "react";
import { MediaViewer } from "./MediaViewer";
import { Download, File, LoaderCircle, RotateCw, Pin } from "lucide-react";
import type { Attachment, Session } from "./types";
import { loadMedia, cacheMedia } from "./media";
import { historyScope } from "./history";
import type { MediaEntry } from "../server/media-contract.mjs";

export function AttachmentView({
  session,
  attachment,
  scope,
  remote = true,
  messageKey,
  fallbackScope,
}: {
  session: Session;
  attachment: Attachment;
  scope?: string;
  remote?: boolean;
  messageKey?: string;
  fallbackScope?: string;
}) {
  const [viewing, setViewing] = useState(false);
  const closeViewer = useCallback(() => setViewing(false), []);
  const box = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const position = useRef(0);
  const [warm, setWarm] = useState(false);
  const [visible, setVisible] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const [animate, setAnimate] = useState(
    () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [poster, setPoster] = useState("");
  const [kept, setKept] = useState(false),
    [keeping, setKeeping] = useState(false),
    [actionError, setActionError] = useState("");
  const cacheScope = scope ?? historyScope(session);
  useEffect(() => {
    if (!visible) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          void cacheMedia<MediaEntry | null>({
            operation: "entry",
            scope: cacheScope,
            id: attachment.id,
          })
            .then((entry) => {
              if (active) setKept(Boolean(entry?.kept));
            })
            .catch(() => {}),
        80,
      );
    };
    refresh();
    window.addEventListener("gather:media-changed", refresh);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("gather:media-changed", refresh);
    };
  }, [cacheScope, attachment.id, visible]);
  const gif = attachment.type === "image/gif";
  const generic = attachment.type === "application/octet-stream";
  useEffect(() => {
    if (visible || viewing) {
      setWarm(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const release = () => {
      const media = box.current?.querySelector(
        "audio,video",
      ) as HTMLMediaElement | null;
      if (media && !media.paused && !media.ended)
        timer = setTimeout(release, 5000);
      else setWarm(false);
    };
    timer = setTimeout(release, 5000);
    return () => clearTimeout(timer);
  }, [visible, viewing]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[0].isIntersecting),
      { rootMargin: "150px" },
    );
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!warm || (gif && !animate) || generic) return;
    let active = true,
      objectUrl = "";
    const controller = new AbortController();
    setError("");
    loadMedia(
      session,
      attachment,
      controller.signal,
      scope,
      remote,
      messageKey,
      fallbackScope,
    )
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((failure) => {
        if (active)
          setError(
            ["AbortError", "TimeoutError"].includes(failure.name)
              ? "This file took too long to load. Try again."
              : failure.message || "This file could not be loaded.",
          );
      });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl("");
    };
  }, [
    session.server,
    session.user.id,
    session.token,
    attachment.id,
    attachment.sha256,
    warm,
    attempt,
    animate,
    gif,
    scope,
    remote,
    generic,
    messageKey,
    fallbackScope,
  ]);
  useEffect(() => {
    if (!url || attachment.type !== "video/mp4") return;
    const timer = setTimeout(() => {
      if (player.current && player.current.readyState < 2)
        setError(
          "This video could not start. Retry or save the original to open it in another player.",
        );
    }, 15000);
    return () => clearTimeout(timer);
  }, [url, attachment.type]);
  return (
    <div ref={box} className="attachment" data-attachment-id={attachment.id}>
      {generic ? (
        <div className="attachment-file-icon">
          <File size={28} />
        </div>
      ) : gif && !animate ? (
        <button
          className="attachment-placeholder"
          onClick={() => setAnimate(true)}
        >
          {poster && <img src={poster} alt="" />}
          Play GIF
        </button>
      ) : error ? (
        <div className="attachment-placeholder" role="status">
          <span>{error}</span>
          <button onClick={() => setAttempt((n) => n + 1)}>
            <RotateCw size={15} /> Retry
          </button>
        </div>
      ) : url ? (
        attachment.type.startsWith("audio/") ? (
          <audio
            src={url}
            controls
            preload="metadata"
            onError={() =>
              setError(
                "This audio cannot play here. Save the original to open it in another player.",
              )
            }
          />
        ) : attachment.type === "video/mp4" ? (
          <video
            ref={player}
            src={url}
            controls
            preload="auto"
            poster={poster || undefined}
            onTimeUpdate={(event) => {
              position.current = event.currentTarget.currentTime;
            }}
            onLoadedMetadata={(event) => {
              if (position.current > 0)
                event.currentTarget.currentTime = Math.min(
                  position.current,
                  event.currentTarget.duration || position.current,
                );
            }}
            onLoadedData={(event) => {
              if (poster) return;
              try {
                const video = event.currentTarget,
                  canvas = document.createElement("canvas");
                canvas.width = Math.min(340, video.videoWidth);
                canvas.height = Math.round(
                  (video.videoHeight * canvas.width) / video.videoWidth,
                );
                canvas
                  .getContext("2d")
                  ?.drawImage(video, 0, 0, canvas.width, canvas.height);
                setPoster(canvas.toDataURL("image/png"));
              } catch {}
            }}
            playsInline
            onError={() =>
              setError(
                "This video cannot play here. Save the original to open it in another player.",
              )
            }
          />
        ) : (
          <button
            className="attachment-image"
            aria-label={`View ${attachment.name}`}
            onClick={() => setViewing(true)}
          >
            <img
              src={url}
              alt={attachment.name}
              loading="lazy"
              onLoad={(e) => {
                if (gif && !poster) {
                  try {
                    const image = e.currentTarget,
                      canvas = document.createElement("canvas");
                    canvas.width = Math.min(340, image.naturalWidth);
                    canvas.height = Math.round(
                      (image.naturalHeight * canvas.width) / image.naturalWidth,
                    );
                    canvas
                      .getContext("2d")
                      ?.drawImage(image, 0, 0, canvas.width, canvas.height);
                    setPoster(canvas.toDataURL("image/png"));
                  } catch {}
                }
              }}
              onError={() =>
                setError(
                  "This image cannot display here. Save the original to open it elsewhere.",
                )
              }
            />
          </button>
        )
      ) : (
        <div className="attachment-placeholder">
          {poster ? (
            <img src={poster} alt="" />
          ) : warm ? (
            <LoaderCircle className="spin" size={20} />
          ) : (
            <span>{attachment.type === "video/mp4" ? "Video" : "File"}</span>
          )}
        </div>
      )}
      {viewing && url && (
        <MediaViewer url={url} name={attachment.name} onClose={closeViewer} />
      )}
      <div className="attachment-caption">
        <span title={attachment.name}>
          {attachment.name}
          <small>
            {attachment.bytes >= 1_000_000
              ? `${(attachment.bytes / 1_000_000).toFixed(1)} MB`
              : attachment.bytes >= 1000
                ? `${Math.ceil(attachment.bytes / 1000)} KB`
                : `${attachment.bytes} B`}
          </small>
        </span>
        {url ? (
          <a
            href={url}
            download={attachment.name}
            className="icon-button"
            aria-label={`Save ${attachment.name}`}
          >
            <Download size={17} />
          </a>
        ) : (
          <button
            className="icon-button"
            aria-label={`Save ${attachment.name}`}
            onClick={async () => {
              try {
                const blob = await loadMedia(
                  session,
                  attachment,
                  undefined,
                  scope,
                  remote,
                  messageKey,
                  fallbackScope,
                );
                const href = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = href;
                link.download = attachment.name;
                link.click();
                setTimeout(() => URL.revokeObjectURL(href), 30000);
              } catch (failure) {
                setActionError(
                  failure instanceof Error
                    ? failure.message
                    : "Download failed.",
                );
              }
            }}
          >
            <Download size={17} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label={`${kept ? "Stop keeping" : "Keep"} ${attachment.name} on this device`}
          aria-pressed={kept}
          title={kept ? "Kept on this device" : "Keep on this device"}
          disabled={keeping}
          onClick={async () => {
            setKeeping(true);
            setActionError("");
            try {
              if (!kept) {
                if (url) {
                  const blob = await fetch(url).then((r) => r.blob());
                  await cacheMedia({
                    operation: "put",
                    scope: cacheScope,
                    ...attachment,
                    data: new Uint8Array(await blob.arrayBuffer()),
                    pinned: false,
                    messageKey,
                  });
                } else
                  await loadMedia(
                    session,
                    attachment,
                    undefined,
                    scope,
                    remote,
                    messageKey,
                    fallbackScope,
                  );
              }
              await cacheMedia({
                operation: "keep",
                scope: cacheScope,
                id: attachment.id,
                active: !kept,
              });
              setKept(!kept);
            } catch (failure) {
              setActionError(
                (failure as Error).message ||
                  "This file could not be kept. Try saving the original to a folder.",
              );
            } finally {
              setKeeping(false);
            }
          }}
        >
          {keeping ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Pin size={16} fill={kept ? "currentColor" : "none"} />
          )}
        </button>
        {gif && animate && (
          <button className="text-button" onClick={() => setAnimate(false)}>
            Pause GIF
          </button>
        )}
      </div>
      {actionError && (
        <p className="attachment-action-error" role="alert">
          {actionError}
        </p>
      )}
    </div>
  );
}
