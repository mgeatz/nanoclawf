# NanoClaw Architecture

A single Node.js process that orchestrates a network of AI agents via self-to-self email routing, local Ollama models, and file-based IPC.

---

## System Overview

```mermaid
graph TB
    subgraph External["External Services"]
        IMAP["IMAP Server<br/>(Gmail / Proton Bridge)"]
        SMTP["SMTP Server"]
        Ollama["Ollama<br/>(Local LLM)"]
    end

    subgraph NanoClaw["NanoClaw Process (Node.js)"]
        direction TB
        EmailChannel["Email Channel<br/><code>channels/email.ts</code>"]
        MainLoop["Main Loop<br/><code>index.ts</code>"]
        GroupQueue["Group Queue<br/><code>group-queue.ts</code>"]
        TaskScheduler["Task Scheduler<br/><code>task-scheduler.ts</code>"]
        IPCWatcher["IPC Watcher<br/><code>ipc.ts</code>"]
        Router["Router<br/><code>router.ts</code>"]
        Monitor["Monitor Dashboard<br/><code>monitor.ts</code>"]
        AgentTracker["Agent Tracker<br/><code>agent-tracker.ts</code>"]
        DB["SQLite DB<br/><code>db.ts</code>"]
    end

    subgraph Agents["Agent Subprocesses"]
        OC1["OpenCode Agent<br/>[admin]"]
        OC2["OpenCode Agent<br/>[research]"]
        OC3["OpenCode Agent<br/>[content]"]
        OCN["OpenCode Agent<br/>[...]"]
    end

    subgraph MCP["MCP Server (per agent)"]
        MCPServer["<code>mcp-server.ts</code><br/>send_message | trigger_email<br/>schedule_task | list_tasks<br/>pause/resume/cancel_task<br/>get_system_status"]
    end

    User["User Email Client"] -->|"Send [tag] email"| IMAP
    IMAP -->|"Poll every 10s"| EmailChannel
    EmailChannel -->|"Parse tag, store"| DB
    EmailChannel -->|"New message"| MainLoop
    MainLoop -->|"Enqueue by group"| GroupQueue
    GroupQueue -->|"Spawn (max 4)"| OC1 & OC2 & OC3 & OCN
    OC1 & OC2 & OC3 & OCN -->|"Prompt"| Ollama
    OC1 & OC2 & OC3 & OCN -->|"Tool calls"| MCPServer
    MCPServer -->|"IPC files"| IPCWatcher
    IPCWatcher -->|"trigger_email"| EmailChannel
    IPCWatcher -->|"send_message"| Router
    IPCWatcher -->|"schedule_task"| TaskScheduler
    TaskScheduler -->|"Due tasks"| GroupQueue
    Router -->|"Format + send"| SMTP
    SMTP -->|"Notification"| User
    Monitor -->|"HTTP :3700"| User
    AgentTracker -->|"Metrics"| Monitor
    DB -->|"State"| MainLoop & TaskScheduler
```

---

## Multi-Agent Network

Each agent is an isolated OpenCode subprocess with its own group folder, persona (`CLAUDE.md`), and conversation session. Agents communicate exclusively through self-to-self trigger emails.

```mermaid
graph LR
    subgraph Groups["Agent Groups"]
        direction TB
        Global["<b>global/</b><br/>Shared instructions<br/>(all agents inherit)"]

        Main["<b>main/</b> (Admin)<br/>Tag: [ADMIN]<br/>Elevated privileges<br/>Can trigger any group"]

        Research["<b>research/</b><br/>Tag: [RESEARCH]"]
        Content["<b>content/</b><br/>Tag: [CONTENT]"]
        Product["<b>product/</b><br/>Tag: [PRODUCT]"]
        Growth["<b>growth/</b><br/>Tag: [GROWTH]"]
        Ops["<b>ops/</b><br/>Tag: [OPS]"]
        Community["<b>community/</b><br/>Tag: [COMMUNITY]"]
        Social["<b>social/</b><br/>Tag: [SOCIAL]"]
        Family["<b>family/</b><br/>Tag: [FAMILY]"]
    end

    Global -.->|"inherited by"| Main & Research & Content & Product & Growth & Ops & Community & Social & Family

    Main -->|"trigger_email"| Research & Content & Product & Growth & Ops & Community & Social & Family
    Research -->|"trigger_email<br/>(own tag only)"| Research
    Content -->|"trigger_email<br/>(own tag only)"| Content

    style Main fill:#f9d71c,stroke:#333,color:#000
    style Global fill:#e0e0e0,stroke:#666,color:#000
```

