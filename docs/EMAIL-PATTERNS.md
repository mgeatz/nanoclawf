# Email Patterns & Use Cases

NanoClaw uses a self-to-self email pattern for all communication. This document covers how it works and what you can build with it.

## How Email I/O Works

```
┌─────────┐   self-to-self    ┌───────────┐    OpenCode     ┌─────────┐
│  User    │ ──────────────→  │ NanoClaw  │ ──────────────→ │ Ollama  │
│          │   [TAG] subject  │  (IMAP)   │    agent run    │  (LLM)  │
└─────────┘                   └───────────┘                 └─────────┘
                                    │
                                    │  SMTP to NOTIFICATION_EMAIL
                                    ▼
                              ┌───────────┐
                              │ Inbox     │  ← user reads response here
                              └───────────┘
```

**Inbound:** User sends email FROM their address TO their address. Subject contains `[TAG]` to route to a group. NanoClaw's IMAP poller picks it up.

**Outbound:** Agent response is sent FROM the email address TO `NOTIFICATION_EMAIL` (a different address), so it doesn't trigger the poller again.

**Trigger:** Agents can send self-to-self emails (FROM=TO=EMAIL_ADDRESS) to trigger work in other groups. This creates a loop that NanoClaw picks up as new inbound work.

## Pattern 1: Cross-Group Communication

The admin agent dispatches work to specialized groups.

**Trigger:** `[ADMIN] Check on dinner plans with family and summarize work tasks`

**Agent behavior:**
1. Breaks the request into sub-tasks
2. Uses `trigger_email(tag: "family", body: "Check dinner plans")` and `trigger_email(tag: "work", body: "Summarize pending tasks")`
3. Each group processes independently in its own context
4. Results arrive as separate notification emails

**Loop prevention:** Trigger depth is tracked. After 3 chained triggers, further triggers are refused.

## Pattern 2: Workflow Chaining

A research pipeline passes through multiple stages.

**Trigger:** `[research] Find the top 5 CRM tools for small teams`

**Agent behavior:**
1. Research agent searches the web, compiles findings
2. Triggers `[writing]` group: "Write a comparison report based on this data: [findings]"
3. Writing agent creates a formatted report
4. Optionally triggers `[admin]` with a summary

**MCP tools:** `trigger_email`, web search, file operations

## Pattern 3: Daily Digest

A scheduled task compiles a daily summary.

**Setup:** Admin schedules via `schedule_task`:
```
prompt: "Compile and send the daily digest"
schedule_type: "cron"
schedule_value: "0 8 * * *"
context_mode: "isolated"
```

**Agent behavior:**
1. Reads workspace files in each group for recent changes
2. Checks upcoming scheduled tasks
3. Fetches weather/news via web search
4. Compiles summary and sends via `send_message`

## Pattern 4: Reminders

Natural language reminders become scheduled tasks.

**Trigger:** `[ADMIN] Remind me to call Bob at 3pm`

**Agent behavior:**
1. Parses "at 3pm" → `2026-02-18T15:00:00`
2. Creates `schedule_task(prompt: "Send reminder: Call Bob", schedule_type: "once", schedule_value: "2026-02-18T15:00:00")`
3. At 3pm, the task agent sends: "Reminder: Call Bob"

## Pattern 5: Price Monitoring

Scheduled checks with alert thresholds.

**Trigger:** `[ADMIN] Check BTC price every hour, alert if below $50k`

**Agent behavior:**
1. Creates a recurring task: `schedule_task(prompt: "Check Bitcoin price. If below $50,000, send an alert via send_message. Otherwise, log silently.", schedule_type: "interval", schedule_value: "3600000")`
2. Every hour, the task agent fetches the price via web search
3. Only sends a notification if the threshold is breached

## Pattern 6: Web Monitoring

Watch a URL for changes.

**Trigger:** `[ADMIN] Watch https://example.com/status for changes`

**Agent behavior:**
1. Fetches the URL, saves snapshot to `monitors/example-status.txt`
2. Schedules a recurring task to check every 30 minutes
3. Task agent fetches URL, compares with snapshot
4. If changed: sends diff summary via `send_message`
5. Updates snapshot

## Pattern 7: Heartbeat

Ensure the system is running by checking for periodic status emails.

**Setup:** Set `HEARTBEAT_EMAIL=true` in `.env` (or schedule manually)

**How it works:**
- NanoClaw writes `data/heartbeat.json` every 5 minutes with system status
- A scheduled task (if enabled) periodically prompts the admin agent to send a status update
- If emails stop arriving, the system is down

**Manual monitoring:** Dashboard at `http://localhost:3700`

## Pattern 8: X/Social Media Posting

Cross-platform publishing from email.

**Trigger:** `[ADMIN] Post on X: Just shipped a new feature!`

**Agent behavior:**
1. Runs the X integration post script with the tweet content
2. Reports confirmation with tweet URL back to the user

## Pattern 9: Autonomous Research

Multi-step research with depth-limited self-triggers.

**Trigger:** `[research] Deep dive into the current state of AI regulation in the EU`

**Agent behavior:**
1. Does initial web search, identifies key topics
2. For each topic, triggers itself with a focused research prompt (depth 1)
3. At depth 1, does detailed research and saves findings
4. At depth 2, could compile findings (but depth 3 is the hard limit)

**Safety:** MAX_TRIGGER_DEPTH=3 prevents infinite loops. Rate limiting (60s cooldown, 30/hour) prevents flood.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_TRIGGER_DEPTH` | 3 | Maximum trigger email chain depth |
| `TRIGGER_COOLDOWN_MS` | 60000 | Cooldown per source→target pair |
| `MAX_TRIGGERS_PER_HOUR` | 30 | Global hourly trigger limit |
| `HEARTBEAT_EMAIL` | false | Enable periodic heartbeat emails |
| `HEARTBEAT_INTERVAL` | 21600000 | Heartbeat interval (ms, default 6h) |
| `MONITOR_PORT` | 3700 | Localhost dashboard port |
