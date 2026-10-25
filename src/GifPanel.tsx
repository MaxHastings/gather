import { useEffect, useRef, useState } from "react";
export type Gif = {
  id: string;
  title: string;
  url: string;
  preview: string;
  width: number;
  height: number;
};
export type GifSearch = (
  query: string,
  page: number,
  signal: AbortSignal,
) => Promise<{ results: Gif[]; hasNext: boolean }>;
export function GifPanel({
  search,
  onPick,
}: {
  search: GifSearch;
  onPick: (url: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [term, setTerm] = useState(""),
    [gifs, setGifs] = useState<Gif[]>([]),
    [page, setPage] = useState(1),
    [hasNext, setHasNext] = useState(false),
    [state, setState] = useState<"loading" | "ready" | "error">("loading"),
    [error, setError] = useState("");
  const sentinel = useRef<HTMLDivElement>(null),
    scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setGifs([]);
    setPage(1);
    setHasNext(false);
    setState("loading");
    scroller.current?.scrollTo({ top: 0 });
  }, [term]);
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    search(term, page, controller.signal)
      .then((data) => {
        setGifs((current) => {
          const seen = new Set(current.map((g) => g.id));
          return page === 1
            ? data.results
            : [...current, ...data.results.filter((g) => !seen.has(g.id))];
        });
        setHasNext(data.hasNext);
        setState("ready");
      })
      .catch((failure: Error) => {
        if (controller.signal.aborted) return;
        setError(failure.message);
        setState("error");
      });
    return () => controller.abort();
  }, [term, page, search]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNext || state !== "ready") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setPage((current) => current + 1);
      },
      { root: scroller.current, rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNext, state, gifs.length]);
  const columns: Gif[][] = [[], []],
    heights = [0, 0];
  for (const gif of gifs) {
    const shorter = heights[0] <= heights[1] ? 0 : 1;
    columns[shorter].push(gif);
    heights[shorter] += gif.width > 0 ? gif.height / gif.width : 1;
  }
  return (
    <div className="gif-panel">
      <input
        aria-label="Search GIFs"
        placeholder="Search GIFs…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div ref={scroller} className="gif-grid" aria-busy={state === "loading"}>
        {columns.map((column, i) => (
          <div key={i} className="gif-column">
            {column.map((gif) => (
              <button
                type="button"
                key={gif.id}
                className="gif-tile"
                aria-label={`Send GIF${gif.title ? `: ${gif.title}` : ""}`}
                onClick={() => onPick(gif.url)}
              >
                <img
                  src={gif.preview}
                  alt={gif.title}
                  loading="lazy"
                  width={gif.width || undefined}
                  height={gif.height || undefined}
                  draggable={false}
                />
              </button>
            ))}
          </div>
        ))}
        <div ref={sentinel} className="gif-sentinel" />
      </div>
      <div className="emoticon-footer" role="status">
        {state === "loading" && !gifs.length ? (
          <span>Loading…</span>
        ) : state === "error" ? (
          <span>{error}</span>
        ) : !gifs.length ? (
          <span>No GIFs found</span>
        ) : (
          <span>{term ? `Results for “${term}”` : "Trending"}</span>
        )}
        <small>Powered by KLIPY</small>
      </div>
    </div>
  );
}
