# NanoClaw

Personal AI assistant powered by OpenCode + local Ollama models. See [README.md](README.md) for philosophy and setup.

## Quick Context

Single Node.js process that monitors IMAP for self-to-self emails, routes messages to OpenCode + Ollama per group. Each email subject tag (e.g., `[family]`) maps to an isolated group folder. Responses go to a separate `NOTIFICATION_EMAIL` to avoid infinite loops. Agents can trigger work in other groups via self-to-self trigger emails.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation, heartbeat |
| `src/channels/email.ts` | IMAP/SMTP email channel, self-trigger emails |
| `src/opencode-client.ts` | Spawns `opencode run` per prompt (NDJSON output) |
| `src/mcp-server.ts` | MCP server: send_message, trigger_email, schedule_task, etc. |
| `src/ipc.ts` | IPC watcher, task processing, trigger rate limiting |
| `src/monitor.ts` | Localhost HTML status dashboard |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Email, OpenCode, trigger limits, monitoring config |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `opencode.json` | OpenCode MCP config |
| `groups/global/CLAUDE.md` | Instructions for ALL agents |
| `groups/main/CLAUDE.md` | Admin-only agent instructions |
| `groups/{name}/CLAUDE.md` | Per-group agent instructions |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, email config, verify IMAP/SMTP + Ollama + OpenCode |
| `/add-agent` | Add a new agent persona — creates group folder, CLAUDE.md, registers in DB |
| `/add-task` | Add a new scheduled task — gathers details, registers in DB, updates setup script |
| `/customize` | Adding MCP tools, changing models, modifying agent behavior |
| `/debug` | Email issues, agent errors, IPC problems, troubleshooting |

## Documentation

| Doc | Content |
|-----|---------|
| `docs/EMAIL-PATTERNS.md` | Self-to-self email patterns and use cases |
| `docs/MCP-TOOLS.md` | Agent MCP tool reference |
| `docs/REQUIREMENTS.md` | Architecture decisions |

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run dev          # Run with hot reload (tsx)
npm run build        # Compile TypeScript
npm test             # Run tests (vitest)
npm run monitor      # Open status dashboard in browser
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Architecture Notes

- **NDJSON output**: OpenCode `--format json` outputs newline-delimited JSON events, not single JSON. Parse each line and extract text from `type: "text"` events.
- **IMAP quirks**: Proton Bridge uses STARTTLS on port 1143 (not implicit TLS). System auto-detects based on port. Use `imap.search()` + `imap.fetchOne()` pattern, not `imap.fetch()` with ranges.
- **Trigger depth**: `X-NanoClaw-Trigger-Depth` header tracks chain depth. MCP server refuses trigger_email if depth >= MAX_TRIGGER_DEPTH.
- **DB column mapping**: SQLite uses `chat_jid` internally but TypeScript maps to `chat_id`.
