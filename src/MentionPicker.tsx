import type { Person } from "./types";

export type MentionTrigger = { start: number; query: string };
/** Finds an "@name" being typed just before the caret. */
export function mentionTrigger(
  text: string,
  caret: number,
): MentionTrigger | null {
  const match = /(^|\s)@([^\s@]{0,32})$/u.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}
export function mentionChoices(
  members: Person[],
  selfId: string,
  query: string,
) {
  const needle = query.toLowerCase();
  const names = [
    ...members.filter((p) => p.id !== selfId).map((p) => p.name),
    ...(members.length > 2 ? ["everyone"] : []),
  ];
  return names
    .filter((name) => name.toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        Number(b.toLowerCase().startsWith(needle)) -
        Number(a.toLowerCase().startsWith(needle)),
    )
    .slice(0, 6);
}
export function MentionPicker({
  choices,
  index,
  onPick,
  onHover,
}: {
  choices: string[];
  index: number;
  onPick: (name: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="mention-picker" role="listbox" aria-label="Mention someone">
      {choices.map((name, i) => (
        <button
          type="button"
          key={name}
          role="option"
          aria-selected={i === index}
          className={i === index ? "active" : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(name)}
        >
          <span className="mention-at">@</span>
          {name}
          {name === "everyone" && <small>Notify the whole chat</small>}
        </button>
      ))}
    </div>
  );
}
