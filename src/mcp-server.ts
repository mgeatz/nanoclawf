/**
 * Host-side MCP Server for NanoClaw
 * Runs as a child process of OpenCode, communicates via stdio.
 * Reads context from environment variables, writes IPC files for the host orchestrator.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PROJECT_ROOT = path.resolve(process.cwd(), '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
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
  `Send a message to the user. Priority controls delivery:
- "notify": Immediate email — use for approvals needed, alerts, errors, direct answers to user questions
- "digest": Batched into a periodic digest email (default) — use for status updates, routine reports, scheduled task summaries
- "log": Stored in activity log only, no email — use for "nothing new" check-ins, internal notes

When running as a scheduled task, your final output is NOT sent to the user automatically. Use this tool with the appropriate priority.`,
  {
    text: z.string().describe('The message text to send'),
    priority: z
      .enum(['notify', 'digest', 'log'])
      .default('digest')
      .describe('Delivery priority: notify (immediate email), digest (batched), log (no email)'),
  },
  async (args) => {
    const data = {
      type: 'message',
      chatId,
      text: args.text,
      priority: args.priority || 'digest',
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    const label =
      args.priority === 'notify'
        ? 'Message sent (immediate email).'
        : args.priority === 'log'
          ? 'Message logged (no email).'
          : 'Message queued for digest.';
    return { content: [{ type: 'text' as const, text: label }] };
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
  'get_activity_log',
  'Get recent activity log entries showing what all agents have been doing. (Main only) Filter by agent or event type to review specific agent performance.',
  {
    agent: z.string().optional().describe('Filter by agent group folder (e.g., "content", "research", "social")'),
    event_type: z.string().optional().describe('Filter by event type (e.g., "agent_completed", "trigger_email_sent", "agent_error")'),
    limit: z.number().optional().default(50).describe('Max entries to return (default 50)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Activity log access is restricted to admin.' }] };
    }
    const activityFile = path.join(DATA_DIR, 'activity_recent.json');
    try {
      if (!fs.existsSync(activityFile)) {
        return { content: [{ type: 'text' as const, text: 'No activity data available yet.' }] };
      }
      let entries = JSON.parse(fs.readFileSync(activityFile, 'utf-8')) as Array<{
        id: number; timestamp: string; event_type: string; group_folder: string | null;
        summary: string; details_json: string | null; task_id: string | null;
      }>;
      if (args.agent) {
        entries = entries.filter(e => e.group_folder === args.agent);
      }
      if (args.event_type) {
        entries = entries.filter(e => e.event_type === args.event_type);
      }
      entries = entries.slice(0, args.limit || 50);
      if (entries.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching activity entries found.' }] };
      }
      const formatted = entries.map(e => {
        let line = `[${e.timestamp}] ${e.event_type} [${e.group_folder || 'system'}] ${e.summary}`;
        if (e.details_json) {
          try {
            const d = JSON.parse(e.details_json);
            if (d.textPreview) line += `\n  Preview: ${d.textPreview}`;
            if (d.bodyPreview) line += `\n  Body: ${d.bodyPreview}`;
            if (d.subject) line += `\n  Subject: ${d.subject}`;
            if (d.targetTag) line += `\n  Target: [${d.targetTag}]`;
            if (d.sourceGroup) line += `\n  Source: [${d.sourceGroup}]`;
            if (d.error) line += `\n  Error: ${d.error}`;
          } catch { /* ignore */ }
        }
        return line;
      }).join('\n\n');
      return { content: [{ type: 'text' as const, text: `Recent activity (${entries.length} entries):\n\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading activity log: ${err instanceof Error ? err.message : String(err)}` }],
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

// --- Web Search (Perplexity AI via browser automation) ---

server.tool(
  'web_search',
  `Search the web using Perplexity AI. Opens Perplexity in the default browser, waits for the AI-generated answer, and returns the result.
Use this to research topics, find current information, and answer questions about trends, news, tools, etc.`,
  {
    query: z.string().describe('Search query (e.g. "startup funding news 2026", "latest Y Combinator batch startups")'),
  },
  async (args) => {
    try {
      const encodedQuery = encodeURIComponent(args.query);
      const searchURL = `https://www.perplexity.ai/search/new?q=${encodedQuery}`;
      const scriptPath = path.join(SCRIPTS_DIR, 'web-search-perplexity.applescript');

      const result = await new Promise<string>((resolve, reject) => {
        execFile('osascript', [scriptPath, searchURL], { timeout: 90000 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout.trim());
        });
      });

      if (result === 'NO_CONTENT_FOUND' || result === '0' || result === '') {
        return {
          content: [{ type: 'text' as const, text: `No results found for: "${args.query}". The page may not have loaded properly. If using Safari, ensure Develop > Allow JavaScript from Apple Events is enabled.` }],
        };
      }

      if (result.startsWith('ERROR:')) {
        return {
          content: [{ type: 'text' as const, text: result }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Perplexity AI results for "${args.query}":\n\n${result}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Search error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const SUPPORTED_PLATFORMS = ['twitter', 'linkedin', 'reddit', 'reddit_dm'] as const;

server.tool(
  'post_to_social',
  `Post content to a social media platform using macOS browser automation (AppleScript).

IMPORTANT: Only use this AFTER the user has explicitly approved a draft. Never post without approval.

Requirements:
- Twitter/X: User must be logged in via their default browser. Requires macOS Accessibility permission. If "url" is provided, replies to that tweet instead of composing a new one.
- LinkedIn: User must be logged in via Safari. Requires Safari > Develop > Allow JavaScript from Apple Events.
- Reddit: User must be logged in via their default browser. Requires the "url" parameter with the Reddit post URL.
- Reddit DM: User must be logged in via their default browser. The "url" parameter should be the target username (without u/).

The tool opens the platform in the browser, pastes the content, and submits the post.`,
  {
    platform: z.enum(SUPPORTED_PLATFORMS).describe('Target platform: "twitter", "linkedin", "reddit", or "reddit_dm"'),
    text: z.string().describe('The post content text'),
    url: z.string().optional().describe('Target URL — required for reddit comments (post URL), reddit_dm (target username)'),
  },
  async (args) => {
    if (args.platform === 'reddit' && !args.url) {
      return {
        content: [{ type: 'text' as const, text: 'Reddit comments require the "url" parameter with the post URL.' }],
        isError: true,
      };
    }

    if (args.platform === 'reddit_dm' && !args.url) {
      return {
        content: [{ type: 'text' as const, text: 'Reddit DMs require the "url" parameter with the target username.' }],
        isError: true,
      };
    }

    // Determine which AppleScript to run
    let scriptFile: string;
    const isTwitterReply = args.platform === 'twitter' && args.url &&
      /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i.test(args.url);
    if (isTwitterReply) {
      scriptFile = 'post-twitter-reply.applescript';
    } else if (args.platform === 'reddit_dm') {
      scriptFile = 'post-reddit-dm.applescript';
    } else {
      scriptFile = `post-${args.platform}.applescript`;
    }
    const scriptPath = path.join(SCRIPTS_DIR, scriptFile);

    if (!fs.existsSync(scriptPath)) {
      return {
        content: [{ type: 'text' as const, text: `No posting script found for platform "${args.platform}".` }],
        isError: true,
      };
    }

    try {
      const scriptArgs = [scriptPath, args.text];
      // Only pass URL as script arg for reply/reddit scripts, not for twitter compose
      if (args.url && !(args.platform === 'twitter' && !isTwitterReply)) {
        scriptArgs.push(args.url);
      }

      const result = await new Promise<string>((resolve, reject) => {
        execFile('osascript', scriptArgs, { timeout: 45000 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stdout.trim());
        });
      });

      if (result.startsWith('ERROR:')) {
        return {
          content: [{ type: 'text' as const, text: result }],
          isError: true,
        };
      }

      if (result.startsWith('UNVERIFIED:')) {
        return {
          content: [{ type: 'text' as const, text: `WARNING: ${result}. Do NOT report this as successfully posted. Ask the user to verify manually.` }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Posted to ${args.platform}: ${result}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to post to ${args.platform}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
