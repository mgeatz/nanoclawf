import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DIGEST_INTERVAL_MS,
  MAIN_GROUP_FOLDER,
  MAIN_TAG,
  POLL_INTERVAL,
} from './config.js';
import { EmailChannel } from './channels/email.js';
import { runOpenCodeAgent, AgentOutput } from './opencode-client.js';
import {
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getAndClearDigestQueue,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  logActivity,
  pruneActivityLog,
  queueDigestMessage,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { startMonitor } from './monitor.js';
import { NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  registerAgent,
  unregisterAgent,
  addAgentEvent,
  getActiveAgents,
} from './agent-tracker.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let emailChannel: EmailChannel;
const queue = new GroupQueue();
const startupTime = Date.now();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(chatId: string, group: RegisteredGroup): void {
  registeredGroups[chatId] = group;
  setRegisteredGroup(chatId, group);

  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { chatId, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Auto-register a new group from an email tag.
 */
function autoRegisterTag(tag: string, chatId: string): void {
  const isAdmin = tag.toUpperCase() === MAIN_TAG;
  const folder = isAdmin ? MAIN_GROUP_FOLDER : tag;
  const name = isAdmin ? 'Admin' : tag;

  registerGroup(chatId, {
    name,
    folder,
    tag,
    added_at: new Date().toISOString(),
    autoRegistered: true,
  });
}

/**
 * Process all pending messages for a group.
 */
async function processGroupMessages(chatId: string): Promise<boolean> {
  const group = registeredGroups[chatId];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatId] || '';
  const missedMessages = getMessagesSince(chatId, sinceTimestamp);

  if (missedMessages.length === 0) return true;

  const prompt = formatMessages(missedMessages);

  // Advance cursor
  const previousCursor = lastAgentTimestamp[chatId] || '';
  lastAgentTimestamp[chatId] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  const sessionId = sessions[group.folder];

  // Compute max trigger depth from messages (for loop protection)
  const maxTriggerDepth = missedMessages.reduce(
    (max, m) => Math.max(max, m.triggerDepth || 0),
    0,
  );

  const agentStartedAt = Date.now();
  registerAgent(group.folder, {
    chatId,
    groupFolder: group.folder,
    startedAt: agentStartedAt,
    prompt: prompt.slice(0, 200),
    model: group.model,
  });
  logActivity({
    event_type: 'agent_started',
    group_folder: group.folder,
    summary: `Agent [${group.tag}] processing ${missedMessages.length} message(s)`,
    details: { messageCount: missedMessages.length, promptPreview: prompt.slice(0, 200) },
  });
  try {
    const output = await runOpenCodeAgent({
      groupFolder: group.folder,
      chatId,
      isMain: isMainGroup,
      prompt,
      sessionId,
      triggerDepth: maxTriggerDepth,
      model: group.model,
      onEvent: (event) => addAgentEvent(group.folder, { time: Date.now(), ...event }),
    });

    if (output.sessionId) {
      sessions[group.folder] = output.sessionId;
      setSession(group.folder, output.sessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Agent error',
      );
      logActivity({
        event_type: 'agent_error',
        group_folder: group.folder,
        summary: `Agent [${group.tag}] error: ${(output.error || 'unknown').slice(0, 100)}`,
        details: { error: output.error },
      });
      // Roll back cursor for retry
      lastAgentTimestamp[chatId] = previousCursor;
      saveState();
      return false;
    }

    const durationMs = Date.now() - agentStartedAt;

    // Send result to user via email — only for user-initiated messages (not triggers)
    if (output.result) {
      const text = formatOutbound(output.result);
      if (text && maxTriggerDepth === 0) {
        await emailChannel.sendMessage(chatId, text);
      }
    }

    logActivity({
      event_type: 'agent_completed',
      group_folder: group.folder,
      summary: `Agent [${group.tag}] completed in ${(durationMs / 1000).toFixed(1)}s`,
      details: { durationMs, resultPreview: output.result?.slice(0, 300) },
    });

    return true;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    logActivity({
      event_type: 'agent_error',
      group_folder: group.folder,
      summary: `Agent [${group.tag}] exception: ${err instanceof Error ? err.message.slice(0, 100) : 'unknown'}`,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    lastAgentTimestamp[chatId] = previousCursor;
    saveState();
    return false;
  } finally {
    unregisterAgent(group.folder);
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (email mode, main tag: [${MAIN_TAG}])`);

  while (true) {
    try {
      const chatIds = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(chatIds, lastTimestamp);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_id);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_id, [msg]);
          }
        }

        for (const [chatId] of messagesByGroup) {
          const group = registeredGroups[chatId];
          if (!group) continue;

          // All self-to-self emails are intentional — no trigger check needed
          queue.enqueueMessageCheck(chatId);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 */
function recoverPendingMessages(): void {
  for (const [chatId, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatId] || '';
    const pending = getMessagesSince(chatId, sinceTimestamp);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatId);
    }
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await emailChannel.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create email channel
  emailChannel = new EmailChannel({
    onMessage: (chatId, msg) => storeMessage(msg),
    onChatMetadata: (chatId, timestamp) => storeChatMetadata(chatId, timestamp),
    registeredGroups: () => registeredGroups,
    onNewTag: (tag, chatId) => autoRegisterTag(tag, chatId),
  });

  // Connect to IMAP/SMTP
  await emailChannel.connect();

  // Start subsystems
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    sendMessage: async (chatId, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await emailChannel.sendMessage(chatId, text);
    },
  });
  startIpcWatcher({
    sendMessage: (chatId, text) => emailChannel.sendMessage(chatId, text),
    queueDigest: (chatId, groupFolder, text) =>
      queueDigestMessage(chatId, groupFolder, text),
    sendTriggerEmail: (subject, body, depth) =>
      emailChannel.sendSelfEmail(subject, body, depth),
    registeredGroups: () => registeredGroups,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Start heartbeat writer (every 5 minutes)
  const heartbeatFile = path.join(DATA_DIR, 'heartbeat.json');
  const writeHeartbeat = () => {
    const heartbeat = {
      alive: true,
      timestamp: new Date().toISOString(),
      uptime_ms: Date.now() - startupTime,
      imap_connected: emailChannel.isConnected(),
      registered_groups: Object.keys(registeredGroups).length,
      active_tasks: getAllTasks().filter((t) => t.status === 'active').length,
      active_agents: Object.keys(getActiveAgents()).length,
    };
    fs.mkdirSync(path.dirname(heartbeatFile), { recursive: true });
    fs.writeFileSync(heartbeatFile, JSON.stringify(heartbeat, null, 2));
  };
  writeHeartbeat();
  setInterval(writeHeartbeat, 5 * 60 * 1000);

  // Digest email sender — batches digest-priority messages into periodic emails
  const sendDigest = async () => {
    try {
      const items = getAndClearDigestQueue();
      if (items.length === 0) return;

      // Group by agent folder
      const byGroup = new Map<string, string[]>();
      for (const item of items) {
        const existing = byGroup.get(item.group_folder);
        if (existing) {
          existing.push(item.text);
        } else {
          byGroup.set(item.group_folder, [item.text]);
        }
      }

      // Format digest email
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      const sections: string[] = [`NANOCLAW DIGEST - ${dateStr}`, ''];

      for (const [folder, texts] of byGroup) {
        const group = Object.values(registeredGroups).find(
          (g) => g.folder === folder,
        );
        const label = group ? `[${group.tag}] ${group.name}` : `[${folder}]`;
        sections.push(`${label}:`);
        for (const text of texts) {
          // Indent each message, truncate long ones
          const preview = text.length > 500 ? text.slice(0, 500) + '...' : text;
          sections.push(`- ${preview}`);
        }
        sections.push('');
      }

      const digestText = sections.join('\n');

      // Send to the first chat_id found (they all share the same NOTIFICATION_EMAIL)
      const chatId = items[0].chat_id;
      await emailChannel.sendMessage(chatId, digestText);

      logger.info(
        { itemCount: items.length, groupCount: byGroup.size },
        'Digest email sent',
      );
      logActivity({
        event_type: 'digest_sent',
        summary: `Digest sent: ${items.length} messages from ${byGroup.size} agent(s)`,
        details: { itemCount: items.length, groups: [...byGroup.keys()] },
      });
    } catch (err) {
      logger.error({ err }, 'Error sending digest');
    }
  };
  setInterval(sendDigest, DIGEST_INTERVAL_MS);
  logger.info(
    { intervalMs: DIGEST_INTERVAL_MS },
    'Digest sender started',
  );

  // Prune activity log daily (keep 7 days)
  setInterval(() => pruneActivityLog(7), 24 * 60 * 60 * 1000);

  // Start status dashboard
  startMonitor({ activeAgents: getActiveAgents });

  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
