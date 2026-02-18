import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  MAX_CONCURRENT_AGENTS: 2,
}));

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one agent per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (chatId: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('email:tag:family');
    queue.enqueueMessageCheck('email:tag:family');

    await vi.advanceTimersByTimeAsync(200);

    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (chatId: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('email:tag:family');
    queue.enqueueMessageCheck('email:tag:work');
    queue.enqueueMessageCheck('email:tag:admin');

    await vi.advanceTimersByTimeAsync(10);

    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (chatId: string) => {
      if (executionOrder.length === 0) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('email:tag:family');
    await vi.advanceTimersByTimeAsync(10);

    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('email:tag:family', 'task-1', taskFn);
    queue.enqueueMessageCheck('email:tag:family');

    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    expect(executionOrder[0]).toBe('messages');
    expect(executionOrder[1]).toBe('task');
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('email:tag:family');

    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('email:tag:family');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('email:tag:family');

    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000);
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (chatId: string) => {
      processed.push(chatId);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('email:tag:family');
    queue.enqueueMessageCheck('email:tag:work');
    await vi.advanceTimersByTimeAsync(10);

    queue.enqueueMessageCheck('email:tag:admin');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['email:tag:family', 'email:tag:work']);

    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('email:tag:admin');
  });
});
