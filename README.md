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
   DIGEST_INTERVAL_MS=7200000     # optional: digest email interval (default 2h)
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
5. Response is emailed to `NOTIFICATION_EMAIL` as rich HTML

### Agent Network

NanoClaw runs a team of specialized AI agents that collaborate autonomously:

| Agent | Tag | Role |
|-------|-----|------|
| **Admin** | `[ADMIN]` | **Gatekeeper** — all agent-to-user comms flow through admin, routes replies back to agents |
| **Nova** | `[research]` | Startup ecosystem intelligence — trends, competitors, tools |
| **Ledger** | `[growth]` | Growth metrics — funding landscape, angel investment trends |
| **Echo** | `[content]` | Brand & marketing — drafts and posts social content, blog outlines, newsletters |
| **Sentinel** | `[ops]` | Operations — daily digest, system health, coordination |
| **Atlas** | `[product]` | Product & platform — DIY Portal, Discord infra, backlog |
| **Harbor** | `[community]` | Founder relations — Discord engagement, onboarding, spotlights |
| **SocialSpark** | `[social]` | Social media SEO — viral strategies, platform trends, Reddit engagement |

**Admin is the gatekeeper.** All agent-to-user communications flow through the admin agent. When agents have something important (approvals, alerts, findings), they send it to admin, who decides what to forward to the user. When the user replies from `NOTIFICATION_EMAIL`, it goes to admin, who routes it to the right agent.

```
Agents → [admin] → user (NOTIFICATION_EMAIL)
User → replies to [admin] → routes to agents via trigger_email
```

Agents also communicate directly via **trigger emails** — cross-group messages that route work to the right specialist. For example, Nova discovers a trending topic and triggers Echo to draft content about it. Trigger depth is tracked to prevent infinite loops (max 3 hops).

### Social Media Posting

Echo can publish approved content directly to social platforms using macOS AppleScript automation:

1. Echo drafts content and saves it to `groups/content/drafts/`
2. Echo notifies admin, who forwards to you for review
3. You reply to approve — admin routes approval to Echo
4. Echo uses `post_to_social` to publish via your browser (Twitter/X, LinkedIn)

### Twitter/X Reply Engagement

Echo searches for tweets from founders asking about startup challenges every 2 hours. When it finds a good opportunity:

1. Echo drafts a helpful reply that naturally mentions the Launch80 Discord
2. Sends the draft to admin with the original tweet context
3. Admin forwards for your review — you reply with approval
4. Echo uses `post_to_social` with the tweet URL to reply via your browser

Rate limited to 3 replies per day. All Discord links use UTM tracking (`?utm_source=twitter_reply`).

### Reddit Engagement

SocialSpark scans startup subreddits (r/startups, r/Entrepreneur, r/SideProject, etc.) every 2 hours looking for posts where Launch80 can add value. When it finds a good opportunity:

1. SocialSpark drafts a helpful comment that naturally mentions the Launch80 Discord
2. Sends the draft to admin with post context for review
3. You reply to approve — admin routes to SocialSpark
4. SocialSpark uses `post_to_social` with the Reddit post URL to comment via your browser

Rate limited to 3 comments per day. Comments lead with genuine value — not promotion. Discord links use UTM tracking (`?utm_source=reddit`).

### Content Repurposing

Echo automatically repurposes high-performing content daily at 11am:
- Reddit comments → tweets + LinkedIn posts
- Tweets → LinkedIn posts

Each repurposed piece includes platform-appropriate UTM-tracked Discord links.

### Reddit Performance Tracking

SocialSpark tracks engagement on posted Reddit comments every 6 hours. When a comment performs well (high upvotes, generates replies), it flags it to admin and triggers Echo to repurpose the winning content.

### Browser Automation Requirements

macOS with Accessibility permission granted. User must be logged in to platforms in their browser.
- **Twitter/X:** Works with any default browser
- **LinkedIn:** Requires Safari with "Allow JavaScript from Apple Events" enabled
- **Reddit:** Works with Safari, Chrome, Arc, and other Chromium browsers

### Scheduled Tasks

Each agent has autonomous tasks that run on cron schedules or intervals:

