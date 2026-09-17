# Tavily MCP — live web search inside Claude Code

Tavily is wired as a **remote HTTP MCP server**, alongside Supabase, in
[`.mcp.json`](../.mcp.json):

```json
"tavily": {
  "type": "http",
  "url": "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}"
}
```

Verified against the live endpoint on 2026-09-15: `tavily-mcp` **v4.0.3**,
protocol `2024-11-05`, advertising tools, prompts and resources.

## Where the key lives — and why not here

The API key is part of the URL, so a hard-coded URL is a **published secret**:
this repo is on GitHub, and a `tvly-…` key in `.mcp.json` is a key anyone can
spend. Instead the URL carries `${TAVILY_API_KEY}`, which Claude Code expands
from the environment at connect time, and the value sits in:

```
.claude/settings.local.json      ← gitignored, never committed
```

```json
{ "env": { "TAVILY_API_KEY": "tvly-dev-…" } }
```

`.claude/settings.json` IS tracked — do not put the key there.
`.gitignore` now carries `.claude/settings.local.json` explicitly.

To rotate: replace the value in `.claude/settings.local.json` and restart
Claude Code. Nothing in git changes.

## Scope — this is developer tooling, not an app dependency

Tavily is available to **Claude Code while working on this repo**. It is not
compiled into the APK and it is not called by the Expo app or by the Fly
server. It needs no `EXPO_PUBLIC_*` variable, and it must never get one — an
`EXPO_PUBLIC_*` value is inlined into the bundle at build time, which is
exactly how the old Nebius key shipped inside every APK and had to be rotated
(see CLAUDE.md → ENV VARIABLES).

The server already has its own live-search path: the `web_search` tool in
`server/lumi_agent.py`. Tavily does not replace it.

## Using it

Restart Claude Code after this change — MCP servers are connected at startup,
so a server added mid-session is not available until then. Then:

```bash
claude mcp list
```

`tavily` should report **Connected**. Its tools appear as `mcp__tavily__*`
(search, extract, crawl, map) and are used like any other tool — "search the
web for X" will route to them.
