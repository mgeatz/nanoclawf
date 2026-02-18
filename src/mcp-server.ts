/**
 * Host-side MCP Server for NanoClaw
 * Runs as a child process of OpenCode, communicates via stdio.
 * Reads context from environment variables, writes IPC files for the host orchestrator.
 */
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DATA_DIR = path.resolve(process.cwd(), '..', '..', 'data');
const chatId = process.env.NANOCLAW_CHAT_ID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const triggerDepth = parseInt(process.env.NANOCLAW_TRIGGER_DEPTH || '0', 10);
const MAX_TRIGGER_DEPTH = parseInt(process.env.MAX_TRIGGER_DEPTH || '3', 10);

const IPC_DIR = path.join(DATA_DIR, 'ipc', groupFolder);
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '2.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user immediately while you're still running. Use this for progress updates or to send multiple messages. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate.",
  {
    text: z.string().describe('The message text to send'),
  },
  async (args) => {
    const data = {
      type: 'message',
      chatId,
      text: args.text,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'trigger_email',
  `Send a self-to-self email to trigger work in any group. The email will be picked up by NanoClaw's IMAP poller and routed to the group matching the tag.

Use cases:
- Cross-group communication: trigger work in another group's context
- Workflow chaining: send next step to yourself after completing current step
- Deferred work: queue up a task for later processing

IMPORTANT: Do NOT use this in a loop. If your prompt was triggered by a trigger_email, do NOT send another trigger_email to the same tag unless explicitly instructed by the user.`,
  {
    tag: z.string().describe('The group tag (e.g., "family", "work", "ADMIN"). Case insensitive.'),
    subject_suffix: z.string().optional().describe('Optional text after [tag] in subject. Default: "Agent Trigger"'),
    body: z.string().describe('The email body — this becomes the prompt for the target group agent'),
  },
  async (args) => {
    if (triggerDepth >= MAX_TRIGGER_DEPTH) {
      return {
        content: [{ type: 'text' as const, text: `Trigger depth limit reached (${triggerDepth}/${MAX_TRIGGER_DEPTH}). Cannot send trigger_email to prevent infinite loops.` }],
        isError: true,
      };
    }

    const data = {
      type: 'trigger_email',
      tag: args.tag,
      subject: `[${args.tag}] ${args.subject_suffix || 'Agent Trigger'}`,
      body: args.body,
      sourceGroup: groupFolder,
      isMain,
      triggerDepth,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Trigger email queued: [${args.tag}] ${args.subject_suffix || 'Agent Trigger'}` }],
    };
  },
);

server.tool(
  'get_system_status',
  'Get NanoClaw system status: uptime, IMAP connection, active groups, pending tasks.',
  {},
  async () => {
    const heartbeatFile = path.join(DATA_DIR, 'heartbeat.json');
    try {
      if (!fs.existsSync(heartbeatFile)) {
        return { content: [{ type: 'text' as const, text: 'System status not available yet.' }] };
      }
      const status = fs.readFileSync(heartbeatFile, 'utf-8');
      return { content: [{ type: 'text' as const, text: status }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading status: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
• "group": Task runs in the group's conversation context, with access to chat history.
• "isolated": Task runs in a fresh session. Include all necessary context in the prompt.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "0 9 * * *" for daily at 9am)
• interval: Milliseconds between runs (e.g., "3600000" for 1 hour)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00")`,
  {
    prompt: z.string().describe('What the agent should do when the task runs'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string().describe('cron expression, interval ms, or timestamp'),
    context_mode: z.enum(['group', 'isolated']).default('group'),
    target_chat_id: z.string().optional().describe('(Main only) Chat ID to schedule for. Defaults to current.'),
  },
  async (args) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const targetChatId = isMain && args.target_chat_id ? args.target_chat_id : chatId;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetChatId,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. Main sees all tasks; other groups see only their own.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
