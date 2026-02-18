# NanoClaw

Personal AI assistant powered by OpenCode + local Ollama models. See [README.md](README.md) for philosophy and setup.

## Quick Context

Single Node.js process that monitors IMAP for self-to-self emails, routes messages to OpenCode + Ollama per group. Each email subject tag (e.g., `[family]`) maps to an isolated group folder. Responses go to a separate `NOTIFICATION_EMAIL` to avoid infinite loops.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/email.ts` | IMAP/SMTP email channel |
| `src/opencode-client.ts` | Spawns `opencode run` per prompt |
| `src/mcp-server.ts` | Host-side MCP server for agent tools |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Email, OpenCode, paths, intervals |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `opencode.json` | OpenCode + Ollama provider config |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Email issues, agent issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # Run tests
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```
