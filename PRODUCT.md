# Gather

A familiar place for a small group of friends. Open the conversation. Talk. Come back tomorrow and find it where you left it.

## What people are really asking for

The Skype/Discord comments shared during development are qualitative input, not current product specifications. They suggest five needs: continuity with friends, familiar places for relationships, freedom from administration, trustworthy behavior, and software that asks little of you.

The product is a conversation. Voice is an activity inside that conversation. It is not a server browser, community management system, activity feed, or gaming identity service.

## Rules

- Keep groups in a stable order. New messages do not rearrange your relationships.
- Never fake online people, successful delivery, or a connected call.
- Preserve drafts and unsent messages. Retries must not duplicate a message.
- Recover calls automatically where possible. Preserve mute and deafen during recovery.
- Make deliberate actions obvious: join, mute, leave, invite.
- Do not ring everyone when someone quietly joins voice.
- Add no discovery feed, ads, achievements, promotional notifications, or engagement tracking.
- Do not show what game someone is playing or broadcast their activity without asking.
- Keep settings small and remember them. Check microphone access only when requested.
- Stop microphone capture immediately on leaving a call.
- Do not promise low resource use without measuring it.

## First release boundary

Private text groups, invite links, persistent history, and audio calls for two connections per group in this MVP. Text-only messages first. Larger calls, file transfers, direct calls with ringing, screen sharing, account recovery, signed updates, and mobile clients require separate implementation and testing. No decorative controls for features that do not exist.

## Twenty-year intent

Twenty years is a maintenance commitment, not a guarantee provided by a framework. Prefer understandable code, standard HTTP/WebSocket/WebRTC/TURN protocols, SQLite, documented data export, a local development path, and replaceable hosting adapters. Keep product decisions separate from providers. Pin dependencies and review security updates. Maintain and exercise backups and restore procedures before relying on a hosted deployment.

Product and engineering decisions for subsequent releases follow these principles: Cloud resources must remain bounded; durable local history, recoverable identity, and verified restore precede destructive retention changes. Example durations and file sizes are adjustable policies, not architectural requirements.
