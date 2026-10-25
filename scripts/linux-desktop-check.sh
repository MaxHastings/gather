#!/usr/bin/env bash
set -euo pipefail
# This disposable CI keyring belongs only to the runner's isolated test profile.
export XDG_CURRENT_DESKTOP=GNOME
export XDG_RUNTIME_DIR="$(mktemp -d)"
chmod 700 "$XDG_RUNTIME_DIR"
printf '%s' 'gather-ci-disposable-keyring' | gnome-keyring-daemon --unlock --components=secrets
node scripts/session-smoke.mjs
node scripts/smoke.mjs
