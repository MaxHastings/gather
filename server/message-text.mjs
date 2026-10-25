// A small non-HTML grammar. Source is preserved; unmatched punctuation stays text.
export function inlineText(source) {
  const pattern =
    /`([^`\n]+)`|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*|https?:\/\/[^\s<>]+/g;
  const result = [];
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last)
      result.push({ type: "text", value: source.slice(last, match.index) });
    const [raw, code, bold, strike, italic] = match;
    if (code !== undefined) result.push({ type: "code", value: code });
    else if (bold !== undefined) result.push({ type: "bold", value: bold });
    else if (strike !== undefined)
      result.push({ type: "strike", value: strike });
    else if (italic !== undefined)
      result.push({ type: "italic", value: italic });
    else {
      let value = raw;
      let suffix = "";
      while (
        /[.,!?;:]$/.test(value) ||
        (value.endsWith(")") &&
          (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0))
      ) {
        suffix = value.at(-1) + suffix;
        value = value.slice(0, -1);
      }
      let safe = false;
      try {
        const url = new URL(value);
        safe =
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password;
      } catch {}
      result.push({ type: safe ? "link" : "text", value });
      if (suffix) result.push({ type: "text", value: suffix });
    }
    last = match.index + raw.length;
  }
  if (last < source.length)
    result.push({ type: "text", value: source.slice(last) });
  return result;
}
export function messageText(source) {
  const result = [];
  let last = 0;
  for (const match of source.matchAll(
    /```(?:[a-zA-Z0-9_+-]*\n)?([\s\S]*?)```/g,
  )) {
    if (match.index > last)
      result.push({ type: "inline", value: source.slice(last, match.index) });
    result.push({ type: "block", value: match[1] });
    last = match.index + match[0].length;
  }
  if (last < source.length)
    result.push({ type: "inline", value: source.slice(last) });
  return result;
}