### Group Folder Structure

```
groups/
├── global/
│   └── CLAUDE.md          # Shared instructions for ALL agents
├── main/                  # Admin agent (MAIN_TAG)
│   ├── CLAUDE.md          # Admin persona + elevated privileges
│   └── logs/              # Agent execution logs
├── research/
│   ├── CLAUDE.md          # Research persona
│   └── logs/
├── content/
│   ├── CLAUDE.md
│   └── logs/
├── ...                    # product, growth, ops, community, social, family
```

### Agent Privileges

| Capability | Admin (`main`) | Other Groups |
|---|---|---|
| Trigger any group's tag | Yes | No (own tag only) |
| Schedule tasks for other groups | Yes (`target_chat_id`) | No |
| View all scheduled tasks | Yes | Own group only |
| Auto-registered | No (pre-configured) | Yes (on first email) |

---

## Message Flow

Complete lifecycle of an inbound email through the system:

```mermaid
sequenceDiagram
    participant User as User Email
    participant IMAP as IMAP Server
    participant EC as Email Channel
    participant DB as SQLite DB
    participant ML as Main Loop
    participant GQ as GroupQueue
    participant OC as OpenCode Agent
    participant MCP as MCP Server
    participant Ollama as Ollama LLM
    participant SMTP as SMTP Server
    participant Notify as Notification Email

    User->>IMAP: Send email with [TAG] subject

    rect rgb(240, 248, 255)
        Note over EC: Poll every 10s
        EC->>IMAP: imap.search() for new UIDs
        IMAP-->>EC: New message UIDs
        EC->>IMAP: imap.fetchOne(uid)
        IMAP-->>EC: Email content + headers
    end

    EC->>EC: Parse [TAG] from subject
    EC->>EC: Extract X-NanoClaw-Trigger-Depth
    EC->>DB: storeMessage(chatId, content, depth)
    EC->>DB: storeChatMetadata(chatId)

    rect rgb(255, 248, 240)
        Note over ML: Poll every 2s
        ML->>DB: getNewMessages(lastTimestamp)
        DB-->>ML: New messages grouped by chat_id
        ML->>GQ: enqueueMessageCheck(chatId)
    end

    rect rgb(240, 255, 240)
        Note over GQ: Concurrency ≤ MAX_CONCURRENT_AGENTS (4)
        GQ->>GQ: Check activeCount < limit
        GQ->>DB: getMessagesSince(chatId, cursor)
        DB-->>GQ: Messages for group
        GQ->>GQ: formatMessages(messages)
        GQ->>OC: spawn opencode run --format json
    end

    rect rgb(255, 240, 255)
        Note over OC: Agent Execution
        OC->>Ollama: Send prompt + context
        Ollama-->>OC: LLM response stream
        OC->>MCP: Tool calls (optional)
        MCP-->>OC: Tool results
        OC-->>GQ: NDJSON events (text, tool, thinking)
    end

    GQ->>GQ: formatOutbound(response)
    GQ->>EC: sendMessage(chatId, text)
    EC->>SMTP: Send to NOTIFICATION_EMAIL
    SMTP->>Notify: Deliver response
```

---

## Task Scheduling & Management

