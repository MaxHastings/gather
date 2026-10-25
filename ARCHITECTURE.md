# Architecture

## Boundary

This is a small-friends-group app. Voice uses a bounded mesh of at most four live connections, enforced by the server; larger calls require revisiting topology and measured budgets. Text groups can have more members.

Version 0.2 adds native SQLite/browser IndexedDB history, transactional outbox and sync cursors, encrypted desktop credentials, device recovery/revocation, private attachments, message changes and reactions, running-app notifications, and authenticated Windows updates. Read current capabilities and limits in README.md and RELEASE.md; the provider and transport boundaries below remain the same.

```
Electron or browser
  HTTPS  ── chat API ── shared domain logic ── SQLite
  WSS    ── presence and authorized WebRTC signaling
  WebRTC ── peer audio, directly or through standard TURN
```

## Files

- `src/App.tsx`: conversations, composer, invites, settings, active call controls.
- `src/useChat.ts`: message reconciliation, persistent outbox, stable group selection, history loading.
- `src/realtime.ts`: a small JSON protocol over native WebSocket. One-use, 60-second tickets keep long-lived sign-in tokens out of WebSocket URLs. Heartbeats detect broken sockets and reconnect with backoff.
- `src/useVoice.ts`: standard WebRTC perfect negotiation, serialized incoming signaling, ICE restart, track replacement, mute/deafen, device fallback, and reconnect recovery. The microphone capture is stopped on leaving. This is owned application code, so regression testing is essential.
- `server/domain.mjs`: shared API and authorization rules. Membership is checked on every chat/history/relay action; signals are routed only between connections in the same active call.
- `server/app.mjs`: Node HTTP/WebSocket and SQLite adapter, useful for local operation and moving to conventional hosting.
- `cloudflare/worker.mjs`: Workers routing and a SQLite-backed Durable Object. Socket attachments survive hibernation; presence is reconciled with attached sockets on reconstruction. Heartbeats use the hibernation auto-response mechanism.
- `electron/`: sandboxed renderer, context isolation, audio-only permission requests, navigation restrictions, window controls, and a global mute shortcut. Hosted builds do not start a spare local backend.

## Delivery and recovery

Messages have a device-generated UUID, a sender identity, and a server sequence. A unique `(userId,clientId)` constraint makes retry idempotent. The server persists a message before broadcasting it. “Saved to chat” means persisted on the server; it is not a read receipt. Failed sends stay in the local outbox across reloads.

Text history is independent of a call. WebSocket recovery catches up forward from the last synchronized server sequence, paging until it has every missed message. Unsent messages are retried with the same idempotency key. Voice recovery rejoins the active group, retries a lost join request, rebuilds peers, and uses the existing microphone track without enabling a muted track. Deafen remembers the prior mute state. ICE restart repeats after network failures. A missing TURN configuration allows direct-only testing and is explicitly identified in audio settings.

On Cloudflare, a durable alarm checks for stale sockets while connections exist. It uses [hibernation auto-response timestamps](https://developers.cloudflare.com/durable-objects/api/state/#getwebsocketautoresponsetimestamp) to remove callers that have stopped sending heartbeats for more than two minutes, without waking the object for every ping. The alarm stops when no live sockets remain.

## Negotiation and presentation

For the current audio-only calls, the connection with the smaller ID initiates offers. The other endpoint answers and can ask that offerer to restart ICE. Perfect-negotiation collision handling remains for compatibility, but two current endpoints do not race simultaneous offers. Unanswered offers are retried, stale candidates cannot prevent an answer, and either an authoritative roster or the RPC reply confirms a voice join. A late error from a retired peer cannot change the active call state.

Typing is group-scoped ephemeral status with client throttling and expiry; draft text is never sent. Speaking rings analyse existing local/remote streams in one AudioContext per call, with all monitors and timers released on leaving. They do not record or upload activity. Appearance is a per-device preference, applied before React renders and independent of sign-in or voice state.

## Provider dependence

Cloudflare hosting uses provider-specific Durable Object APIs. Porting hosting is made practical by sharing the actual SQLite queries and domain behavior with Node, but data movement and operational changes still require work. SQLite/JSON exports, HTTP, WebSocket, WebRTC, and TURN are the stable boundaries. Cloudflare's TURN credential minting is a small server branch; coturn REST credentials are an alternative. The media flow itself uses no proprietary SFU API or media SDK.

## What has not been proved

Synthetic-microphone tests establish protocol behavior and packet flow, not subjective sound quality. Different physical headsets, Bluetooth handoffs, corporate firewalls, many-hour calls, sleeping devices, mobile background behavior, and extended outages need real-world coverage. An untested replacement for a mature SDK is not intrinsically more reliable just because it has fewer dependencies.

Server credentials, independent backups, identity recovery, verified updates, and a maintained release process matter to longevity. No release or host provides a twenty-year operating guarantee.

## Planned evolution

The long-term direction is: local archives, private sharing, recovery and Windows updates now have implementations; cloud expiry and friend-assisted recovery remain deferred. Cloud cleanup stays disabled.