- **Nova:** Daily trend scan (8:30 AM), weekly deep dive (Friday 2 PM)
- **Ledger:** Funding scan (every 6h), weekly growth report (Monday 9 AM)
- **Echo:** Content review (every 45min), Twitter reply engagement (every 2h), content repurposing (daily 11 AM)
- **Sentinel:** Daily digest (8 AM), health check (every 4h)
- **Atlas:** Daily standup (9 AM), weekly product review (Friday 5 PM)
- **Harbor:** Daily community pulse (9:30 AM), weekly founder spotlight (Wednesday 3 PM)
- **SocialSpark:** Daily trend & strategy scan, weekly growth strategy report, Reddit engagement (every 2h), Reddit performance tracking (every 6h)

### Notification Priority System

Not all agent output needs your immediate attention. The `send_message` tool has three priority levels:

| Priority | Behavior | Example |
|----------|----------|---------|
| `notify` | Routed to admin, then forwarded to user | Approvals needed, alerts, direct answers |
| `digest` | Batched into periodic digest email (default) | Status updates, routine reports |
| `log` | Activity log only, no email | "Nothing new" check-ins, internal notes |

- **User-initiated messages** (you email a tag directly) always get an immediate response email.
- **Trigger-initiated and scheduled task output** is not auto-emailed — agents use `send_message` with the appropriate priority.
- **Digest emails** are sent every 2 hours (configurable via `DIGEST_INTERVAL_MS`) and consolidate all `digest` messages into one email grouped by agent.

### MCP Tools

Agents have access to tools via MCP (Model Context Protocol):

| Tool | Purpose |
|------|---------|
| `send_message` | Send a message to the user (with priority: `notify`/`digest`/`log`) |
| `schedule_task` | Schedule a one-time or recurring task |
| `list_tasks` | List all scheduled tasks |
| `pause_task` / `resume_task` / `cancel_task` | Manage scheduled tasks |
| `trigger_email` | Send work to another agent group |
| `post_to_social` | Post content to Twitter/X, LinkedIn, or Reddit via AppleScript |
| `get_system_status` | Check NanoClaw system health |

### Dashboard

The monitoring dashboard at `http://localhost:3700` shows:

- **System status** — Uptime, IMAP connection, heartbeat
- **Active agents** — Live output streaming, token counts, processing time
- **Activity feed** — Real-time log of all events with filters (agents, tasks, emails, triggers, errors)
- **Scheduled tasks** — All tasks with status, schedule, success rate, average duration
- **Run Now / Pause / Resume** — Full task lifecycle management
- **Edit Schedule** — Modify task schedules with the full prompt visible for context
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
Subject: [content] approve draft-20260219-1030  (approves a draft for posting)
Subject: [ops] Status report
Subject: [community] Draft a discussion prompt about founder burnout
Subject: [social] What's trending on startup Twitter this week?
Subject: [social] approve comment-20260219-1430  (approves a Reddit comment for posting)
```

## Architecture

```
IMAP (self-to-self) --> SQLite --> Polling loop --> OpenCode + Ollama --> SMTP (rich HTML email)
                                                         |                       |
                                                    MCP Tools              Priority routing
                                                         |              (notify/digest/log)
                                              IPC (trigger_email,            |
                                            schedule_task, etc.)        Digest queue
                                                         |             (batched email)
                                                    AppleScript
                                                  (post_to_social)
```

Single Node.js process. Agents execute as `opencode run` child processes. Per-group message queue with concurrency control. IPC via filesystem. Cross-agent communication via trigger emails with depth tracking. Notification emails rendered as rich HTML via `marked`. Digest queue batches low-priority messages into periodic consolidated emails.

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
| `src/db.ts` | SQLite operations (incl. digest queue) |
| `groups/*/CLAUDE.md` | Per-group agent persona and memory |
| `groups/global/CLAUDE.md` | Shared instructions for all agents |
| `scripts/setup-agents.ts` | One-shot script to register groups and tasks |
| `scripts/post-*.applescript` | AppleScript automation for social posting |

## Requirements

- macOS or Linux
- Node.js 20+
- [Ollama](https://ollama.ai)
- [OpenCode](https://opencode.ai)
- IMAP/SMTP email account

## License

MIT