```mermaid
graph TB
    subgraph Creation["Task Creation"]
        AgentMCP["Agent → MCP<br/><code>schedule_task</code> tool"]
        AgentMCP -->|"IPC file"| IPCWatcher["IPC Watcher<br/><code>ipc.ts</code>"]
        IPCWatcher -->|"createTask()"| DB["SQLite<br/><code>scheduled_tasks</code>"]
    end

    subgraph Scheduling["Task Scheduler Loop (every 30s)"]
        direction TB
        Scheduler["Task Scheduler<br/><code>task-scheduler.ts</code>"]
        Scheduler -->|"getDueTasks()"| DB
        DB -->|"tasks where<br/>next_run ≤ NOW<br/>status = 'active'"| Scheduler
        Scheduler -->|"enqueueTask()"| GQ["GroupQueue"]
    end

    subgraph Execution["Task Execution"]
        GQ -->|"spawn agent"| Agent["OpenCode Agent"]
        Agent -->|"result"| Scheduler
        Scheduler -->|"logTaskRun()"| RunLogs["SQLite<br/><code>task_run_logs</code>"]
        Scheduler -->|"updateTask()<br/>next_run, last_result"| DB
    end

    subgraph Control["Task Control (via MCP)"]
        direction LR
        Pause["pause_task"] -->|"status='paused'"| DB
        Resume["resume_task"] -->|"status='active'"| DB
        Cancel["cancel_task"] -->|"DELETE"| DB
        List["list_tasks"] -->|"read current_tasks.json"| TaskSnap["Task Snapshot<br/><code>data/ipc/{group}/<br/>current_tasks.json</code>"]
    end

    subgraph Dashboard["Monitor Dashboard :3700"]
        ManualTrigger["Manual Trigger<br/>POST /api/trigger/:id"]
        PauseDash["Pause/Resume<br/>POST /api/pause/:id<br/>POST /api/resume/:id"]
        ManualTrigger --> Scheduler
        PauseDash --> DB
    end

    style DB fill:#e8f4fd,stroke:#333
```

### Schedule Types

| Type | `schedule_value` | Example | Behavior |
|---|---|---|---|
| `cron` | Cron expression | `0 9 * * *` | Runs daily at 9am, recalculates `next_run` |
| `interval` | Milliseconds | `3600000` | Runs every hour from `next_run` |
| `once` | ISO timestamp | `2026-03-01T10:00:00` | Runs once, then `status='completed'` |

### Context Modes

| Mode | Behavior |
|---|---|
| `group` | Resumes existing OpenCode session (conversation history preserved) |
| `isolated` | Fresh session per run (no history, all context must be in prompt) |

---

## IPC (Inter-Process Communication)

File-based communication between the host process and agent subprocesses:

```mermaid
graph LR
    subgraph Agent["Agent Subprocess"]
        MCPTool["MCP Tool Call"]
    end

    subgraph FileSystem["data/ipc/{group}/"]
        direction TB
        MsgDir["messages/<br/>{ts}-{rand}.json"]
        TaskDir["tasks/<br/>{ts}-{rand}.json"]
        TaskSnap["current_tasks.json"]
        ErrDir["errors/<br/>{source}_{file}.json"]
    end

    subgraph Host["Host Process"]
        Watcher["IPC Watcher<br/>(polls every 1s)"]
        SendMsg["sendMessage()"]
        TrigEmail["sendSelfEmail()"]
        CreateTask["createTask()"]
        PauseTask["updateTaskStatus()"]
    end

    MCPTool -->|"write temp + rename<br/>(atomic)"| MsgDir & TaskDir
    Watcher -->|"read + delete"| MsgDir & TaskDir

    MsgDir -->|"type: message"| SendMsg
    TaskDir -->|"type: trigger_email"| TrigEmail
    TaskDir -->|"type: schedule_task"| CreateTask
    TaskDir -->|"type: pause/resume/cancel"| PauseTask

    Watcher -->|"on error"| ErrDir

    style FileSystem fill:#fff3e0,stroke:#e65100
```

