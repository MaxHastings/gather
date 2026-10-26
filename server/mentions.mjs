// @name mentions. Names can hold spaces, so match known member names instead
// of guessing where a word ends. "@everyone" and "@here" reach the whole chat.
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const boundary = "(^|[^\\p{L}\\p{N}_@])";
const tail = "(?![\\p{L}\\p{N}_])";

function pattern(names) {
  const words = [
    ...new Set(
      [...names, "everyone", "here"]
        .map((name) => String(name).trim())
        .filter(Boolean),
    ),
  ].sort((a, b) => b.length - a.length);
  return new RegExp(
    `${boundary}@(${words.map(escape).join("|")})${tail}`,
    "giu",
  );
}

export function mentionsUser(body, name) {
  if (typeof body !== "string" || !body.includes("@")) return false;
  const wanted = String(name).trim().toLowerCase();
  for (const match of body.matchAll(pattern([name]))) {
    const word = match[2].toLowerCase();
    if (word === wanted || word === "everyone" || word === "here") return true;
  }
  return false;
}

// Splits plain text into text and mention pieces for rendering.
export function splitMentions(text, names) {
  if (!text.includes("@")) return [{ type: "text", value: text }];
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(pattern(names))) {
    const start = match.index + match[1].length;
    if (start > last)
      parts.push({ type: "text", value: text.slice(last, start) });
    parts.push({ type: "mention", value: `@${match[2]}`, name: match[2] });
    last = start + match[2].length + 1;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}
