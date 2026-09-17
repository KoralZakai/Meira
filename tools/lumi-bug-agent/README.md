# Lumi bug agent

Fixes bugs reported over WhatsApp. Runs on the Mac, whenever the Mac is on.

## Why on the Mac

Fly runs a Python container with no checkout of this repo, no Claude Code, and
no way to run an EAS build. Fixing code needs all three. The accepted
trade-off: **nothing happens while the Mac is asleep** — reports still queue on
the server and get picked up next time it wakes.

## The flow

```
WhatsApp: "באג בלומי: ההתראות מופיעות פעמיים" + screenshot
   ↓  server files LUMI-3f2a, status new
Mac agent polls (every 2 min)
   ↓  branch bug/lumi-3f2a off master
   ↓  claude -p  ← report + screenshot + repo
   ↓  python tests + TS harnesses + tsc regression check
   ├─ tests fail  → status triaged, WhatsApp: "צריך מבט שלך", NO build
   └─ tests pass  → push branch, status fixed
                    WhatsApp: "לבנות גרסה? שלחי: בנה LUMI-3f2a"
   ↓  you reply "בנה LUMI-3f2a"
   ↓  EAS build on the branch
   ↓  WhatsApp: install link (the Expo page carries the QR)
```

## Rules the agent will not break

- Never commits to `master`, never merges, never force-pushes. Work lands on a
  `bug/*` branch you review.
- A failing test suite means the fix is **not** offered for a build.
- The `tsc` error count must not exceed the baseline measured at startup.
- No build without your explicit "בנה LUMI-xxxx" in WhatsApp.

## Setup (one time)

**1 — Claude Code CLI.** Not installed on this Mac yet; the agent shells out to
`claude -p`.

```bash
npm install -g @anthropic-ai/claude-code
```

**2 — Admin token.** `/admin/*` reads bug reports and personal tasks, and
`/admin/dedup?apply=true` mutates tasks, all on a public URL. It is now closed
unless this is set (an unset token fails safe rather than staying open).

```bash
openssl rand -hex 24
```

Set it on Fly with the value you just generated:

```bash
gh workflow run fly-set-secret.yml -f name=ADMIN_TOKEN -f value=PASTE_HERE
```

**3 — Install the launchd agent.** Copy the plist, replace
`PUT_YOUR_ADMIN_TOKEN_HERE` with the same token, then load it:

```bash
cp tools/lumi-bug-agent/com.lumi.bugagent.plist ~/Library/LaunchAgents/
```

```bash
launchctl load ~/Library/LaunchAgents/com.lumi.bugagent.plist
```

## Running it by hand instead

```bash
LUMI_ADMIN_TOKEN=... node tools/lumi-bug-agent/agent.mjs
```

## Commands from WhatsApp

| You send | What happens |
|---|---|
| `באג בלומי: <description>` (+ photo) | Files a bug, replies with its id |
| `באגים` | Lists your open bugs and their status |
| `בנה LUMI-3f2a` | Approves building the fix |

## Watching it

```bash
tail -f /tmp/lumi-bug-agent.log
```

To stop:

```bash
launchctl unload ~/Library/LaunchAgents/com.lumi.bugagent.plist
```
