import { Fragment, memo } from "react";
import index from "./assets/emoji-index.json";
import atlasIndex from "./assets/emoji-atlas-index.json";
import { MsnEmoji, msnShortcuts } from "./MsnEmoji";
import { isMsnToken } from "../server/msn-policy.mjs";
const sheets = import.meta.glob<string>("./assets/emoji-atlas/*.png", {
  query: "?url",
  import: "default",
  eager: true,
});
const atlas = atlasIndex as Record<string, number[]>;
const available = new Set(Object.keys(index));
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function emojiCode(value: string) {
  if (!/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value))
    return null;
  const full = [...value]
    .map((char) => char.codePointAt(0)!.toString(16))
    .join("-");
  if (available.has(full)) return full;
  const minimal = full
    .split("-")
    .filter((point) => point !== "fe0f")
    .join("-");
  if (available.has(minimal)) return minimal;
  const legacy = minimal
    .split("-")
    .filter((point) => point !== "200d")
    .join("-");
  return available.has(legacy) ? legacy : null;
}
export function Emoji({ value }: { value: string }) {
  if (isMsnToken(value)) return <MsnEmoji token={value} />;
  const code = emojiCode(value);
  if (!code) return <span>{value}</span>;
  const [sheet, x, y] = atlas[code];
  return (
    <span
      className="emoji-art"
      role="img"
      aria-label={value}
      style={{
        backgroundImage: `url(${sheets[`./assets/emoji-atlas/${sheet}.png`]})`,
        backgroundSize: "800% 800%",
        backgroundPosition: `${(x / 7) * 100}% ${(y / 7) * 100}%`,
        backgroundRepeat: "no-repeat",
      }}
    />
  );
}

const tokenCache = new Map<string, string[]>();
function tokens(text: string): string[] {
  const cached = tokenCache.get(text);
  if (cached) return cached;
  const out: string[] = [];
  const add = (part: string) => {
    if (!part) return;
    const last = out.at(-1);
    if (
      last &&
      !isMsnToken(last) &&
      !emojiCode(last) &&
      !isMsnToken(part) &&
      !emojiCode(part)
    )
      out[out.length - 1] += part;
    else out.push(part);
  };
  for (const part of text.split(/(:msn-[a-z-]+:)/g).filter(Boolean)) {
    if (isMsnToken(part)) {
      out.push(part);
      continue;
    }
    for (const word of part.split(/(\s+)/)) {
      const shortcut = msnShortcuts.get(word);
      if (shortcut) {
        out.push(shortcut);
        continue;
      }
      if (
        !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(word)
      ) {
        add(word);
        continue;
      }
      for (const { segment } of segmenter.segment(word)) add(segment);
    }
  }
  if (tokenCache.size >= 512)
    tokenCache.delete(tokenCache.keys().next().value!);
  tokenCache.set(text, out);
  return out;
}
export function emojiOnlyCount(text: string) {
  if (text.length > 120) return 0;
  const parts = tokens(text.trim()).filter((part) => part.trim());
  return parts.length >= 1 &&
    parts.length <= 6 &&
    parts.every((part) => isMsnToken(part) || emojiCode(part))
    ? parts.length
    : 0;
}
export const EmojiText = memo(function EmojiText({ text }: { text: string }) {
  return (
    <>
      {tokens(text).map((segment, index) =>
        isMsnToken(segment) || emojiCode(segment) ? (
          <Emoji key={index} value={segment} />
        ) : (
          <Fragment key={index}>{segment}</Fragment>
        ),
      )}
    </>
  );
});
