import { useSyncExternalStore } from "react";
import entries from "./assets/msn-emoticons.json";
export const msnEmoticons = entries;
export const msnShortcuts = new Map(
  entries
    .filter((entry) => entry.shortcut)
    .map((entry) => [entry.shortcut, `:msn-${entry.id}:`]),
);
for (const [shortcut, id] of Object.entries({
  ":-)": "smile",
  ";-)": "winking-smile",
  ":-(": "sad-smile",
  ":-D": "open-mouthed-smile",
  ":-P": "smile-with-tongue-out",
  ":-p": "smile-with-tongue-out",
  ":p": "smile-with-tongue-out",
  ":d": "open-mouthed-smile",
  ":-d": "open-mouthed-smile",
  ";D": "winking-smile",
  ":o": "surprised-smile",
  ":O": "surprised-smile",
  ":-o": "surprised-smile",
  ":-S": "confused-smile",
  ":s": "confused-smile",
  ":-/": "confused-smile",
  ":-$": "embarrassed-smile",
  ":-@": "angry-smile",
  ">:(": "angry-smile",
  ":-|": "disappointed-smile",
  ":'-(": "crying-face",
  ":,(": "crying-face",
  "O:)": "angel",
  "O:-)": "angel",
  ">:)": "devil",
  "3:)": "devil",
  "8)": "eye-rolling-smile",
  "<3": "red-heart",
  "</3": "broken-heart",
  ":*": "secret-telling-smile",
}))
  msnShortcuts.set(shortcut, `:msn-${id}:`);
// Letter shortcuts such as (Y) and (brb) were case-insensitive in Messenger.
for (const [shortcut, token] of [...msnShortcuts])
  if (
    /^\([a-z0-9]+\)$/i.test(shortcut) &&
    !msnShortcuts.has(shortcut.toLowerCase())
  )
    msnShortcuts.set(shortcut.toLowerCase(), token);
const lookup = new Map(entries.map((entry) => [entry.id, entry]));
const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
export function useReducedMotion() {
  return useSyncExternalStore(
    (callback) => {
      motion.addEventListener("change", callback);
      return () => motion.removeEventListener("change", callback);
    },
    () => motion.matches,
  );
}
export function MsnEmoji({ token }: { token: string }) {
  const reduced = useReducedMotion(),
    entry = lookup.get(token.slice(5, -1));
  return entry ? (
    <img
      className="emoji-art msn-art"
      src={reduced ? entry.poster : entry.data}
      alt={entry.name}
      title={`${entry.name}${entry.shortcut ? ` · ${entry.shortcut}` : ""}`}
      draggable={false}
    />
  ) : (
    <span>{token}</span>
  );
}
