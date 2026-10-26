# Gather operations

Operational backup support is available during roadmap execution.

Version 0.2 update: private attachment writes, profile/group pictures and the storage-status endpoint are live. Historical setup notes below that say “source-only” or “no media” describe the earlier 0.1.2 deployment. Snapshots now include media/avatar manifests, reservations, reactions and deletion state, but **not R2 original payloads**. A database snapshot alone cannot restore lost R2 files. Portable user archives can include available originals (100 MB total file limit; 20 MB text/metadata); import is a separate read-only copy, not identity recovery. Native/browser local file controls protect pending and explicitly kept originals; complete archive import staging remains follow-up work.

File expiry is enabled (30 days; 7 days for files of 25 MB or more; a daily sweep, or POST /api/admin/media-expire) and the oldest sent files roll off at the 250 MB chat/person limits. Text is kept at least two years and is not yet trimmed by code. The 5 GB byte ceiling remains active; capacity exhaustion pauses new attachments. Request/relay budgets and automatic backup scheduling/retention are follow-up operational work, not promises of zero charges or unattended protection. The owner deferred independent custody of the backup encryption key; the encrypted GitHub copy cannot be restored after losing every copy of that key.

## Secrets and credentials

Keep `.env`, device tokens, recovery codes, and backup encryption keys outside Git. `node scripts/configure-operations.mjs` creates an operator token and a 32-byte backup encryption key in the ignored `.env` without printing them. Store a protected copy of the encryption key in a password manager or another independent secure location. Losing that key makes encrypted backups unreadable.

`node scripts/deploy-secrets.mjs` uploads TURN credentials and the operator token to Cloudflare. It does not upload the backup encryption key. The operator token can read the entire server snapshot; it must never enter client configuration, diagnostics, URLs, or shared messages. Rotate it by changing the local value and running the secret upload again.

## Take and verify a snapshot

```powershell
node scripts/backup.mjs
```

The script requests the authenticated operator endpoint over HTTPS, encrypts the logical snapshot with AES-256-GCM, decrypts it, restores it into an isolated SQLite database, and checks integrity before saving the encrypted file. A snapshot includes users, hashed sessions, conversations, membership, messages, schema versions, sequence ceilings, and application tables added by supported migrations, including devices and hashed recovery codes. It excludes tickets, live sockets, voice membership, request counters, and hosting internal tables. No live data is changed.

This initial export is bounded to 100,000 rows per table and 16 MiB of serialized row data. It fails rather than publishing a partial backup. A paged consistent export must replace it before measured usage reaches those limits. Later migrations must extend restore tests for every added durable table. Table names beginning with an underscore are reserved for hosting infrastructure.

The operator endpoint defaults to unavailable unless a sufficiently long `GATHER_ADMIN_TOKEN` is configured. Ordinary sign-in tokens grant no operator access. It returns no cacheable response and has the same origin checks as other APIs.

## Keep an independent encrypted copy

```powershell
node scripts/publish-backup.mjs <encrypted-backup-path>
```

This verifies decryption/restoration again, checks that the repository named by `GATHER_BACKUP_REPOSITORY` (owner/name) is private, and stores only encrypted bytes on its `codex/operational-backups` branch. Use a separate private repository, never the public source repository. It does not upload `.env` or encryption keys and does not create an app release. Keep the encryption key independently recoverable; a copy only on the same computer is insufficient protection from computer loss.

Current execution has manual snapshots and publishing. Scheduled backups, bounded backup retention, alerting, media inclusion, and key rotation with overlapping readability remain release work. A successful manual snapshot is not evidence that unattended backups are running.

## Restore into an isolated server

Create a new empty directory under an ignored test/data location, then restore into a new file:

```powershell
node scripts/restore-backup.mjs <encrypted-backup-path> .gather-test-restore/gather.sqlite
$env:DATA_DIR='.gather-test-restore'
$env:PORT='14318'
node --env-file-if-exists=.env server/index.mjs
```

Restore refuses an existing destination file, unsupported schema, invalid values, and broken references. It never executes SQL supplied by the snapshot. It restores the recorded schema before applying supported migrations; an archive from a newer unsupported schema needs a newer server. Verify existing test identities can read the expected private history, outsiders cannot read it, retries retain message IDs, new message sequences advance, and new voice membership works. Production restoration and traffic cutover are separate operations; the local restore command does not modify Cloudflare.

Before future cleanup is activated, restoration must also reapply current deletion and availability rules. Snapshots now include attachment manifests; independently saved original payloads remain necessary to recover lost R2 files.

## Deployment and rollback

