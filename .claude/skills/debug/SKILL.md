---
name: debug
description: Debug NanoClaw issues. Use when things aren't working, email not being picked up, agent errors, IPC problems, or to understand system state. Triggers on "debug", "troubleshoot", "not working", "logs", "why isn't".
---

# NanoClaw Debug

Systematic debugging for NanoClaw. Work through these checks in order, stopping when you find the issue.

## 1. Service Status

```bash
# Is the process running?
pgrep -f "dist/index.js" || pgrep -f "tsx src/index.ts"

# Launchd service status (macOS)
launchctl list | grep nanoclaw
```

If not running, check error logs: `logs/nanoclaw.error.log`

## 2. IMAP Connection

Check heartbeat file:
```bash
cat data/heartbeat.json
```

Look for `imap_connected: true`. If false or stale timestamp, IMAP is down.

**Common IMAP issues:**
- Proton Bridge not running: `pgrep -f "Proton Mail Bridge"` — restart Bridge if needed
- Port mismatch: Check `.env` IMAP_PORT matches Bridge/provider settings
- SSL mode: Port 993 = implicit TLS, port 1143 = STARTTLS. System auto-detects.

## 3. Email Flow

Check if emails are being received:
```bash
sqlite3 store/messages.db "SELECT id, chat_jid, timestamp, substr(content, 1, 60) FROM messages ORDER BY timestamp DESC LIMIT 10"
```

Check the UID cursor:
```bash
sqlite3 store/messages.db "SELECT * FROM router_state WHERE key = 'email_last_seen_uid'"
```

If cursor is stale or NaN, fix it:
```bash
sqlite3 store/messages.db "UPDATE router_state SET value = '0' WHERE key = 'email_last_seen_uid'"
```

## 4. Agent Execution

Check recent agent logs:
```bash
ls -la groups/*/logs/ | tail -20
```

Read the most recent log file for the failing group. Look for:
- Exit code (0 = success)
- Timeout flag
- Stderr content (OpenCode errors, Ollama connection issues)

**Common agent issues:**
- OpenCode not found: Check path in `src/opencode-client.ts`
- Ollama not running: `ollama list` — if error, start with `ollama serve`
- Model not pulled: `ollama pull qwen2.5-coder:32b`

## 5. IPC System

Check for stuck IPC files:
```bash
find data/ipc -name "*.json" -type f
```

Files should be processed and deleted quickly. Stuck files indicate processing errors. Check `data/ipc/errors/` for failed files.

## 6. Database State

```bash
# Registered groups
sqlite3 store/messages.db "SELECT jid, name, folder, trigger_pattern FROM registered_groups"

# Scheduled tasks
sqlite3 store/messages.db "SELECT id, group_folder, status, schedule_type, next_run FROM scheduled_tasks"

# Sessions
sqlite3 store/messages.db "SELECT * FROM sessions"
```

## 7. Monitor Dashboard

Open `http://localhost:3700` to see live system state including active agents, tasks, groups, and recent activity.

## 8. Live Logs

```bash
# Follow service logs
tail -f logs/nanoclaw.log | npx pino-pretty

# Or if running with tsx
npm run dev
```
