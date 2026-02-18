---
name: customize
description: Customize NanoClaw behavior. Use when user wants to add MCP tools, change the Ollama model, modify agent behavior, add groups, or configure integrations. Triggers on "customize", "add tool", "change model", "configure", "integration".
---

# NanoClaw Customize

Interactive customization for NanoClaw. Ask what the user wants to change.

## Adding MCP Tools

MCP tools are defined in `src/mcp-server.ts` and available to all agents via OpenCode.

To add a new tool:
1. Add the tool definition using `server.tool()` in `src/mcp-server.ts`
2. If the tool needs IPC (host-side processing), add a handler in `src/ipc.ts`
3. Rebuild: `npm run build`
4. Restart the service

Example tool pattern:
```typescript
server.tool(
  'tool_name',
  'Description of what this tool does',
  { param: z.string().describe('Parameter description') },
  async (args) => {
    // Write IPC file for host processing, or handle directly
    writeIpcFile(TASKS_DIR, { type: 'tool_name', ...args });
    return { content: [{ type: 'text', text: 'Done.' }] };
  },
);
```

## Changing the Ollama Model

1. Pull the new model: `ollama pull <model-name>`
2. Update `.env`: `OPENCODE_MODEL=ollama/<model-name>`
3. Update `~/.config/opencode/opencode.json` provider config to match
4. Restart NanoClaw

## Modifying Agent Behavior

Agent instructions live in CLAUDE.md files:
- `groups/global/CLAUDE.md` — Instructions for ALL agents
- `groups/main/CLAUDE.md` — Instructions for the admin agent only
- `groups/<name>/CLAUDE.md` — Per-group instructions

Edit these files to change agent personality, add skills, restrict behavior, etc.

## Adding Groups

Groups auto-register when a new email tag is used. Send a self-to-self email with `[newtag] Hello` and a new group will be created automatically.

To pre-configure a group:
1. Create the directory: `mkdir -p groups/<tag>/logs`
2. Add a `CLAUDE.md` with group-specific instructions
3. Register in DB (or just send the first email)

## Configuring Trigger Emails

Trigger email settings in `.env`:
- `MAX_TRIGGER_DEPTH=3` — Max chain depth for trigger emails
- `TRIGGER_COOLDOWN_MS=60000` — Cooldown between triggers (same source→target pair)
- `MAX_TRIGGERS_PER_HOUR=30` — Global hourly limit

## Configuring Scheduled Tasks

Tasks are created by agents using the `schedule_task` MCP tool. To manually create a task, write a JSON file to `data/ipc/<group>/tasks/`:

```json
{
  "type": "schedule_task",
  "prompt": "Check system status and report",
  "schedule_type": "cron",
  "schedule_value": "0 9 * * *",
  "context_mode": "isolated",
  "targetChatId": "email:tag:admin"
}
```

## Monitoring

- Dashboard: `http://localhost:3700` (auto-refreshes every 5s)
- Heartbeat: `data/heartbeat.json` (updated every 5 min)
- Agent logs: `groups/<name>/logs/`
- Set `MONITOR_PORT` in `.env` to change the dashboard port
