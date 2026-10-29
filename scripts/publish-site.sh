#!/usr/bin/env bash
# Publish site/ to https://meirasecretary.github.io
#
# The source of truth is site/ in THIS repo. The public repo
# MeiraSecretary/meirasecretary.github.io only ever receives a copy of it, and
# GitHub Pages serves that repo's main branch about a minute after a push.
#
# Trigger: by hand, after a change to site/ is committed —
#   npm run site:publish
# Nothing runs this on its own. Publishing on every push to master would need a
# deploy key on the public repo, and that is the owner's call.
set -euo pipefail

REPO="MeiraSecretary/meirasecretary.github.io"
URL="https://meirasecretary.github.io/"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ -n "$(git status --porcelain -- site)" ]; then
  echo "✗ site/ has uncommitted changes. Commit them first, so what is live is also in git." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# An empty new repo clones fine; a missing one fails here, loudly.
git clone -q --depth 1 "https://github.com/$REPO.git" "$TMP/pub"
rsync -a --delete --exclude .git "$ROOT/site/" "$TMP/pub/"

cd "$TMP/pub"
git add -A
if git diff --cached --quiet; then
  echo "✓ already up to date: $URL"
  exit 0
fi
git commit -q -m "site: $(git -C "$ROOT" log -1 --format='%h %s' -- site)"
git push -q origin HEAD:main
echo "✓ pushed. Live in about a minute: $URL"
