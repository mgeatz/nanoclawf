---
name: add-task
description: Add a new scheduled task to the NanoClaw network. Use when user wants to create a recurring or one-time task for any agent. Triggers on "add task", "new task", "schedule task", "create task", "add scheduled task".
---

# Add Scheduled Task to NanoClaw

**Principle:** Gather minimum info, validate, create the task, and confirm. Don't make the user figure out cron syntax or millisecond values.

## 1. Gather Task Details

AskUserQuestion for anything the user hasn't already specified:

- **Agent** — Which agent should run this task? Show available agents:
  - `[research]` Nova — Startup ecosystem intelligence
  - `[growth]` Ledger — Growth metrics, funding landscape
  - `[content]` Echo — Brand & marketing, social posts
  - `[ops]` Sentinel — Operations, health checks
  - `[product]` Atlas — Product & platform, backlog
  - `[community]` Harbor — Founder relations, Discord
  - `[social]` SocialSpark — Social media SEO, Reddit engagement
  - `[main]` Admin — Overseer, elevated privileges

- **Prompt** — What should the agent do when the task runs? This should be detailed and self-contained. The agent gets this as its full instruction set for the task run.

- **Schedule** — When/how often should it run? Help the user translate natural language:
  - "every 30 minutes" → interval: `1800000`
  - "every 2 hours" → interval: `7200000`
  - "daily at 9am" → cron: `0 9 * * *`
  - "weekdays at 8:30am" → cron: `30 8 * * 1-5`
  - "every Monday at 10am" → cron: `0 10 * * 1`
  - "Fridays at 2pm" → cron: `0 14 * * 5`
  - "once at <specific time>" → once: ISO timestamp without Z suffix

- **Context mode** — Does the task need chat history?
  - `group` (default): Runs with the agent's full conversation history. Good for tasks that build on previous context.
  - `isolated`: Fresh session each run. Good for independent checks, health monitoring.

## 2. Generate Task ID

Follow the naming convention: `task-<group>-<descriptive-name>`

Examples:
- `task-research-competitor-scan`
- `task-ops-weekly-review`
- `task-social-reddit-engagement`
- `task-content-newsletter-draft`

Keep it short, lowercase, hyphen-separated.

## 3. Add to setup-agents.ts

Add the new task to the `tasks` array in `scripts/setup-agents.ts`:

```typescript
  // =============================================
  // <Group> (<AgentName>) — <brief description>
  // =============================================
  {
    id: 'task-<group>-<name>',
    group_folder: '<group>',
    chat_id: 'email:tag:<tag>',
    prompt: '<the detailed prompt>',
    schedule_type: '<cron|interval|once>' as const,
    schedule_value: '<value>',
    context_mode: '<group|isolated>' as const,
  },
```

Insert before the closing `];` of the tasks array.

## 4. Register in Database

Run the setup script to create the task (existing tasks are safely skipped):

```bash
npx tsx scripts/setup-agents.ts
```

Verify output shows: `Created task: task-<group>-<name>`

## 5. Build

```bash
npm run build
```

## 6. Update Agent Instructions (if needed)

If the task introduces new behavior the agent needs to know about (new file paths, new workflows, new approval patterns), update the agent's `groups/<tag>/CLAUDE.md` with relevant instructions.

## 7. Verify

- Run `npm run build` — no TypeScript errors
- Check the dashboard at `localhost:3700` — new task appears in Scheduled Tasks
- Optionally trigger immediately from dashboard via "Run Now" button
- Check activity feed for task execution results

## Schedule Quick Reference

### Cron Expressions (local timezone)

| Expression | Meaning |
|-----------|---------|
| `*/15 * * * *` | Every 15 minutes |
| `0 */2 * * *` | Every 2 hours |
| `0 9 * * *` | Daily at 9:00 AM |
| `30 8 * * 1-5` | Weekdays at 8:30 AM |
| `0 14 * * 5` | Fridays at 2:00 PM |
| `0 10 * * 1` | Mondays at 10:00 AM |
| `0 9,17 * * *` | Daily at 9 AM and 5 PM |

### Interval Values (milliseconds)

| Value | Meaning |
|-------|---------|
| `900000` | 15 minutes |
| `1200000` | 20 minutes |
| `1800000` | 30 minutes |
| `3600000` | 1 hour |
| `7200000` | 2 hours |
| `14400000` | 4 hours |
| `21600000` | 6 hours |
| `43200000` | 12 hours |

## Prompt Writing Tips

Good task prompts are:
- **Self-contained** — Include all context the agent needs. Don't assume it remembers previous runs.
- **Specific about output** — Where to save files, what priority for `send_message`, when to notify vs log.
- **Idempotent** — Tell the agent to check for existing work before duplicating (e.g., "check groups/social/reddit-comments/ for today's count before drafting").
- **Quiet when idle** — "If nothing new, use priority: `log`" prevents unnecessary emails.

Example:
```
Daily competitor scan: Search the web for news about startup studios similar to Launch80
(Antler, Entrepreneur First, Pioneer, On Deck). Check groups/research/competitors.md for
your last findings and only report NET NEW developments. Append new items with timestamps.
If anything significant changed, send to admin via send_message with priority: "notify".
If no new developments, use priority: "log".
```
