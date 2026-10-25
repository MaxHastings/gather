import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Download } from "lucide-react";
export function MediaViewer({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    root.current?.querySelector("button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const nodes = Array.from(
          root.current?.querySelectorAll<HTMLElement>("button,a[href]") ?? [],
        );
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      previous?.focus();
    };
  }, [onClose]);
  return createPortal(
    <div
      className="media-viewer"
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`View ${name}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="media-viewer-toolbar">
        <span>{name}</span>
        <a
          className="icon-button"
          href={url}
          download={name}
          aria-label={`Save ${name}`}
        >
          <Download />
        </a>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close image"
        >
          <X />
        </button>
      </div>
      <img src={url} alt={name} />
    </div>,
    document.body,
  );
}
