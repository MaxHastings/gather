import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Emoji } from "./Emoji";
import { GifPanel, type GifSearch } from "./GifPanel";
import { msnEmoticons } from "./MsnEmoji";
import catalog from "./assets/emoji-catalog.json";
type Item = { value: string; name: string; hint: string };
type Section = { id: string; label: string; icon: string; items: Item[] };
type Row =
  | { type: "header"; label: string; top: number }
  | { type: "items"; items: Item[]; first: number; top: number };
const COLUMNS = 8,
  ROW = 36,
  HEADER = 26,
  VIEW = 252,
  OVERSCAN = 4;
const order = [
  ["people", "People", "😀"],
  ["nature", "Animals and nature", "🐶"],
  ["food", "Food and drink", "🍕"],
  ["activity", "Activities", "🎮"],
  ["travel", "Travel", "🚀"],
  ["objects", "Objects", "💡"],
  ["symbols", "Symbols", "❤️"],
  ["flags", "Flags", "🏁"],
  ["other", "More", "✨"],
] as const;
const popular = [
  "👋",
  "😊",
  "😂",
  "❤️",
  "👍",
  "🎮",
  "🎉",
  "👀",
  "🔥",
  "😮",
  "😢",
  "😎",
  "🤔",
  "😅",
  "🤣",
  "💀",
  "😭",
  "🙏",
  "👎",
  "💯",
  "🤷",
  "🤦",
  "🤝",
  "✨",
  "🤞",
  "🍕",
  "🍺",
  "☕",
  "💤",
  "🏆",
  "🚀",
];
const isTone = (name: string) => name.includes("skin tone");
const byValue = new Map(catalog.map((entry) => [entry.value, entry]));
const emojiItem = (entry: (typeof catalog)[number]): Item => ({
  value: entry.value,
  name: entry.name,
  hint: "",
});
const emojiSections: Section[] = order.map(([id, label, icon]) => ({
  id,
  label,
  icon,
  items: catalog
    .filter((entry) => entry.category === id && !isTone(entry.name))
    .map(emojiItem),
}));
const classicItems: Item[] = msnEmoticons.map((entry) => ({
  value: `:msn-${entry.id}:`,
  name: entry.name,
  hint: entry.shortcut,
}));
const classicSearch = new Map(
  msnEmoticons.map((entry) => [
    `:msn-${entry.id}:`,
    `${entry.name} ${entry.shortcut} ${entry.id}`.toLowerCase(),
  ]),
);
const emojiSearch = catalog
  .filter((entry) => entry.category !== "modifier")
  .map((entry) => ({
    item: emojiItem(entry),
    text: `${entry.value} ${entry.keywords}`.toLowerCase(),
  }));
