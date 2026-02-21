# MCP Tools Reference

NanoClaw provides these tools to agents via the MCP server (`src/mcp-server.ts`). Agents access them through OpenCode's MCP integration.

## send_message

Send a message to the user immediately while you're still running.

**Parameters:**
- `text` (string, required) — The message text to send
- `priority` (enum: "notify" | "digest" | "log", default: "digest") — Delivery priority

**Behavior:** Writes an IPC file that the host picks up and routes based on priority:
- `notify`: Routed to admin, then forwarded to user immediately
- `digest`: Batched into periodic digest email
- `log`: Stored in activity log only, no email

**When to use:**
- Scheduled tasks (task output is NOT auto-sent)
- Content drafts needing approval (use `notify`)
- Progress updates (use `digest`)
- "Nothing new" check-ins (use `log`)

## trigger_email

Send a self-to-self email to trigger work in another group.

**Parameters:**
- `tag` (string, required) — The group tag (e.g., "content", "social", "admin"). Case insensitive.
- `subject_suffix` (string, optional) — Text after [tag] in subject. Default: "Agent Trigger"
- `body` (string, required) — The email body — this becomes the prompt for the target group agent

**Behavior:** Writes an IPC file → host validates target exists + rate limits → sends self-to-self email → IMAP picks it up → routes to target group.

**Authorization:** Any agent can trigger any registered group. Target must exist.

**Rate limits:**
- 60s cooldown per source→target pair
- 60 triggers per hour globally
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

## get_activity_log

**(Main/Admin only)** Get recent activity log entries showing what all agents have been doing.

**Parameters:**
- `agent` (string, optional) — Filter by agent group folder (e.g., "content", "research", "social")
- `event_type` (string, optional) — Filter by event type (e.g., "agent_completed", "trigger_email_sent", "agent_error")
- `limit` (number, optional) — Max entries to return (default 50)

**Returns:** Formatted activity entries with timestamps, event types, summaries, and relevant details.

## web_search

Search the web using Perplexity AI. Opens Perplexity in the default browser, waits for the AI-generated answer, and returns the result.

**Parameters:**
- `query` (string, required) — Search query

**Returns:** AI-generated answer from Perplexity with synthesized information and sources.

**When to use:**
- Researching startup ecosystem trends, funding rounds, tools
- Finding current information about competitors, news, events
- Answering questions that need up-to-date web data

**Tips:**
- Write natural language queries for best results (e.g., "What are the latest Y Combinator batch startups?")
- Keep queries focused and specific
- Results include Perplexity's AI-synthesized answer with citations
- Uses browser automation (AppleScript) — requires default browser with macOS Accessibility permission
- Takes ~30-60 seconds as it opens a browser tab, waits for the answer, then extracts the text

## post_to_social

Post content to a social media platform using macOS browser automation (AppleScript).

**IMPORTANT:** Only use this AFTER the user has explicitly approved a draft.

**Parameters:**
- `platform` (enum: "twitter" | "linkedin" | "reddit" | "reddit_dm", required)
- `text` (string, required) — The post content
- `url` (string, optional) — Required for reddit (post URL), reddit_dm (target username), twitter replies (tweet URL)

**Platform requirements:**
- **Twitter/X new post**: Default browser, macOS Accessibility permission
- **Twitter/X reply**: Same + pass `url` with the tweet URL
- **Reddit comment**: Default browser, pass `url` with the post URL
- **Reddit DM**: Default browser, pass `url` with target username (without u/)
- **LinkedIn**: Safari with Develop > Allow JavaScript from Apple Events
