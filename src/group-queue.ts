import { MAX_CONCURRENT_AGENTS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  chatId: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((chatId: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(chatId: string): GroupState {
    let state = this.groups.get(chatId);
    if (!state) {
      state = {
        active: false,
        pendingMessages: false,
        pendingTasks: [],
        retryCount: 0,
      };
      this.groups.set(chatId, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (chatId: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(chatId: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(chatId);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ chatId }, 'Agent active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_AGENTS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(chatId)) {
        this.waitingGroups.push(chatId);
      }
      logger.debug(
        { chatId, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(chatId, 'messages');
  }

  enqueueTask(chatId: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(chatId);

    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ chatId, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, chatId, fn });
      logger.debug({ chatId, taskId }, 'Agent active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_AGENTS) {
      state.pendingTasks.push({ id: taskId, chatId, fn });
      if (!this.waitingGroups.includes(chatId)) {
        this.waitingGroups.push(chatId);
      }
      logger.debug(
        { chatId, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    this.runTask(chatId, { id: taskId, chatId, fn });
  }

  private async runForGroup(
    chatId: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(chatId);
    state.active = true;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { chatId, reason, activeCount: this.activeCount },
      'Starting agent for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(chatId);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(chatId, state);
        }
      }
    } catch (err) {
      logger.error({ chatId, err }, 'Error processing messages for group');
      this.scheduleRetry(chatId, state);
    } finally {
      state.active = false;
      this.activeCount--;
      this.drainGroup(chatId);
    }
  }

  private async runTask(chatId: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(chatId);
    state.active = true;
    this.activeCount++;

    logger.debug(
      { chatId, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ chatId, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      this.activeCount--;
      this.drainGroup(chatId);
    }
  }

  private scheduleRetry(chatId: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { chatId, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { chatId, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(chatId);
      }
    }, delayMs);
  }

  private drainGroup(chatId: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(chatId);

    // Tasks first
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(chatId, task);
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(chatId, 'drain');
      return;
    }

    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_AGENTS
    ) {
      const nextId = this.waitingGroups.shift()!;
      const state = this.getGroup(nextId);

      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextId, task);
      } else if (state.pendingMessages) {
        this.runForGroup(nextId, 'drain');
      }
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;
    logger.info(
      { activeCount: this.activeCount },
      'GroupQueue shutting down',
    );
  }
}
