# Security policy

Gather is a small, privately operated chat and voice service. Please report vulnerabilities privately so they can be fixed before details are public.

## Reporting

Use GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting). Do not open a public issue for security problems. Include what you found, how to reproduce it and the version or commit you tested.

Please do not test against other people's conversations or data, run denial-of-service or load tests against the hosted service, or access files or accounts that are not yours.

## What to expect

Reports are handled on a best-effort basis by a single maintainer. Expect an acknowledgement within about a week.

## Scope

In scope: the Worker and Node server, the browser and Electron clients, the update signature and download path, and invite, session and media access controls.

Out of scope: social engineering, third-party services (Cloudflare, GitHub) and findings that need a compromised device.

## Things worth knowing

- Chat is not end-to-end encrypted; the server can read messages. Voice uses WebRTC transport encryption.
- No secrets belong in this repository. Operator credentials and signing keys are kept outside Git. If you find one committed, report it.
