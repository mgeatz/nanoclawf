<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Personal AI assistant powered by OpenCode + local Ollama models. No cloud AI dependency. Email-based I/O.
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
   ASSISTANT_NAME=Andy
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

4. **Run**:
   ```bash
   npm run dev
   ```

## How It Works

1. Send yourself an email with a tag in the subject: `[family] Check on dinner plans`
2. NanoClaw picks it up via IMAP (self-to-self filter)
3. The tag `family` routes to a group folder with isolated memory
4. OpenCode + Ollama processes the prompt
5. Response is emailed to `NOTIFICATION_EMAIL` (not back to self, avoiding loops)

### Special Tags

- `[ADMIN]` — Main/privileged channel, can manage tasks across groups
- Any other tag auto-creates a group folder on first use

## Philosophy

**Small enough to understand.** One process, a few source files. No microservices, no message queues, no abstraction layers.

**Local-first AI.** Ollama runs on your hardware. No API keys, no cloud dependency, no usage limits.

**Email as I/O.** Works with any email provider. No proprietary messaging SDKs.

**Built for one user.** This isn't a framework. Fork it and make it yours.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code.

## What It Supports

- **Email I/O** — Self-to-self emails with subject tags for routing
- **Local AI** — OpenCode + Ollama, no cloud dependency
- **Isolated group context** — Each tag gets its own folder and memory
- **Main channel** — `[ADMIN]` tag for admin control
- **Scheduled tasks** — Recurring jobs via cron, interval, or one-time
- **Auto-registration** — New tags automatically create groups
- **No infinite loops** — Responses go to a separate notification address

## Usage

Send yourself emails with tags:

```
Subject: [family] Send an overview of dinner plans
Subject: [work] Summarize the git history from this week
Subject: [ADMIN] List all scheduled tasks across groups
Subject: [ADMIN] Pause the Monday briefing task
```

## Architecture

```
IMAP (self-to-self) --> SQLite --> Polling loop --> OpenCode + Ollama --> SMTP (to notification email)
```

Single Node.js process. Agents execute as `opencode run` child processes. Per-group message queue with concurrency control. IPC via filesystem.

Key files:
- `src/index.ts` — Orchestrator: state, message loop, agent invocation
- `src/channels/email.ts` — IMAP/SMTP email channel
- `src/opencode-client.ts` — Spawns OpenCode agent per prompt
- `src/mcp-server.ts` — MCP server for agent tools (send_message, schedule_task, etc.)
- `src/ipc.ts` — IPC watcher and task processing
- `src/router.ts` — Message formatting and outbound routing
- `src/group-queue.ts` — Per-group queue with global concurrency limit
- `src/task-scheduler.ts` — Runs scheduled tasks
- `src/db.ts` — SQLite operations (messages, groups, sessions, state)
- `opencode.json` — OpenCode + Ollama provider config
- `groups/*/CLAUDE.md` — Per-group memory

## Requirements

- macOS or Linux
- Node.js 20+
- [Ollama](https://ollama.ai)
- [OpenCode](https://opencode.ai)
- IMAP/SMTP email account

## License

MIT
