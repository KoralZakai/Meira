#!/usr/bin/env bash
# One-shot setup for the bug agent — no GitHub web UI needed.
#
# Generates an ADMIN_TOKEN, sets it as a Fly secret through the Fly Set Secret
# workflow, writes it into the launchd plist, and loads the agent.
#
# The token is printed once. It is the credential for /admin/* (bug reports and
# task mutation), so treat it like a password: do not paste it into a chat, an
# issue, or a screenshot.
#
# Usage:  bash tools/lumi-bug-agent/setup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_SRC="$REPO_DIR/tools/lumi-bug-agent/com.lumi.bugagent.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.lumi.bugagent.plist"

command -v gh >/dev/null || { echo "gh CLI not found — brew install gh"; exit 1; }
command -v node >/dev/null || { echo "node not found"; exit 1; }

if ! command -v claude >/dev/null; then
  echo "!! Claude Code CLI is not installed — the agent shells out to it."
  echo "   Install it, then re-run this script:"
  echo "     npm install -g @anthropic-ai/claude-code"
  exit 1
fi

TOKEN="$(openssl rand -hex 24)"

echo "==> Setting ADMIN_TOKEN on Fly (via the Fly Set Secret workflow)"
gh workflow run fly-set-secret.yml -f name=ADMIN_TOKEN -f value="$TOKEN" --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)"

echo "==> Installing the launchd agent"
mkdir -p "$HOME/Library/LaunchAgents"
# Written via a temp file so a failure part-way never leaves a plist holding a
# placeholder token that the agent would then use.
tmp="$(mktemp)"
sed "s|PUT_YOUR_ADMIN_TOKEN_HERE|$TOKEN|" "$PLIST_SRC" > "$tmp"
mv "$tmp" "$PLIST_DST"
chmod 600 "$PLIST_DST"   # it holds a secret

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

cat <<EOF

Done.

  Token (needed for curl against /admin/*, store it in your password manager):
    $TOKEN

  Fly picks the secret up after the workflow finishes (~1 min):
    gh run list --workflow=fly-set-secret.yml --limit 1

  Agent logs:
    tail -f /tmp/lumi-bug-agent.log

  Stop the agent:
    launchctl unload "$PLIST_DST"
EOF
