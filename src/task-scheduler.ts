import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logActivity,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { runOpenCodeAgent } from './opencode-client.js';
import { registerAgent, unregisterAgent, addAgentEvent } from './agent-tracker.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

/**
 * Write filtered tasks to the group's IPC directory for the agent to read via list_tasks.
 */
function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    return new Date(Date.now() + ms).toISOString();
  }
  return null;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Immediately advance next_run so the scheduler doesn't re-enqueue this task
  const nextRun = computeNextRun(task);
  if (nextRun) {
    updateTask(task.id, { next_run: nextRun });
  }

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );
  logActivity({
    event_type: 'task_scheduled_run',
    group_folder: task.group_folder,
    summary: `Task "${task.id}" started for [${task.group_folder}]`,
    details: { promptPreview: task.prompt.slice(0, 200) },
    task_id: task.id,
  });

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for agent to read
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const allTasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    allTasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  const groupModel = group.model;

  registerAgent(task.group_folder, {
    chatId: task.chat_id,
    groupFolder: task.group_folder,
    startedAt: startTime,
    taskId: task.id,
    prompt: task.prompt.slice(0, 200),
    model: groupModel,
  });

  try {
    const output = await runOpenCodeAgent({
      groupFolder: task.group_folder,
      chatId: task.chat_id,
      isMain,
      prompt: task.prompt,
      sessionId,
      model: groupModel,
      onEvent: (event) => addAgentEvent(task.group_folder, { time: Date.now(), ...event }),
    });

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
      // Task output is NOT auto-emailed. Agents use send_message with priority.
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });
  logActivity({
    event_type: error ? 'agent_error' : 'agent_completed',
    group_folder: task.group_folder,
    summary: error
      ? `Task "${task.id}" failed: ${error.slice(0, 100)}`
      : `Task "${task.id}" completed in ${(durationMs / 1000).toFixed(1)}s`,
    details: { durationMs, resultPreview: result?.slice(0, 300), error },
    task_id: task.id,
  });

  unregisterAgent(task.group_folder);

  // Recompute next_run from NOW (so the interval starts after completion, not from when we started)
  const finalNextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, finalNextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();

      let enqueued = 0;
      for (const task of dueTasks) {
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        const wasEnqueued = deps.queue.enqueueTask(
          currentTask.chat_id,
          currentTask.id,
          () => runTask(currentTask, deps),
        );
        if (wasEnqueued) enqueued++;
      }

      if (enqueued > 0) {
        logger.info({ enqueued, due: dueTasks.length }, 'Enqueued due tasks');
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
