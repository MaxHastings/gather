import { isMsnToken } from "./msn-policy.mjs";
export function isReactionEmoji(value) {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  if (isMsnToken(value)) return true;
  return (
    [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        value,
      ),
    ].length === 1 &&
    /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)
  );
}
