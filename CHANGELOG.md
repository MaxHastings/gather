# Changes

## Unreleased

- Retention policy: the server is a relay, not an archive. Files are removed from the server 30 days after upload (7 days for files of 25 MB or more); the message stays and the file shows as expired, and devices keep what they already received. At the 250 MB chat or person limit, the oldest sent files roll off instead of blocking uploads. Text is kept at least two years. Retention constants live in `server/media.mjs`.

## 0.4.0

- Add a landing page, honest Mac/Linux download messaging, Safari/iPhone basics and per-chat and per-person file quotas (250 MB each; existing files are never removed).
- Give phones a real list/chat layout, keep chat pinned to the latest message as images load, and name the chat on invite pages.
- Sound quality pass: bell and warmer voices, a shared soft low-pass, compressor and light echo, and per-event loudness trims measured by an offline render so every pack sits within about 1 dB.

- Replace emoji paging ("Show more") with one smoothly scrolling, virtualized picker: category bar, search across all emoji, recents, a name/shortcut footer and keyboard navigation.
- Add GIF search (trending, search and endless scroll) from the picker. The Klipy key stays on the server (`KLIPY_API_KEY`); GIFs are sent as a link and load from Klipy's CDN. Without a key the GIFs tab is hidden.
- Add more classic text emoticons (`<3`, `:-/`, `>:(`, `O:)`, …) and make `(Y)`-style shortcuts case-insensitive.
- Add a call stage: while you are in a call, the chat's main area shows everyone as tiles with speaking rings and the call controls, and chat sits beside it (a Chat tab on narrow windows). A chat with people in voice now shows who is there with a Join button.
- Add ringing: from the call stage you can ring a friend or everyone who is online and not in the call. They get an incoming-call popup with Join and Decline, the ring sound and, when Gather is in the background, a browser notification. Rings last 30 seconds, cancel when the caller leaves, and are rate limited (`call-ring-v1`).
- Add sounds for new messages, sent messages, call join/leave and a looping incoming-ring helper, with four synthesized packs (Bright chimes, Soft bubbles, Retro blips, Minimal), volume, per-event toggles and custom sounds stored only on the device.

## 0.3.0

- Fix caret-aware emoji insertion and immediate undo; keep the full catalog available with bounded pages, keyboard navigation and local recents.
- Reduce message rendering and emoji paint cost; fix sparse-cache pagination skipping messages and refresh hiding older history.
- Add replies, Copy, safe clickable links and basic formatting, larger image/GIF viewing, reaction names, search-to-context, date separators and persistent reading positions.
- Add truthful unread counts, saved former chats and notification mute in chat details.
- Serialize sends per chat; add pause, retry, safe edit/replacement and discard that reconciles uncertain delivery before removing local work.
- Preserve unreadable browser profiles behind a retry/recovery screen; complete offline artwork caching stays within a bounded size budget.
- Confirm the current server before automatic retries, reject delayed pre-reconnect bootstrap responses and recover temporary bootstrap failures.
- Detect restored servers, preserve the previous local mirror as a read-only archive, reset sync/read boundaries and pause unsent work for review.
- Add redacted operator diagnostics and bounded reclamation of confirmed cancelled uploads; preserve uncertain charges and the 5 GB ceiling.
- Warn before closing with active calls or selected unsent files; preserve existing signed update behavior.

## 0.1.2

- Add a dark theme across onboarding, chats, calls, dialogs, forms and errors. Remember System/Dark/Light per device and apply it before the first render.
- Retry unanswered initial audio offers, in addition to recovering failed ICE; an incomplete first negotiation can no longer wait forever without a retry.

- Add quiet, expiring typing status and local audio activity indicators. Stop monitoring on leaving a call and hide speaking activity while muted.
- Preserve the visible message while loading older history. Show new messages and a jump-to-latest control without pulling people away from what they are reading; update unread state when a focused chat is actually at the bottom.
- Ignore late signaling failures from retired peer connections so a departed friend cannot leave the call stuck on “Reconnecting”.

- Recover from missing saved microphones and ended capture tracks. Explain absent, blocked, and busy microphones; preserve working capture if a device replacement fails.
- Preserve mute during microphone changes and call recovery. Serialize device changes, cancel pending joins safely, and fall back from missing speaker selections.
- Bound WebSocket handshakes, reject pending work on disconnect, recover after missed heartbeats or wake, and retry a lost voice rejoin request.
- Catch up every missed message across multiple pages, reconcile saved acknowledgements with the outbox, and automatically retry unsent messages on reconnect.
- Keep explicit chat selection when a stale bootstrap response arrives. Wait for initial history before applying an existing identity’s invite.
- Expire stale Cloudflare socket presence/call slots using heartbeat timestamps and an alarm while clients remain connected.
- Prevent background throttling in the desktop app; disable voice joins while signaling reconnects. Version download links to avoid cached old builds.
- Add browser, desktop/browser interoperability, device-failure, repeated-reconnect, Cloudflare, and sustained-audio checks. Publishing now requires the packaged desktop and browser checks to pass.

## 0.1.1

- Fix a main-process crash when Electron performs a permission check after the window has been destroyed.
- Deny late permission and IPC requests without accessing disposed native objects; clear the window reference and mute shortcut when it closes.
- Add regression coverage using both disposed-object fixtures and a real destroyed Electron window. The desktop smoke test also checks for main-process exceptions during shutdown.

## 0.1.0

- Initial desktop and browser MVP: private text chats, invites, and two-person WebRTC voice calls with TURN fallback.
