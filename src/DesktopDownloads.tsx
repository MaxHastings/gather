import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import {
  readDesktopReleases,
  type DesktopRelease,
} from "../server/desktop-releases.mjs";

export function DesktopDownloads({ onDownload }: { onDownload: () => void }) {
  const [releases, setReleases] = useState<DesktopRelease[]>([]);
  const platform = /Windows/i.test(navigator.userAgent)
    ? "win32"
    : /Macintosh|Mac OS X/i.test(navigator.userAgent)
      ? "darwin"
      : /Linux/i.test(navigator.userAgent) &&
          !/Android/i.test(navigator.userAgent)
        ? "linux"
        : "";
  useEffect(() => {
    const controller = new AbortController();
    fetch("/downloads/releases.json", {
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return readDesktopReleases(await response.json());
      })
      .then(setReleases)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const native = releases.filter((entry) => entry.platform === platform),
    others = releases.filter((entry) => entry.platform !== platform);
  const link = (entry: DesktopRelease) => (
    <a
      key={entry.id}
      className="button secondary full"
      href={`/download/${entry.id === "windows-x64" ? "windows" : entry.id}?v=${entry.version}`}
      onClick={onDownload}
    >
      <Download size={16} /> Download for {entry.label}
      {entry.status === "preview" ? " (preview)" : ""}
    </a>
  );
  if (!releases.length) return null;
  const label = { darwin: "Mac", linux: "Linux" }[platform as string];
  return (
    <>
      {label && !native.length && (
        <p className="field-hint">
          The Gather desktop app isn’t available for {label} yet. Gather works
          fully in your browser, so you can just keep using this page.
        </p>
      )}
      {native.map(link)}
      {others.length > 0 && (
        <details className="other-downloads">
          <summary>
            {native.length
              ? "Other platforms"
              : label
                ? "Windows app"
                : "Desktop downloads"}
          </summary>
          {others.map(link)}
        </details>
      )}
      {native.some((entry) => entry.status === "preview") && (
        <p className="field-hint">
          Preview build · Desktop updates are still being tested.
          {platform === "darwin"
            ? " macOS may ask you to allow Gather in Privacy & Security."
            : ""}
        </p>
      )}
    </>
  );
}
