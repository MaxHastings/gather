# Gather 0.4.0

New landing page for visitors without an invite, with honest desktop messaging, Safari/PWA basics and a small public invite preview that names the chat on invite pages.

Redesigned emoji picker (category rail, search, recent) and Klipy GIF search in the composer. Calls get a stage with a Chat tab and ring-to-join: ring an absent member, decline, or join. Sound packs and an improved, loudness-matched sound set. Phone layout, scroll-to-latest and landing fixes.

Per-chat and per-person file quotas of 250 MB apply to new uploads only. Limits otherwise stay: four-person voice, four files per message, 10,000,000 bytes per file and a shared 5,000,000,000-byte private bucket ceiling.

Fixes in this release: own-message actions stay reachable in the narrow chat panel beside a call.

Existing installed Windows builds receive authenticated updates and offer a safe restart; portable users update manually. Refresh the web page for the browser client.

Verification: 92 unit/server tests and the full packaged/browser release gate passed before deploy. After deploy, production reports schema 10 with the `call-ring-v1` and `gif-search-v1` capabilities, the download catalog points at 0.4.0 with a matching installer checksum, and pre- and post-deploy backups restore. `verification.json` lists what was not verified (real 0.3.0 NSIS upgrade, updater smoke, scripted ring run, authenticated GIF request on production). Hashes are in `SHA256SUMS.txt`.