function layout(sections: Section[]) {
  const rows: Row[] = [],
    anchors = new Map<string, number>();
  let top = 0,
    first = 0;
  for (const section of sections) {
    if (!section.items.length) continue;
    anchors.set(section.id, top);
    rows.push({ type: "header", label: section.label, top });
    top += HEADER;
    for (let i = 0; i < section.items.length; i += COLUMNS) {
      const items = section.items.slice(i, i + COLUMNS);
      rows.push({ type: "items", items, first, top });
      first += items.length;
      top += ROW;
    }
  }
  return { rows, anchors, height: top, count: first };
}
function readRecent(): string[] {
  try {
    const saved = JSON.parse(
      localStorage.getItem("gather.emoji.recent") || "[]",
    );
    return Array.isArray(saved)
      ? saved
          .filter(
            (v: unknown) =>
              typeof v === "string" && (byValue.has(v) || classicSearch.has(v)),
          )
          .slice(0, 24)
      : [];
  } catch {
    return [];
  }
}
export function EmoticonPicker({
  onSelect,
  onGif,
  gifSearch,
}: {
  onSelect: (value: string) => void;
  onGif?: (url: string) => void;
  gifSearch?: GifSearch;
}) {
  const [tab, setTab] = useState<"emoji" | "classic" | "gif">("emoji"),
    [search, setSearch] = useState(""),
    [recent, setRecent] = useState(readRecent),
    [scrollTop, setScrollTop] = useState(0),
    [active, setActive] = useState(0),
    [hovered, setHovered] = useState<Item | null>(null);
  const scroller = useRef<HTMLDivElement>(null),
    focusAfter = useRef(false);
  const filter = search.trim().toLowerCase();
  const sections = useMemo<Section[]>(() => {
    if (tab === "classic")
      return [
        {
          id: "classic",
          label: "Classic emoticons",
          icon: "",
          items: classicItems.filter(
            (item) =>
              !filter || classicSearch.get(item.value)!.includes(filter),
          ),
        },
      ];
    if (filter)
      return [
        {
          id: "results",
          label: "Results",
          icon: "",
          items: emojiSearch
            .filter((entry) => entry.text.includes(filter))
            .map((entry) => entry.item),
        },
      ];
    const head: Section = recent.length
      ? {
          id: "recent",
          label: "Recently used",
          icon: "🕘",
          items: recent.map((value) => ({
            value,
            name: byValue.get(value)?.name ?? classicSearch.get(value) ?? "",
            hint: "",
          })),
        }
      : {
          id: "popular",
          label: "Popular",
          icon: "⭐",
          items: popular
            .filter((value) => byValue.has(value))
            .map((value) => emojiItem(byValue.get(value)!)),
        };
    return [head, ...emojiSections];
  }, [tab, filter, recent]);
  const { rows, anchors, height, count } = useMemo(
    () => layout(sections),
    [sections],
  );
  const flat = useMemo(
    () => sections.flatMap((section) => section.items),
    [sections],
  );
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
    setActive(0);
  }, [tab, filter]);
  const visible = useMemo(() => {
    const from = scrollTop - OVERSCAN * ROW,
      to = scrollTop + VIEW + OVERSCAN * ROW;
    return rows.filter((row) => {
      const size = row.type === "header" ? HEADER : ROW;
      return row.top + size >= from && row.top <= to;
    });
  }, [rows, scrollTop]);
  const currentSection = useMemo(() => {
    let id = sections[0]?.id;
    for (const [key, top] of anchors) if (top <= scrollTop + 4) id = key;
    return id;
  }, [anchors, scrollTop, sections]);
  const ensureVisible = useCallback(
    (index: number) => {
      const row = rows.find(
        (r) =>
          r.type === "items" &&
          index >= r.first &&
          index < r.first + r.items.length,
      );
      const el = scroller.current;
      if (!row || !el) return;
      if (row.top < el.scrollTop + HEADER) el.scrollTop = row.top - HEADER;
      else if (row.top + ROW > el.scrollTop + VIEW)
        el.scrollTop = row.top + ROW - VIEW;
    },
    [rows],
  );
  useEffect(() => {
    if (!focusAfter.current) return;
    focusAfter.current = false;
    scroller.current
      ?.querySelector<HTMLButtonElement>(`[data-index="${active}"]`)
      ?.focus();
  }, [active, scrollTop]);
  const choose = (value: string) => {
    const next = [value, ...recent.filter((v) => v !== value)].slice(0, 24);
    setRecent(next);
    try {
      localStorage.setItem("gather.emoji.recent", JSON.stringify(next));
    } catch {}
    onSelect(value);
  };
  const move = (event: React.KeyboardEvent) => {
    const delta = (
      {
        ArrowRight: 1,
        ArrowLeft: -1,
        ArrowDown: COLUMNS,
        ArrowUp: -COLUMNS,
      } as Record<string, number>
    )[event.key];
    if (delta === undefined && event.key !== "Home" && event.key !== "End")
      return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? count - 1
          : Math.max(0, Math.min(count - 1, active + delta));
    ensureVisible(next);
    focusAfter.current = true;
    setActive(next);
  };
  const categories = sections.filter((s) => s.icon && s.items.length);
  const caption = hovered;
  return (
    <div className="emoticon-picker">
      <div role="tablist" aria-label="Emoticon sets">
        {(
          [
            ["emoji", "Emoji"],
            ["classic", "Classic MSN"],
            ...(gifSearch && onGif ? [["gif", "GIFs"]] : []),
          ] as [typeof tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id);
              setSearch("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "gif" && gifSearch && onGif ? (
        <GifPanel search={gifSearch} onPick={onGif} />
      ) : (
        <>
          <input
            aria-label={
              tab === "classic" ? "Find a classic emoticon" : "Find an emoji"
            }
            placeholder="Search…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {tab === "emoji" && !filter && (
            <div
              className="emoticon-categories"
              role="toolbar"
              aria-label="Emoji categories"
            >
              {categories.map((section) => (
                <button
                  type="button"
                  key={section.id}
                  title={section.label}
                  aria-label={section.label}
                  aria-pressed={currentSection === section.id}
                  onClick={() => {
                    if (scroller.current)
                      scroller.current.scrollTop = anchors.get(section.id) ?? 0;
                  }}
                >
                  <Emoji value={section.icon} />
                </button>
              ))}
            </div>
          )}
          <div
            ref={scroller}
            className="emoticon-grid"
            style={{ height: VIEW }}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            onKeyDown={move}
            role="tabpanel"
            aria-label={tab === "classic" ? "Classic MSN emoticons" : "Emoji"}
          >
            <div style={{ height, position: "relative" }}>
              {visible.map((row) =>
                row.type === "header" ? (
                  <div
                    key={`h${row.top}`}
                    className="emoticon-heading"
                    style={{ top: row.top, height: HEADER }}
                  >
                    {row.label}
                  </div>
                ) : (
                  <div
                    key={`r${row.top}`}
                    className="emoticon-row"
                    style={{ top: row.top, height: ROW }}
                  >
                    {row.items.map((item, i) => {
                      const index = row.first + i;
                      return (
                        <button
                          type="button"
                          key={`${item.value}${index}`}
                          data-index={index}
                          tabIndex={index === active ? 0 : -1}
                          onFocus={() => {
                            setActive(index);
                            setHovered(item);
                          }}
                          onBlur={() => setHovered(null)}
                          onMouseEnter={() => setHovered(item)}
                          onMouseLeave={() => setHovered(null)}
                          aria-label={`Insert ${item.value.startsWith(":msn-") ? item.name : item.value}`}
                          title={`${item.name}${item.hint ? ` · ${item.hint}` : ""}`}
                          onClick={() => choose(item.value)}
                        >
                          <Emoji value={item.value} />
                        </button>
                      );
                    })}
                  </div>
                ),
              )}
            </div>
          </div>
          <div className="emoticon-footer" role="status">
            {!count ? (
              <span>No matches</span>
            ) : caption ? (
              <span>
                <strong>{caption.name}</strong>
                {caption.hint && <code>{caption.hint}</code>}
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
