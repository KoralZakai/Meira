# Meira over MCP: connect Claude, ChatGPT or Cursor

Meira is an **MCP server**. Any assistant that speaks the Model Context
Protocol can ask about your day, check whether something fits, and add
appointments. It gets the same answers the app and WhatsApp give: the same
tasks, the same memory, and real travel times.

```
Claude / ChatGPT / Cursor ──MCP──► POST /mcp ─► the same agent tools ─► Supabase ─► your phone
                                                                           (routes it, sets the alarm)
```

## 1. Get a key

In the app: **Menu → AI assistants → Connect Claude, ChatGPT or Cursor**.
The key (`meira_mcp_…`) is shown **once**. The server keeps only its SHA-256
hash, so you can't view the key again; make a new one instead. You can revoke
keys on the same screen, and deleting your account revokes all of them.

## 2. Connect

**Claude Code**
```bash
claude mcp add --transport http meira https://lumi-whatsapp.fly.dev/mcp --header "Authorization: Bearer meira_mcp_…"
```

**Claude Desktop / Cursor** (via `mcp-remote`)
```json
{
  "mcpServers": {
    "meira": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://lumi-whatsapp.fly.dev/mcp",
               "--header", "Authorization: Bearer meira_mcp_…"]
    }
  }
}
```

The app's **Share setup** button produces both, with your key filled in.

## 3. Ask

> "What's on my day tomorrow, and when do I have to leave?"
> "Do I have time for a 2-hour meeting in Haifa on Tuesday at 14:00?"
> "Add a dentist tomorrow at 16:00 at Ibn Gabirol 30."
> "Prepare me for Thursday's karaoke."

## Tools

| Tool | What it does |
|---|---|
| `get_my_day` | The day in order, with leave-home and wake-up times and clashes |
| `check_availability` | Does N minutes fit on a date, at a place, including real travel time? |
| `plan_journey` | Door to door: travel minutes, leave by, wake by, bus/train alternatives |
| `add_task` | Saves a task (filling in the usual place and hour from memory), reports the clash it creates, and plans the journey |
| `find_task` / `update_task` | Find and change an existing task |
| `prepare_me` | Tavily-researched preparation, with every item cited |
| `ask_meira` | A full agent turn in natural language, for anything else |

## Protocol notes

- MCP **Streamable HTTP** (spec `2025-06-18`, and `2025-03-26` / `2024-11-05`
  are accepted too), stateless: JSON-RPC over POST, answered with
  `application/json`. Notifications get `202`. `GET /mcp` returns `405` (no
  server-initiated stream).
- Auth is `Authorization: Bearer <meira_mcp_… | Supabase access token>`. The
  identity always comes from the token, never from a tool argument.
- Rate limit: 60 calls per minute per person.
- Implementation: `server/mcp_server.py`. Tests: `server/tests/test_mcp_server.py`.
