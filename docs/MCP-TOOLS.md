# MCP Tools Reference

NanoClaw provides these tools to agents via the MCP server (`src/mcp-server.ts`). Agents access them through OpenCode's MCP integration.

## send_message

Send a message to the user immediately while you're still running.

**Parameters:**
- `text` (string, required) — The message text to send

**Behavior:** Writes an IPC file that the host picks up and sends via SMTP to NOTIFICATION_EMAIL.

**When to use:**
- Progress updates during long tasks
- Scheduled tasks (task output is NOT auto-sent)
- Multi-step workflows where you want to communicate before finishing

## trigger_email

Send a self-to-self email to trigger work in another group.

**Parameters:**
- `tag` (string, required) — The group tag (e.g., "family", "work", "ADMIN"). Case insensitive.
- `subject_suffix` (string, optional) — Text after [tag] in subject. Default: "Agent Trigger"
- `body` (string, required) — The email body — this becomes the prompt for the target group agent

**Behavior:** Writes an IPC file → host validates auth + rate limits → sends self-to-self email → IMAP picks it up → routes to target group.

**Authorization:**
- Admin (main) group can trigger any tag
- Non-admin groups can only trigger their own tag

**Rate limits:**
- 60s cooldown per source→target pair
- 30 triggers per hour globally
- Depth limit: refuses if current depth >= MAX_TRIGGER_DEPTH (default 3)

**Warning:** Do NOT use this in a loop. If your task was triggered by a trigger_email, do NOT send another to the same tag unless explicitly instructed.

## schedule_task

Schedule a recurring or one-time task.

**Parameters:**
- `prompt` (string, required) — What the agent should do when the task runs
- `schedule_type` (enum: "cron" | "interval" | "once", required)
- `schedule_value` (string, required) — Cron expression, milliseconds, or ISO timestamp
- `context_mode` (enum: "group" | "isolated", default: "group") — Whether to use group conversation context or start fresh
- `target_chat_id` (string, optional) — Admin only: schedule for a different group

**Schedule value formats (all times local timezone):**
- `cron`: Standard cron (e.g., `0 9 * * *` for daily at 9am)
- `interval`: Milliseconds (e.g., `3600000` for 1 hour)
- `once`: ISO timestamp WITHOUT Z suffix (e.g., `2026-02-01T15:30:00`)

**Context modes:**
- `group`: Task runs in the group's conversation context with chat history
- `isolated`: Task runs in a fresh session — include all context in the prompt

## list_tasks

List all scheduled tasks.

**Parameters:** None

**Behavior:** Admin sees all tasks; non-admin groups see only their own.

## pause_task

Pause a scheduled task (prevents it from running until resumed).

**Parameters:**
- `task_id` (string, required) — The task ID to pause

## resume_task

Resume a paused task.

**Parameters:**
- `task_id` (string, required) — The task ID to resume

## cancel_task

Cancel and permanently delete a scheduled task.

**Parameters:**
- `task_id` (string, required) — The task ID to cancel

## get_system_status

Get NanoClaw system status.

**Parameters:** None

**Returns:** JSON with uptime, IMAP connection status, registered groups count, active tasks count, active agents count.