### IPC File Types

| `type` | Direction | Purpose |
|---|---|---|
| `message` | Agent → Host | Send a message to the user mid-execution |
| `trigger_email` | Agent → Host | Trigger work in another group |
| `schedule_task` | Agent → Host | Create a scheduled task |
| `pause_task` | Agent → Host | Pause a scheduled task |
| `resume_task` | Agent → Host | Resume a paused task |
| `cancel_task` | Agent → Host | Delete a scheduled task |

---

## Trigger System & Loop Protection

```mermaid
sequenceDiagram
    participant User as User
    participant Admin as [admin] Agent<br/>depth=0
    participant Email as Email Channel
    participant Research as [research] Agent<br/>depth=1
    participant Writing as [content] Agent<br/>depth=2
    participant MCP as MCP Server

    User->>Admin: [admin] "Research AI regulation"
    Note over Admin: NANOCLAW_TRIGGER_DEPTH=0

    Admin->>Email: trigger_email(tag:"research",<br/>body:"Deep dive into AI regulation")
    Note over Email: X-NanoClaw-Trigger-Depth: 1

    Email->>Research: Route to [research] group
    Note over Research: NANOCLAW_TRIGGER_DEPTH=1

    Research->>Email: trigger_email(tag:"content",<br/>body:"Compile findings into report")
    Note over Email: X-NanoClaw-Trigger-Depth: 2

    Email->>Writing: Route to [content] group
    Note over Writing: NANOCLAW_TRIGGER_DEPTH=2

    Writing->>MCP: trigger_email(tag:"admin",<br/>body:"Report complete")
    MCP--xWriting: REFUSED: depth >= MAX_TRIGGER_DEPTH (3)

    Note over Writing: Must use send_message instead
```

### Rate Limiting

| Mechanism | Config | Default | Scope |
|---|---|---|---|
| Trigger depth | `MAX_TRIGGER_DEPTH` | 3 | Per chain |
| Cooldown | `TRIGGER_COOLDOWN_MS` | 30s | Per source→target pair |
| Hourly limit | `MAX_TRIGGERS_PER_HOUR` | 120 | Global (all agents) |

---

## Concurrency Model (GroupQueue)

```mermaid
stateDiagram-v2
    [*] --> Idle

    Idle --> Queued: enqueueMessageCheck() /<br/>enqueueTask()

    Queued --> Running: activeCount < MAX (4)
    Queued --> Waiting: activeCount >= MAX (4)

    Waiting --> Running: Slot freed

    Running --> Draining: Agent completes

    Draining --> Running: pendingTasks.length > 0<br/>(tasks first)
    Draining --> Running: pendingMessages == true<br/>(then messages)
    Draining --> Idle: Nothing pending

    Running --> RetryBackoff: Agent fails
    RetryBackoff --> Queued: After delay<br/>(5s × 2^retryCount)
    RetryBackoff --> Idle: retryCount > 5<br/>(drop, wait for next msg)
```

### Drain Priority

1. **Pending tasks** for the same group (FIFO)
2. **Pending messages** for the same group
3. **Waiting groups** (other groups blocked by concurrency limit)

---

## Database Schema

