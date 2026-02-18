import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Mock config
vi.mock('./config.js', () => ({
  AGENT_TIMEOUT: 1800000,
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.killed = false;
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
  };
});

import { runOpenCodeAgent, AgentOutput } from './opencode-client.js';

describe('opencode-client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns success with plain text output', async () => {
    const resultPromise = runOpenCodeAgent({
      groupFolder: 'test-group',
      chatId: 'email:tag:test',
      isMain: false,
      prompt: 'Hello',
    });

    // Emit plain text output
    fakeProc.stdout.push('Here is my response');
    fakeProc.stdout.push(null);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.result).toBe('Here is my response');
  });

  it('returns success with JSON output', async () => {
    const resultPromise = runOpenCodeAgent({
      groupFolder: 'test-group',
      chatId: 'email:tag:test',
      isMain: false,
      prompt: 'Hello',
    });

    // OpenCode --format json outputs newline-delimited JSON events
    const events = [
      JSON.stringify({ type: 'step_start', sessionID: 'sess-123', part: {} }),
      JSON.stringify({ type: 'text', sessionID: 'sess-123', part: { text: 'Response from agent' } }),
      JSON.stringify({ type: 'step_finish', sessionID: 'sess-123', part: {} }),
    ].join('\n');
    fakeProc.stdout.push(events);
    fakeProc.stdout.push(null);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.result).toBe('Response from agent');
    expect(result.sessionId).toBe('sess-123');
  });

  it('returns error on non-zero exit code', async () => {
    const resultPromise = runOpenCodeAgent({
      groupFolder: 'test-group',
      chatId: 'email:tag:test',
      isMain: false,
      prompt: 'Hello',
    });

    fakeProc.stderr.push('some error');
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('exited with code 1');
  });

  it('returns error on timeout', async () => {
    const resultPromise = runOpenCodeAgent({
      groupFolder: 'test-group',
      chatId: 'email:tag:test',
      isMain: false,
      prompt: 'Hello',
    });

    // Advance past timeout (1800000ms)
    await vi.advanceTimersByTimeAsync(1800000);

    // Process should have been killed, emit close
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
  });

  it('handles spawn error', async () => {
    const resultPromise = runOpenCodeAgent({
      groupFolder: 'test-group',
      chatId: 'email:tag:test',
      isMain: false,
      prompt: 'Hello',
    });

    fakeProc.emit('error', new Error('spawn ENOENT'));
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('spawn ENOENT');
  });

  it('returns null result for empty output', async () => {
    const resultPromise = runOpenCodeAgent({
      groupFolder: 'test-group',
      chatId: 'email:tag:test',
      isMain: false,
      prompt: 'Hello',
    });

    fakeProc.stdout.push(null);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.result).toBeNull();
  });
});
