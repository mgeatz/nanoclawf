/**
 * Shared active agent tracking with streaming event capture.
 * Used by both index.ts (message-triggered) and task-scheduler.ts (scheduled tasks)
 * so the dashboard can see all running agents and their live output.
 */

export interface AgentEvent {
  time: number;
  type: string;
  text: string;
}

export interface ActiveAgent {
  chatId: string;
  groupFolder: string;
  startedAt: number;
  taskId?: string;
  prompt: string;
  model?: string;
  pid: number | null;
  events: AgentEvent[];
  tokenCount: number;
  firstTokenAt: number | null;
  lastTokenAt: number | null;
}

const agents: Record<string, ActiveAgent> = {};

const MAX_EVENTS = 200;

export function registerAgent(
  groupFolder: string,
  info: Omit<ActiveAgent, 'events' | 'tokenCount' | 'firstTokenAt' | 'lastTokenAt' | 'pid'>,
): void {
  agents[groupFolder] = {
    ...info,
    pid: null,
    events: [],
    tokenCount: 0,
    firstTokenAt: null,
    lastTokenAt: null,
  };
}

export function setAgentPid(groupFolder: string, pid: number): void {
  const agent = agents[groupFolder];
  if (agent) agent.pid = pid;
}

export function unregisterAgent(groupFolder: string): void {
  delete agents[groupFolder];
}

export function addAgentEvent(
  groupFolder: string,
  event: AgentEvent,
): void {
  const agent = agents[groupFolder];
  if (!agent) return;
  agent.events.push(event);
  if (agent.events.length > MAX_EVENTS) {
    agent.events = agent.events.slice(-MAX_EVENTS);
  }

  // Track token output for text events (~4 chars per token approximation)
  if (event.type === 'text' && event.text) {
    const approxTokens = Math.ceil(event.text.length / 4);
    agent.tokenCount += approxTokens;
    const now = event.time;
    if (!agent.firstTokenAt) agent.firstTokenAt = now;
    agent.lastTokenAt = now;
  }
}

export function getActiveAgents(): Record<string, ActiveAgent> {
  return agents;
}

export function getAgentEvents(groupFolder: string): AgentEvent[] {
  return agents[groupFolder]?.events || [];
}

export function getAgentTokensPerSec(groupFolder: string): number | null {
  const agent = agents[groupFolder];
  if (!agent || !agent.firstTokenAt || !agent.lastTokenAt) return null;
  const elapsed = (agent.lastTokenAt - agent.firstTokenAt) / 1000;
  if (elapsed < 1) return null;
  return Math.round(agent.tokenCount / elapsed);
}