```mermaid
erDiagram
    chats {
        TEXT jid PK "email:tag:{tag}"
        TEXT name
        TEXT last_message_time
    }

    messages {
        TEXT id PK
        TEXT chat_jid FK
        TEXT sender
        TEXT sender_name
        TEXT content
        TEXT timestamp
        INT is_from_me
        INT is_bot_message
        INT trigger_depth
    }

    scheduled_tasks {
        TEXT id PK
        TEXT group_folder
        TEXT chat_jid FK
        TEXT prompt
        TEXT schedule_type "cron | interval | once"
        TEXT schedule_value
        TEXT context_mode "group | isolated"
        TEXT next_run
        TEXT last_run
        TEXT last_result
        TEXT status "active | paused | completed"
        TEXT created_at
    }

    task_run_logs {
        INT id PK "autoincrement"
        TEXT task_id FK
        TEXT run_at
        INT duration_ms
        TEXT status "success | error"
        TEXT result
        TEXT error
    }

    sessions {
        TEXT group_folder PK
        TEXT session_id
    }

    registered_groups {
        TEXT jid PK
        TEXT name
        TEXT folder
        TEXT tag
        TEXT added_at
        INT auto_registered
    }

    email_threads {
        TEXT chat_id PK
        TEXT message_id
        TEXT subject
        TEXT updated_at
    }

    router_state {
        TEXT key PK
        TEXT value "last_timestamp, last_agent_timestamp, email_last_seen_uid"
    }

    activity_log {
        INT id PK "autoincrement"
        TEXT timestamp
        TEXT event_type
        TEXT group_folder
        TEXT summary
        TEXT details_json
        TEXT task_id
    }

    chats ||--o{ messages : "has"
    chats ||--o| email_threads : "threading"
    scheduled_tasks ||--o{ task_run_logs : "execution history"
    registered_groups ||--o| sessions : "conversation"
```

---

## Configuration & Environment

```mermaid
graph TB
    subgraph EnvVars["Configuration Sources"]
        ProcessEnv["process.env"]
        DotEnv[".env file"]
        Defaults["Hardcoded defaults"]
    end

    subgraph ConfigModule["config.ts (precedence order)"]
        direction TB
        C1["1. process.env"]
        C2["2. .env file (readEnvFile)"]
        C3["3. Default values"]
    end

    ProcessEnv --> C1
    DotEnv --> C2
    Defaults --> C3

    subgraph Categories["Config Categories"]
        Identity["Identity<br/>ASSISTANT_NAME"]
        Email["Email<br/>IMAP_HOST, IMAP_PORT<br/>SMTP_HOST, SMTP_PORT<br/>EMAIL_ADDRESS, EMAIL_PASSWORD<br/>NOTIFICATION_EMAIL"]
        Routing["Routing<br/>MAIN_TAG"]
        Models["Models<br/>OPENCODE_MODEL"]
        Agents["Agents<br/>MAX_CONCURRENT_AGENTS<br/>AGENT_TIMEOUT"]
        Triggers["Triggers<br/>MAX_TRIGGER_DEPTH<br/>TRIGGER_COOLDOWN_MS<br/>MAX_TRIGGERS_PER_HOUR"]
        Monitoring["Monitoring<br/>HEARTBEAT_EMAIL<br/>HEARTBEAT_INTERVAL<br/>MONITOR_PORT"]
        Timing["Timing (hardcoded)<br/>POLL_INTERVAL (2s)<br/>EMAIL_POLL_INTERVAL (10s)<br/>SCHEDULER_POLL_INTERVAL (30s)<br/>IPC_POLL_INTERVAL (1s)"]
    end

    ConfigModule --> Categories
```

### OpenCode Configuration

`opencode.json` registers the MCP server so each agent subprocess can call NanoClaw tools:

```json
{
  "mcp": {
    "nanoclaw": {
      "type": "local",
      "command": ["node", "../../dist/mcp-server.js"]
    }
  }
}
```

Environment variables passed to each agent subprocess:

| Variable | Purpose |
|---|---|
| `NANOCLAW_CHAT_ID` | Target chat ID for this invocation |
| `NANOCLAW_GROUP_FOLDER` | Group folder name (e.g., `research`) |
| `NANOCLAW_IS_MAIN` | `'1'` if admin group, else `'0'` |
| `NANOCLAW_TRIGGER_DEPTH` | Current trigger chain depth |

---

## Monitoring & Observability

