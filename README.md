<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Personal AI agent network powered by OpenCode + local Ollama models. No cloud AI dependency. Email-based I/O. Built for <a href="https://www.launch80.com">Launch80</a>.
</p>

## Why I Built This

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project with a great vision. But I can't sleep well running software I don't understand with access to my life. OpenClaw has 52+ modules, 8 config management files, 45+ dependencies, and abstractions for 15 channel providers.

NanoClaw gives you the same core functionality in a codebase you can understand in 8 minutes. One process. A handful of files. Local AI via Ollama.

## Quick Start

```bash
git clone https://github.com/gavrielc/nanoclaw.git
cd nanoclaw
npm install
```

### Prerequisites

1. **Ollama** — Install from [ollama.ai](https://ollama.ai) and pull a model:
   ```bash
   ollama pull qwen2.5-coder:32b
   ```

2. **OpenCode** — Install from [opencode.ai](https://opencode.ai):
   ```bash
   go install github.com/opencode-ai/opencode@latest
   ```

3. **Email credentials** — Create a `.env` file:
   ```bash
   ASSISTANT_NAME=Rush
   IMAP_HOST=imap.gmail.com
   IMAP_PORT=993
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   EMAIL_ADDRESS=you@gmail.com
   EMAIL_PASSWORD=your-app-password
   NOTIFICATION_EMAIL=your-notifications@gmail.com
   MAIN_TAG=ADMIN
   OPENCODE_MODEL=ollama/qwen2.5-coder:32b
   ```

4. **Set up agents** (registers groups and scheduled tasks):
   ```bash
   npx tsx scripts/setup-agents.ts
   ```

5. **Run**:
   ```bash
   npm run dev
   ```

6. **Dashboard** — Open `http://localhost:3700` to see system status, active agents, and scheduled tasks.

## How It Works

1. Send yourself an email with a tag in the subject: `[ADMIN] List all scheduled tasks`
2. NanoClaw picks it up via IMAP (self-to-self filter)
3. The tag routes to a group folder with isolated memory and persona
4. OpenCode + Ollama processes the prompt with MCP tools
5. Response is emailed to `NOTIFICATION_EMAIL`

### Agent Network

NanoClaw runs a team of specialized AI agents that collaborate autonomously:

| Agent | Tag | Role |
|-------|-----|------|
| **Admin** | `[ADMIN]` | Overseer — delegates work, approves content, elevated privileges |
| **Nova** | `[research]` | Startup ecosystem intelligence — trends, competitors, tools |
| **Ledger** | `[growth]` | Growth metrics — funding landscape, angel investment trends |
| **Echo** | `[content]` | Brand & marketing — drafts social posts, blog content, newsletters |
| **Sentinel** | `[ops]` | Operations — daily digest, system health, coordination |
| **Atlas** | `[product]` | Product & platform — DIY Portal, Discord infra, backlog |
| **Harbor** | `[community]` | Founder relations — Discord engagement, onboarding, spotlights |

Agents communicate via **trigger emails** — cross-group messages that route work to the right specialist. For example, Nova discovers a trending topic and triggers Echo to draft content about it. Trigger depth is tracked to prevent infinite loops (max 3 hops).

### Scheduled Tasks

Each agent has autonomous tasks that run on cron schedules or intervals:

- **Nova:** Daily trend scan (8:30 AM), weekly deep dive (Friday 2 PM)
- **Ledger:** Funding scan (every 6h), weekly growth report (Monday 9 AM)
- **Echo:** Daily content review (10 AM)
- **Sentinel:** Daily digest (8 AM), health check (every 4h)
- **Atlas:** Daily standup (9 AM), weekly product review (Friday 5 PM)
- **Harbor:** Daily community pulse (9:30 AM), weekly founder spotlight (Wednesday 3 PM)

### MCP Tools

Agents have access to tools via MCP (Model Context Protocol):

| Tool | Purpose |
|------|---------|
| `send_message` | Send a message to the user immediately |
| `schedule_task` | Schedule a one-time or recurring task |
| `list_tasks` | List all scheduled tasks |
| `pause_task` / `resume_task` / `cancel_task` | Manage scheduled tasks |
| `trigger_email` | Send work to another agent group |
| `get_system_status` | Check NanoClaw system health |

### Dashboard

The monitoring dashboard at `http://localhost:3700` shows:

- **System status** — Uptime, IMAP connection, heartbeat
- **Active agents** — Which agents are currently processing
- **Scheduled tasks** — All tasks with status, schedule, next run time
- **Run Now** — Manually trigger any scheduled task
- **Help** — Built-in documentation explaining all dashboard sections

## Philosophy

**Small enough to understand.** One process, a few source files. No microservices, no message queues, no abstraction layers.

**Local-first AI.** Ollama runs on your hardware. No API keys, no cloud dependency, no usage limits.

**Email as I/O.** Works with any email provider. No proprietary messaging SDKs.

**Built for one user.** This isn't a framework. Fork it and make it yours.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code.

## Usage

Send yourself emails with tags:

```
Subject: [ADMIN] List all scheduled tasks across groups
Subject: [ADMIN] Ask Nova to research the top startup studios
Subject: [research] What are the top no-code platforms for MVPs?
Subject: [content] Draft a tweet about why founders should join Launch80
Subject: [ops] Status report
Subject: [community] Draft a discussion prompt about founder burnout
```

## Architecture

```
IMAP (self-to-self) --> SQLite --> Polling loop --> OpenCode + Ollama --> SMTP (to notification email)
                                                         |
                                                    MCP Tools
                                                         |
                                              IPC (trigger_email,
                                            schedule_task, etc.)
```

Single Node.js process. Agents execute as `opencode run` child processes. Per-group message queue with concurrency control. IPC via filesystem. Cross-agent communication via trigger emails with depth tracking.

Key files:

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/email.ts` | IMAP/SMTP email channel |
| `src/opencode-client.ts` | Spawns OpenCode agent per prompt |
| `src/mcp-server.ts` | MCP server for agent tools |
| `src/ipc.ts` | IPC watcher, trigger emails, rate limiting |
| `src/router.ts` | Message formatting and outbound routing |
| `src/group-queue.ts` | Per-group queue with global concurrency limit |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/monitor.ts` | Dashboard web server (port 3700) |
| `src/db.ts` | SQLite operations |
| `groups/*/CLAUDE.md` | Per-group agent persona and memory |
| `groups/global/CLAUDE.md` | Shared instructions for all agents |
| `scripts/setup-agents.ts` | One-shot script to register groups and tasks |

## Requirements

- macOS or Linux
- Node.js 20+
- [Ollama](https://ollama.ai)
- [OpenCode](https://opencode.ai)
- IMAP/SMTP email account

## License

MIT
