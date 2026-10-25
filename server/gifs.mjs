import { gifUrl } from "./gif-policy.mjs";
const API = "https://api.klipy.com/api/v1";
const SIZES = ["md", "hd", "sm", "xs"];
const PREVIEW_SIZES = ["sm", "xs", "md"];
// Klipy nests media as files[size][format] = { url, width, height }. Be
// forgiving about the exact nesting so a small provider change degrades to
// "no result" instead of a crash.
function media(files, sizes, formats) {
  if (!files || typeof files !== "object") return null;
  for (const size of sizes)
    for (const format of formats) {
      const entry = files[size]?.[format] ?? files[format]?.[size];
      const url = gifUrl(typeof entry === "string" ? entry : entry?.url);
      if (url)
        return {
          url,
          width: Number.isFinite(entry?.width) ? entry.width : 0,
          height: Number.isFinite(entry?.height) ? entry.height : 0,
        };
    }
  return null;
}
export function normalizeGifs(payload) {
  const rows = payload?.data?.data;
  if (!Array.isArray(rows)) return { results: [], hasNext: false };
  const results = [];
  for (const row of rows) {
    const full = media(row?.file ?? row?.files, SIZES, ["gif"]);
    const preview = media(row?.file ?? row?.files, PREVIEW_SIZES, [
      "gif",
      "webp",
    ]);
    if (!full || !preview) continue;
    results.push({
      id: String(row.id ?? row.slug ?? full.url).slice(0, 100),
      title: String(row.title ?? "").slice(0, 120),
      url: full.url,
      preview: preview.url,
      width: preview.width,
      height: preview.height,
    });
  }
  return { results, hasNext: payload.data.has_next === true };
}
export function createGifService(env = {}, fetcher = globalThis.fetch) {
  const hits = new Map();
  const limited = (userId) => {
    const slot = Math.floor(Date.now() / 60_000),
      entry = hits.get(userId);
    if (!entry || entry.slot !== slot) {
      if (hits.size > 500) hits.clear();
      hits.set(userId, { slot, count: 1 });
      return false;
    }
    return ++entry.count > 40;
  };
  return {
    available: () => Boolean(env.KLIPY_API_KEY),
    async request(userId, mode, query) {
      const fail = (status, message) =>
        Object.assign(new Error(message), { status });
      if (!env.KLIPY_API_KEY) throw fail(503, "GIF search isn’t set up here.");
      if (limited(userId))
        throw fail(429, "Too many GIF searches. Try again in a minute.");
      const q = String(query.get("q") ?? "")
        .trim()
        .slice(0, 80);
      const page = Math.min(
        50,
        Math.max(1, Number.parseInt(query.get("page") ?? "1", 10) || 1),
      );
      if (mode === "search" && !q) return { results: [], hasNext: false };
      const url = new URL(
        `${API}/${encodeURIComponent(env.KLIPY_API_KEY)}/gifs/${mode}`,
      );
      url.searchParams.set("per_page", "24");
      url.searchParams.set("page", String(page));
      url.searchParams.set("rating", "pg-13");
      url.searchParams.set("customer_id", String(userId).slice(0, 64));
      if (mode === "search") url.searchParams.set("q", q);
      let response;
      try {
        response = await fetcher(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(6000),
        });
      } catch {
        throw fail(502, "GIF search didn’t answer. Try again.");
      }
      if (!response.ok) throw fail(502, "GIF search is unavailable right now.");
      return normalizeGifs(await response.json().catch(() => null));
    },
  };
}