```mermaid
graph TB
    subgraph Sources["Data Sources"]
        Heartbeat["Heartbeat<br/><code>data/heartbeat.json</code><br/>(written every 5min)"]
        ActivityLog["Activity Log<br/><code>activity_log</code> table<br/>(pruned to 7 days)"]
        AgentTrack["Agent Tracker<br/>In-memory per-agent<br/>events + token metrics"]
        TaskData["Task Data<br/><code>scheduled_tasks</code><br/><code>task_run_logs</code>"]
    end

    subgraph Dashboard["Monitor HTTP Server (:3700)"]
        direction TB
        API1["GET /api/status<br/>Uptime, agents, tasks"]
        API2["GET /api/activity<br/>Paginated event feed"]
        API3["GET /api/task-stats/:id<br/>Task run history"]
        API4["GET /api/agent-output/:group<br/>Live agent events"]
        API5["POST /api/trigger/:id<br/>Manual task trigger"]
        API6["POST /api/pause/:id<br/>POST /api/resume/:id"]
    end

    Heartbeat --> API1
    ActivityLog --> API2
    AgentTrack --> API4
    TaskData --> API3 & API5 & API6

    Dashboard -->|"Self-contained HTML<br/>with polling"| Browser["Browser"]
```

### Activity Event Types

| Event | Logged When |
|---|---|
| `agent_started` | OpenCode agent spawned |
| `agent_completed` | Agent finishes successfully |
| `agent_error` | Agent fails or times out |
| `email_received` | Inbound email parsed |
| `email_sent` | Outbound response delivered |
| `trigger_email_sent` | Cross-group trigger dispatched |
| `task_scheduled_run` | Scheduled task executes |
| `task_manual_trigger` | Dashboard triggers a task |
| `ipc_message_sent` | Agent's send_message delivered |

---

## File & Directory Layout

```
nanoclawf/
├── src/
│   ├── index.ts              # Orchestrator: state, message loop, heartbeat
│   ├── channels/
│   │   └── email.ts          # IMAP polling, SMTP sending, self-trigger emails
│   ├── opencode-client.ts    # Spawns `opencode run`, parses NDJSON output
│   ├── mcp-server.ts         # MCP tool server (runs per agent subprocess)
│   ├── ipc.ts                # IPC watcher, task processing, rate limiting
│   ├── group-queue.ts        # Per-group concurrency control
│   ├── task-scheduler.ts     # Scheduled task polling and execution
│   ├── db.ts                 # SQLite schema, queries, migrations
│   ├── router.ts             # Message formatting, outbound routing
│   ├── agent-tracker.ts      # Live agent event tracking, token metrics
│   ├── monitor.ts            # HTTP dashboard server
│   ├── config.ts             # Configuration loading (.env + defaults)
│   ├── env.ts                # .env file reader
│   └── logger.ts             # Pino logger
├── groups/
│   ├── global/CLAUDE.md      # Instructions inherited by ALL agents
│   ├── main/CLAUDE.md        # Admin agent persona
│   ├── research/CLAUDE.md    # Research agent persona
│   ├── content/CLAUDE.md     # Content agent persona
│   ├── product/CLAUDE.md     # Product agent persona
│   ├── growth/CLAUDE.md      # Growth agent persona
│   ├── ops/CLAUDE.md         # Ops agent persona
│   ├── community/CLAUDE.md   # Community agent persona
│   ├── social/CLAUDE.md      # Social agent persona
│   └── family/CLAUDE.md      # Family agent persona
├── data/
│   ├── ipc/{group}/          # IPC message and task files
│   │   ├── messages/         # send_message IPC files
│   │   ├── tasks/            # trigger/schedule IPC files
│   │   └── current_tasks.json
│   ├── heartbeat.json        # System health snapshot
│   └── errors/               # Failed IPC files
├── store/
│   └── messages.db           # SQLite database
├── opencode.json             # MCP server registration for OpenCode
├── .env                      # Secrets and configuration
├── package.json
└── tsconfig.json
```