Deploy with `npm run deploy`, never a bare `npx wrangler deploy`. `vite build` empties `dist/`, which deletes the installer parts, `downloads/releases.json` and `updates/latest.yml`; shipping without them makes /download say "unavailable" and breaks Windows auto-update. `scripts/deploy.mjs` keeps those files in `.gather-release/`, restores them after the build, refuses to deploy if they are missing, incomplete or for a version other than package.json, then deploys and checks `/`, `/download`, the catalog, the update manifest and each download live. If the live check fails it prints `npx wrangler rollback`. A fresh clone with no local copy can run `npm run deploy -- --from-live` to mirror the files from the live site first. `--dry-run` builds and validates without deploying. New releases still use `npm run release:publish` (or `cloud:deploy` after `prepare-download`), which now go through the same script. Take a backup first when the change touches data.

Keep the deployed Worker version ID, app commit, protocol/schema versions, and download checksum with each release. A compatible backend-only change can deploy without changing the existing portable app download. Future schema changes need a tested pre-migration snapshot and compatible rollback strategy. Do not put an old binary onto an incompatible database.

Cloud cleanup remains disabled. There is no automatic expiry or data migration in the backup foundation change. The eventual resource policy is based on measured budgets, not an assumed fixed retention period.

## R2 storage ceiling

R2 activation is complete. The dedicated Standard-class bucket `gather-private-media` was created and its `r2.dev` public access was verified disabled. Attachments and avatars now use the single ledger-backed writer described below.

Source schema 3 adds a durable object ledger. All Gather object writes must use `server/object-storage.mjs` on the single `private-friends-v1` Durable Object authority. The hard ceiling is **5,000,000,000 bytes**, shared by all files, staged uploads, uncertain writes, derivatives and any backups in that bucket. A synchronous SQLite transaction reserves actual buffered bytes before the asynchronous R2 write. Random immutable object keys prevent overwrites and delayed retries from changing already-accounted objects. No direct client writes, presigned uploads or multipart uploads are permitted through this implementation. The initial individual-object allowance is 10,000,000 bytes and can be reviewed separately from the total ceiling.

Failed writes retain their charge because the provider may have stored the object before losing the response. Successful deletion frees capacity only after R2 confirms it. Uncertain writes require deliberate reconciliation; elapsed time alone never frees them. On every server instance, the writer inventories all bucket objects before accepting writes, accounting for objects missing from an older restored database and refusing writes if inventory fails. A dedicated bucket and single writer are essential: manual uploads, another service writing to the bucket, other account buckets, or an administrator changing the code are outside this application guarantee. Do not repurpose the bucket or attach another writer.

The protected `GET /api/admin/storage` endpoint reports the byte ceiling, charged and unsettled bytes, available capacity and object count. It is available on the deployed backend. Normal chat does not perform inventory requests or depend on R2 availability. Tests cover simultaneous reservations, exact boundary admission, failed writes and deletions, disk failure after provider commit, persistence, old-snapshot inventory and operator access. The local Wrangler runtime also reports the exact 5 GB limit and zero usage for its isolated bucket.

Cloudflare's published per-bucket storage limit is unlimited; this ceiling is enforced by Gather, not an R2 dashboard quota. Storage and operation counts are separate billable metrics. Keep monthly request budgets and monitoring in the release gates; do not present the byte ceiling as a provider-wide hard spending cap. [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) · [Usage-based billing](https://developers.cloudflare.com/billing/understand/usage-based-billing/)

## Local chat archives

Source Settings → History & archives searches saved messages, exports received text, and imports old exports as separate read-only local copies. Export combines device history with available server history; if the server cannot be reached, it exports saved device history and says so. Unsent messages and account credentials are excluded, and invite capabilities are stripped. Importing a file cannot recover an identity or join a group. Keep recovery codes and the server backup encryption key separately.

The current `gather-archive-v1` file is UTF-8 JSON with a feature list, export timestamp, display identity, conversation metadata and stable message records. Original `gather-export-v1` files remain readable. Portable bundles are limited to 100,000,000 bytes in total, including at most 20,000,000 bytes of text/metadata and 100,000 messages. Available originals are included; unavailable files are explicitly marked missing. Unsupported required features are rejected. A successful import is atomic and isolated from current conversations. Removing an imported copy leaves the original file and live chat untouched. Browser-managed storage can be cleared or evicted; an imported copy on the same device is not an independent backup.

## Desktop profile storage

The source desktop client keeps the active profile in `session.sqlite` inside Electron's user-data directory. Credential payloads are encrypted with Electron's asynchronous `safeStorage` API (Windows-backed key protection), and SQLite provides atomic durable replacement. This protection is for device credentials; local conversation history is a separate database and is not encrypted by this feature. The browser client continues using browser-managed storage. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage/)

