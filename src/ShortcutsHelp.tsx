const mac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = mac ? "⌘" : "Ctrl";
const rows: [string, string][] = [
  [`${mod} + K`, "Jump to a chat (search your chats)"],
  [mac ? "⌥ + ↑ / ↓" : "Alt + ↑ / ↓", "Previous or next chat"],
  ["↑ in an empty message box", "Edit your last message"],
  ["Enter", "Send"],
  ["Shift + Enter", "New line"],
  ["@", "Mention someone (↑ ↓ and Enter to pick)"],
  [`${mod} + /`, "Show this list"],
  ["Esc", "Close a window or panel"],
  [`${mod} + Shift + M`, "Mute or unmute your mic (desktop app, during a call)"],
];
export function ShortcutsHelp() {
  return (
    <dl className="shortcut-list">
      {rows.map(([keys, what]) => (
        <div key={keys}>
          <dt>
            <kbd>{keys}</kbd>
          </dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
  );
}
