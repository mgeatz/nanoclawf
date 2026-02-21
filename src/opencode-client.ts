import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { AGENT_TIMEOUT, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

export interface AgentEvent {
  type: string;
  text: string;
}

export interface AgentInput {
  groupFolder: string;
  chatId: string;
  isMain: boolean;
  prompt: string;
  sessionId?: string;
  triggerDepth?: number;
  model?: string;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  sessionId?: string;
  error?: string;
}

export async function runOpenCodeAgent(opts: AgentInput): Promise<AgentOutput> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, opts.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const args: string[] = ['run', '--format', 'json'];

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.sessionId) {
    args.push('--session', opts.sessionId, '--continue');
  }

  // Add the prompt as the final argument
  args.push(opts.prompt);

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NANOCLAW_CHAT_ID: opts.chatId,
    NANOCLAW_GROUP_FOLDER: opts.groupFolder,
    NANOCLAW_IS_MAIN: opts.isMain ? '1' : '0',
    NANOCLAW_TRIGGER_DEPTH: String(opts.triggerDepth || 0),
  };

  logger.info(
    {
      group: opts.groupFolder,
      isMain: opts.isMain,
      hasSession: !!opts.sessionId,
      promptLength: opts.prompt.length,
    },
    'Spawning OpenCode agent',
  );

  return new Promise<AgentOutput>((resolve) => {
    const proc = spawn('/Users/nssdemo1/.opencode/bin/opencode', args, {
      cwd: groupDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Emit PID event so the tracker can monitor process stats
    if (opts.onEvent && proc.pid) {
      opts.onEvent({ type: 'pid', text: String(proc.pid) });
    }

    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;

      // Stream parsed events to callback
      if (opts.onEvent) {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || ''; // keep incomplete last line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            const parsed = parseEventForDisplay(event);
            if (parsed) opts.onEvent(parsed);
          } catch {
            // Non-JSON line
            opts.onEvent({ type: 'output', text: trimmed });
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      // Log stderr lines for debugging
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ group: opts.groupFolder }, line);
      }
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      logger.error(
        { group: opts.groupFolder },
        'OpenCode agent timeout, killing process',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, AGENT_TIMEOUT);

    proc.stdin.end();

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Write log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${opts.groupFolder}`,
        `IsMain: ${opts.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Timed Out: ${timedOut}`,
        ``,
        `=== Stderr ===`,
        stderr.slice(-5000),
        ``,
        `=== Stdout ===`,
        stdout.slice(-5000),
      ];
      fs.writeFileSync(logFile, logLines.join('\n'));

      if (timedOut) {
        resolve({
          status: 'error',
          result: null,
          error: `Agent timed out after ${AGENT_TIMEOUT}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: opts.groupFolder, code, duration },
          'OpenCode agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Parse the JSON output from opencode
      try {
        const output = parseOpenCodeOutput(stdout);
        logger.info(
          {
            group: opts.groupFolder,
            duration,
            hasResult: !!output.result,
          },
          'OpenCode agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: opts.groupFolder, err, stdout: stdout.slice(-500) },
          'Failed to parse OpenCode output',
        );
        // Fall back to raw stdout as the result
        const trimmed = stdout.trim();
        resolve({
          status: 'success',
          result: trimmed || null,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: opts.groupFolder, err },
        'OpenCode spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Spawn error: ${err.message}`,
      });
    });
  });
}

function parseOpenCodeOutput(stdout: string): AgentOutput {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { status: 'success', result: null };
  }

  // OpenCode --format json outputs newline-delimited JSON events (NDJSON).
  // Each line is a JSON object with a "type" field.
  // We extract text from "text" events and sessionID from any event.
  const lines = trimmed.split('\n');
  const textParts: string[] = [];
  let sessionId: string | undefined;

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) continue;

    try {
      const event = JSON.parse(stripped);

      // Capture session ID from any event that has it
      if (!sessionId && event.sessionID) {
        sessionId = event.sessionID;
      }

      // Extract text content from "text" type events
      if (event.type === 'text' && event.part?.text) {
        textParts.push(event.part.text);
      }
    } catch {
      // Non-JSON line — include as plain text
      textParts.push(stripped);
    }
  }

  const result = textParts.join('').trim() || null;
  return { status: 'success', result, sessionId };
}

/**
 * Parse an OpenCode NDJSON event into a display-friendly summary.
 */
function parseEventForDisplay(event: Record<string, unknown>): AgentEvent | null {
  const type = String(event.type || 'unknown');

  // Assistant text output
  if (type === 'text' && event.part && typeof event.part === 'object') {
    const part = event.part as Record<string, unknown>;
    if (part.text) return { type: 'text', text: String(part.text) };
  }

  // Tool use
  if (type === 'tool_call' || type === 'tool_use') {
    const name = event.name || event.tool || 'tool';
    return { type: 'tool', text: String(name) };
  }

  // Tool result
  if (type === 'tool_result') {
    const name = event.name || event.tool || 'tool';
    return { type: 'tool_result', text: String(name) };
  }

  // Thinking / reasoning
  if (type === 'thinking' || type === 'reasoning') {
    const part = event.part as Record<string, unknown> | undefined;
    const text = part?.text || event.text || '';
    if (text) return { type: 'thinking', text: String(text).slice(0, 500) };
  }

  // Session start
  if (type === 'session.start' || type === 'session') {
    return { type: 'status', text: 'Session started' };
  }

  // Skip noise events
  if (type === 'ping' || type === 'heartbeat') return null;

  // Generic fallback for any other event type
  if (event.message || event.text) {
    return { type, text: String(event.message || event.text).slice(0, 300) };
  }

  return { type: 'status', text: type };
}