An existing desktop localStorage profile migrates using the same credential and identity. Its old logical entry is removed only after the encrypted record commits. This is not secure erasure of historical disk blocks or old backups. A signed-out encrypted tombstone prevents a leftover legacy entry from being reused. Do not delete the credential database as a troubleshooting shortcut: that discards its signed-out state and may revive an older legacy entry. A missing or locked Windows key store and unreadable ciphertext stop startup with retry rather than replacing the identity. The encrypted database alone is not a portable recovery mechanism; use the separate profile recovery code when moving to another Windows account or computer.


## Group ownership and removal (0.2.1)

Schema 9 stores `group_controls` and `group_departures`. Existing chats infer their owner from the earliest membership row, preserving the original creator under the previous append-only membership behavior. Include both new tables in snapshots; restoring a pre-9 snapshot runs the same tested migration. Do not run an older server against schema 9.

Owner actions require an expected control revision. Joining, leaving, removal, invite replacement and ownership transfer advance it; stale confirmations fail safely and refresh authoritative state. Removing a member deletes their voice roster entries for that chat, not their devices or identity. Direct membership events cover every connected device; bootstrap departure records cover reconnects and offline devices. Current clients stop microphone capture and retain received local history read-only. Remaining callers discard the removed peer’s media connections. Every history/media/message endpoint continues checking membership on the server.

Removal replaces the invite automatically. A current member may deliberately share the new link to readmit someone; no permanent ban or hierarchy is introduced. The last member leaving closes the invite and leaves historical server rows intact. Cloud expiry remains disabled and the storage ceiling is unchanged.


## Recovery boundaries and resource review (0.3)

Schema 10 adds `cancelled_messages`, `message_replies` and `server_state`. Normal process reopen keeps the generation stable; `restoreDatabase` rotates it. Restoring a snapshot from before schema 10 also assigns a new generation. Clients compare it before remote history/catch-up and automatic retries. A change atomically saves their received mirror as an owned read-only archive, retains unsent work paused, clears sync cursors and starts the current mirror afresh. This prevents reused sequence numbers from mixing histories and prevents silently republishing work lost by the restore. A previous-generation local original can be read through the archive only after checksum validation. This is preservation of device evidence, not restoration of current server membership or a complete media backup.

`GET /api/admin/diagnostics` reports schema/generation, aggregate record counts and message character totals. It excludes names, message bodies, tokens, candidate addresses and audio. `POST /api/admin/media-cleanup` retries at most 20 confirmed cancelled uploads per call. It never selects accepted attachments or arbitrary inventory objects. In-flight cancellation retains its reservation until the provider write finishes; failed deletion remains charged. `writing`, `uncertain` and unknown/external inventory require deliberate reconciliation and are never freed by age. No accepted-history expiry or periodic cleanup job is enabled.

The interaction fixture records SQLite allocation, local HTTP request count, JS heap samples and frame/input timing separately in `test-results/interaction-0.3.json`. It loads 1,000 mixed text/Unicode/formatting/emoji messages and GIFs, keeps actual voice packets flowing and checks complete paging. HTTP totals are a workload measurement, not a Cloudflare invoice. `group-voice-smoke.mjs` records native CPU/memory and RTP statistics; hosted checks separately record sent/received audio payload bytes and selected relay pairs. RTP payload counters omit transport/relay overhead and are not provider-billed byte totals. Use Cloudflare's account usage for actual Worker/Durable Object/R2 requests and TURN transfer; a storage byte ceiling cannot enforce those budgets. Check `/api/admin/storage` for charged/uncertain storage and diagnostics for metadata growth. Snapshot limits remain 100,000 rows per table and 16 MiB, with failure rather than incomplete output.

Recovery coverage:

| Data | Current recoverable copy | Remaining dependency |
| --- | --- | --- |
| Source and release artifacts | Private GitHub main/tags/releases | GitHub account access |
| Server identities, grants, messages, reply/cancellation state and media manifests | Manually verified encrypted snapshots, also in a separate private backup repository | Independent encryption-key custody is still deferred |
| R2 original payloads | Live private bucket; some device caches and exported portable archives | Logical server snapshots do not contain these bytes; no automatic independent media backup |
| Device drafts, unsent work and local archives | This device's durable history/profile storage | Export/save elsewhere for independent protection; unsent work is not in server exports |
| Identity | Profile recovery code plus server grant records | Device-encrypted credentials alone are not portable recovery |
| Update signing and backup encryption keys | Ignored protected local configuration; signing-key backup support | Independent custody and tested key recovery remain operator work |

For unattended snapshots, use one consistent encrypted snapshot job with a single-flight lock, bounded generations/byte budget, atomic publish, decryption/restore verification, an externally visible last-success timestamp and alerts for missed runs. Keep the last verified good generation when a run fails. Activate only after independent key recovery and destination/retention budgets are settled; no schedule is installed by 0.3. Source control is not a substitute for those keys or original media.

