---
name: add-agent
description: Add a new agent persona to the NanoClaw network. Use when user wants to create a new agent, add a persona, register a group, or expand the agent team. Triggers on "add agent", "new agent", "create persona", "add group".
---

# Add Agent to NanoClaw

**Principle:** Gather the minimum needed info, then create everything. Don't make the user do manual steps.

## 1. Gather Agent Details

AskUserQuestion for:
- **Name** — The agent's persona name (e.g., "Nova", "Echo")
- **Tag** — The email tag that routes to this agent (e.g., "research", "content"). Lowercase, no spaces.
- **Role** — One-line description of what this agent does
- **Mission** — What should this agent focus on? What are its responsibilities?
- **Collaboration** — Which existing agents should it interact with? How?
- **Scheduled tasks** — Any recurring tasks? (daily scan, weekly report, etc.)

Check existing agents to avoid tag conflicts:
```bash
ls groups/
```

## 2. Create Group Directory

```bash
mkdir -p groups/<tag>/logs
```

## 3. Create CLAUDE.md

Write `groups/<tag>/CLAUDE.md` following this structure (use existing agents as reference — read `groups/research/CLAUDE.md` for the pattern):

```
# <Name> — <Role one-liner>

<Identity paragraph — who they are, their personality, their focus>

## About Launch80

Launch80 is a startup studio that helps aspiring founders transform their idea into a thriving business. We offer a DIY Portal, Discord community, and angel investment funding. Our goal is to establish tools and community that assist the pursuit of success throughout the startup journey. Website: https://www.launch80.com

## Your Mission

<Bullet points of what this agent tracks/does>

## How You Work

<Description of autonomous tasks with details on what to save and where>

## Workspace Organization

<List of directories and files this agent uses>

## Collaboration

<When to trigger other agents, what to send to admin>

## Communication Style

<How this agent writes — concise, analytical, warm, etc.>
```

## 4. Register in Database

Add the group to `scripts/setup-agents.ts`:

In the `groups` array:
```typescript
{ chatId: 'email:tag:<tag>', name: '<Name>', folder: '<tag>', tag: '<tag>' },
```

In the `tasks` array (if scheduled tasks were requested):
```typescript
{
  id: 'task-<tag>-<task-name>',
  group_folder: '<tag>',
  chat_id: 'email:tag:<tag>',
  prompt: '<detailed prompt for what the task should do>',
  schedule_type: 'cron',  // or 'interval'
  schedule_value: '<cron expression or milliseconds>',
  context_mode: 'group',  // or 'isolated'
},
```

Then run the setup script:
```bash
npx tsx scripts/setup-agents.ts
```

## 5. Update Global Awareness

Add the new agent to the agent network table in `groups/global/CLAUDE.md`:
```
| `[<tag>]` | <Name> | <Role> |
```

Add the new agent to the roster in `groups/main/CLAUDE.md`:
```
| <Name> | `[<tag>]` | <Role> | <Schedule summary> |
```

## 6. Update Dashboard Help

If `src/monitor.ts` has a hardcoded agent roster in the help modal, add the new agent there too.

## 7. Restart and Verify

```bash
# Kill existing process
lsof -ti :3700 | xargs kill 2>/dev/null
pkill -f "tsx src/index"
sleep 1

# Rebuild and restart
npm run build
nohup npx tsx src/index.ts > /tmp/nanoclaw.log 2>&1 &
sleep 3
cat /tmp/nanoclaw.log
```

Verify:
- Log shows correct `groupCount` (incremented by 1)
- Dashboard at `localhost:3700` shows the new group
- New scheduled tasks appear in the tasks table

## 8. Test

Send a test email:
```
Subject: [<tag>] Hello, introduce yourself and describe your role
```

Verify the agent responds in character.