A restore also rewinds authorization and deletion records to the snapshot. Review known later removals, revoked devices and deletions before traffic cutover; an older snapshot cannot reconstruct changes absent from every surviving copy. The generation boundary protects client synchronization and sending, not an unknown post-snapshot audit trail.

## Public launch safety (0.5)

Gather is open to anyone and anonymous, so the protections are automatic and the operator tools are small.

### Reports and moderation

Anyone in a chat can press **Report** on another person's message. The report keeps a short excerpt (so it still exists if the message is later deleted) and the file's name. Reports are limited to 20 per person per day.

```powershell
node scripts/moderate.mjs reports                     # open reports, with the sender's sign-up/upload IPs
node scripts/moderate.mjs remove-message <messageId>  # blank a message and delete its files
node scripts/moderate.mjs remove-file <uploadId>      # delete just the file
node scripts/moderate.mjs ban <userId> --purge --block-ip some reason
node scripts/moderate.mjs remove-group <groupId>      # blank everything, remove everyone, kill the invite link
node scripts/moderate.mjs resolve <reportId> actioned # or dismissed
```

A ban ends every device of that person, deletes their recovery code and (with `--purge`) removes their messages and files; `--block-ip` also blocks the addresses they signed up from. Unban with `unban`. Removal tools are operator-only (the same token as backups).

### Automatic limits

- Sign-ups: 5 a minute and 25 a day per IP; globally 2,000 new people a day and 6,000 total, 3,000 chats. At a ceiling, sign-ups pause with a friendly message; existing people keep chatting.
- Files: a new account may share 10 files / 50 MB in its first day (60 files / 200 MB afterwards). A daily global file ceiling (6,000) pauses heavy sharers first; everyone's first two files a day still go through. A person can start 5 chats a day.
- Voice relay (TURN): 40 relay credentials per person and 1,500 in total per day. Beyond that calls use direct connections only (free) and still work for most people.
- Change any ceiling without a deploy: `node scripts/moderate.mjs limits signupsPerDay=500 relay=false` (run `limits` alone to see them all).

### Storage policy for the 5 GB pool

1. Per-chat (250 MB) and per-person (250 MB) allowances shrink as the pool fills: full size below 50% used, falling to 50 MB per chat and 25 MB per person by 90%.
2. If a new file still does not fit, or the pool would have less than 2% headroom, the oldest files of the **heaviest person** are dropped first. A newcomer is never locked out; light users lose files last.
3. Files expire after 30 days (7 for files of 25 MB or more); at 70% used that becomes 3 days, at 85% one day. Text is not touched.

`tests/safety.test.mjs` simulates 1,200 newcomers plus hoarders and abusive accounts and asserts the pool never passes its cap and every newcomer's first file is accepted.

### Logs

Sign-ups, uploads and reports log IP and time (table `activity_log`, deleted after 90 days, excluded from backups). Nothing else is logged. TURN credential counts live in the same table and are deleted after two days.

### Billing alerts and hard stops (Cloudflare dashboard)

Code caps R2 storage and the TURN/sign-up/upload rates above, but Cloudflare bills on usage, so also set an alert:

1. Cloudflare dashboard → **Notifications** → **Add** → choose the **Billing / usage-based billing** notification and set a threshold you are comfortable with (for example $10 and $25), delivered to your email.
2. Dashboard → **Realtime → TURN** (or **Calls**): TURN is free for the first 1,000 GB a month, then billed per GB. There is no built-in spending cap; if usage ever looks wrong, **revoke or disable the TURN key** there, or run `node scripts/moderate.mjs limits relay=false` to stop handing out relay credentials right away.
3. Workers paid plan includes 10 million requests a month; per-IP limits and sign-up ceilings keep a flood from reaching that cheaply. Check **Workers & Pages → gather-friends → Metrics** after any viral moment.

### If someone reports child sexual abuse material (CSAM) or other illegal content

This is operational guidance, not legal advice; please read the linked sources and ask a lawyer when you can.

- In the US, a service that becomes aware of apparent CSAM must report it to the NCMEC CyberTipline (report.cybertip.org) and preserve what it reported (currently one year). Do not forward, copy or keep the images anywhere else, and do not investigate beyond what a report needs.
- Order: save the report (`reports` output, including excerpt and IPs), **file the CyberTipline report first**, then remove the content and ban the person. Removing first can destroy evidence you are required to keep.
- For copyright complaints, register a free-to-cheap DMCA agent with the US Copyright Office and honour takedown notices promptly. The MSN art is the likeliest item to attract one.
- Keep answering law-enforcement requests through the Discord link on the Terms page (or the report page), and keep a short log of what you did and when.
- Section 230 and the Terms protect you only if you act on reports quickly. Check the report list at least daily while the site is public.
