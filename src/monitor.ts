/**
 * Localhost status dashboard for NanoClaw.
 * Serves a self-contained HTML page on MONITOR_PORT.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { AGENT_TIMEOUT, DATA_DIR, MONITOR_PORT, GROUPS_DIR, TIMEZONE } from './config.js';
import {
  computeCollaborationScore,
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getActivityLog,
  getAdminActivity,
  getCollaborationMetrics,
  getCollaborationTrend,
  getTaskById,
  getTaskRunStats,
  logActivity,
  updateTask,
} from './db.js';
import { getTriggerCountThisHour } from './ipc.js';
import { logger } from './logger.js';
import {
  getActiveAgents,
  getAgentEvents,
  getAgentTokensPerSec,
} from './agent-tracker.js';

export interface MonitorState {
  activeAgents: () => Record<
    string,
    {
      chatId: string;
      startedAt: number;
      taskId?: string;
      prompt: string;
      model?: string;
      tokenCount: number;
      pid: number | null;
    }
  >;
}

const startTime = Date.now();

export function startMonitor(state: MonitorState): void {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStatus(state)));
      return;
    }

    // Activity feed endpoint
    if (req.url?.startsWith('/api/activity')) {
      const urlObj = new URL(req.url, 'http://localhost');
      const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      const offset = parseInt(urlObj.searchParams.get('offset') || '0', 10);
      const eventType = urlObj.searchParams.get('type') || undefined;
      const since = urlObj.searchParams.get('since') || undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getActivityLog(limit, offset, eventType, since)));
      return;
    }

    // Process stats endpoint
    if (req.url === '/api/process-stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getProcessStats(state)));
      return;
    }

    // Task stats endpoint
    const statsMatch = req.url?.match(/^\/api\/task-stats\/(.+)$/);
    if (statsMatch) {
      const taskId = decodeURIComponent(statsMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getTaskRunStats(taskId)));
      return;
    }

    // Agent live output endpoint
    const agentMatch = req.url?.match(/^\/api\/agent-output\/(.+)$/);
    if (agentMatch) {
      const group = decodeURIComponent(agentMatch[1]);
      const events = getAgentEvents(group);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(events));
      return;
    }

    // Trigger a task to run now
    const triggerMatch = req.url?.match(/^\/api\/trigger\/(.+)$/);
    if (triggerMatch && req.method === 'POST') {
      const taskId = decodeURIComponent(triggerMatch[1]);
      const task = getTaskById(taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      updateTask(taskId, {
        next_run: new Date().toISOString(),
        status: 'active',
      });
      logActivity({
        event_type: 'task_manual_trigger',
        group_folder: task.group_folder,
        summary: `Task "${taskId}" manually triggered from dashboard`,
        task_id: taskId,
      });
      logger.info({ taskId }, 'Task manually triggered from dashboard');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, taskId }));
      return;
    }

    // Pause a task
    const pauseMatch = req.url?.match(/^\/api\/pause\/(.+)$/);
    if (pauseMatch && req.method === 'POST') {
      const taskId = decodeURIComponent(pauseMatch[1]);
      const task = getTaskById(taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      updateTask(taskId, { status: 'paused' });
      logActivity({
        event_type: 'task_manual_trigger',
        group_folder: task.group_folder,
        summary: `Task "${taskId}" paused from dashboard`,
        task_id: taskId,
      });
      logger.info({ taskId }, 'Task paused from dashboard');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, taskId, status: 'paused' }));
      return;
    }

    // Resume a task
    const resumeMatch = req.url?.match(/^\/api\/resume\/(.+)$/);
    if (resumeMatch && req.method === 'POST') {
      const taskId = decodeURIComponent(resumeMatch[1]);
      const task = getTaskById(taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      updateTask(taskId, {
        status: 'active',
        next_run: new Date().toISOString(),
      });
      logActivity({
        event_type: 'task_manual_trigger',
        group_folder: task.group_folder,
        summary: `Task "${taskId}" resumed from dashboard`,
        task_id: taskId,
      });
      logger.info({ taskId }, 'Task resumed from dashboard');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, taskId, status: 'active' }));
      return;
    }

    // Update task schedule
    const schedMatch = req.url?.match(/^\/api\/update-schedule\/(.+)$/);
    if (schedMatch && req.method === 'POST') {
      const taskId = decodeURIComponent(schedMatch[1]);
      const task = getTaskById(taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const { scheduleType, scheduleValue } = JSON.parse(body);
          if (!scheduleType || !scheduleValue) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'scheduleType and scheduleValue required',
              }),
            );
            return;
          }
          if (!['cron', 'interval', 'once'].includes(scheduleType)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'scheduleType must be cron, interval, or once',
              }),
            );
            return;
          }
          // Compute next_run from the new schedule
          let nextRun = '';
          if (scheduleType === 'cron') {
            try {
              nextRun = CronExpressionParser.parse(scheduleValue, {
                tz: TIMEZONE,
              })
                .next()
                .toISOString() as string;
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid cron expression' }));
              return;
            }
          } else if (scheduleType === 'interval') {
            const ms = parseInt(scheduleValue, 10);
            if (isNaN(ms) || ms <= 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'Invalid interval (must be positive ms)',
                }),
              );
              return;
            }
            nextRun = new Date(Date.now() + ms).toISOString();
          } else {
            const d = new Date(scheduleValue);
            if (isNaN(d.getTime())) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ error: 'Invalid date for once schedule' }),
              );
              return;
            }
            nextRun = d.toISOString();
          }
          updateTask(taskId, {
            schedule_type: scheduleType,
            schedule_value: scheduleValue,
            next_run: nextRun,
          });
          logActivity({
            event_type: 'task_manual_trigger',
            group_folder: task.group_folder,
            summary: `Task "${taskId}" schedule updated: ${scheduleType} ${scheduleValue}`,
            task_id: taskId,
          });
          logger.info(
            { taskId, scheduleType, scheduleValue, nextRun },
            'Task schedule updated from dashboard',
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              taskId,
              scheduleType,
              scheduleValue,
              nextRun,
            }),
          );
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    // Serve HTML dashboard
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_PAGE);
  });

  server.listen(MONITOR_PORT, '127.0.0.1', () => {
    logger.info({ port: MONITOR_PORT }, 'Monitor dashboard started');
  });

  server.on('error', (err) => {
    logger.warn({ err, port: MONITOR_PORT }, 'Monitor failed to start');
  });
}

function getStatus(state: MonitorState) {
  // Heartbeat
  let heartbeat = null;
  const heartbeatFile = path.join(DATA_DIR, 'heartbeat.json');
  try {
    if (fs.existsSync(heartbeatFile)) {
      heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, 'utf-8'));
    }
  } catch {
    /* ignore */
  }

  // Groups
  const groups = getAllRegisteredGroups();
  const groupList = Object.entries(groups).map(([chatId, g]) => ({
    chatId,
    name: g.name,
    folder: g.folder,
    tag: g.tag,
    model: g.model || null,
  }));

  // Tasks with stats
  const tasks = getAllTasks().map((t) => {
    const stats = getTaskRunStats(t.id);
    return {
      id: t.id,
      group: t.group_folder,
      prompt: t.prompt.slice(0, 80),
      fullPrompt: t.prompt,
      schedule: `${t.schedule_type}: ${t.schedule_value}`,
      scheduleType: t.schedule_type,
      scheduleValue: t.schedule_value,
      status: t.status,
      nextRun: t.next_run,
      lastRun: t.last_run,
      lastResult: t.last_result?.slice(0, 150) || null,
      avgDurationMs: stats.avg_duration_ms
        ? Math.round(stats.avg_duration_ms)
        : null,
      successRate:
        stats.total > 0
          ? Math.round((stats.successes / stats.total) * 100)
          : null,
      totalRuns: stats.total,
    };
  });

  // Recent chats
  const chats = getAllChats().slice(0, 20);

  // Active agents
  const agents = state.activeAgents();

  return {
    uptime_ms: Date.now() - startTime,
    heartbeat,
    groups: groupList,
    tasks,
    chats,
    activeAgents: Object.entries(agents).map(([group, info]) => ({
      group,
      chatId: info.chatId,
      running_ms: Date.now() - info.startedAt,
      taskId: info.taskId || null,
      prompt: info.prompt || '',
      model: info.model || null,
      pid: info.pid || null,
      eventCount: getAgentEvents(group).length,
      tokensPerSec: getAgentTokensPerSec(group),
      tokenCount: info.tokenCount || 0,
    })),
    triggersThisHour: getTriggerCountThisHour(),
    agentTimeout: AGENT_TIMEOUT,
    collaboration: (() => {
      const metrics24h = getCollaborationMetrics(24);
      const metrics7d = getCollaborationMetrics(168);
      const trend = getCollaborationTrend();
      return {
        score: computeCollaborationScore(metrics24h),
        trend:
          trend.current > trend.previous
            ? 'up'
            : trend.current < trend.previous
              ? 'down'
              : 'stable',
        triggers24h: metrics24h.totalTriggers,
        triggers7d: metrics7d.totalTriggers,
        uniquePairs: metrics24h.uniquePairs,
        byAgent: metrics24h.byAgent,
        topPairs: metrics24h.pairs.slice(0, 5),
      };
    })(),
    adminActivity: getAdminActivity(30),
    metrics: (() => {
      const completions = getActivityLog(1000, 0, 'agent_completed');
      const errors = getActivityLog(1000, 0, 'agent_error');
      const triggers = getActivityLog(1000, 0, 'trigger_email_sent');
      const emails = getActivityLog(1000, 0, 'email_sent');
      const timeouts = errors.filter((e) =>
        e.summary?.includes('timed out') || e.details_json?.includes('timed out'),
      );
      const durations = completions
        .map((e) => {
          try {
            const d = JSON.parse(e.details_json || '{}');
            return d.durationMs;
          } catch { return null; }
        })
        .filter((d): d is number => d !== null && d > 0);
      return {
        avgCompletionMs: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
        completionCount: completions.length,
        timeoutCount: timeouts.length,
        triggerSuccessCount: triggers.length,
        emailsSent: emails.length,
        activeGroups: groupList.length,
        activeTasks: tasks.filter((t) => t.status === 'active').length,
      };
    })(),
  };
}

function getProcessStats(state: MonitorState) {
  const agents = state.activeAgents();
  const agentStats: { group: string; pid: number; cpu: string; rss_mb: string }[] = [];

  // Get stats for each agent with a PID
  for (const [group, info] of Object.entries(agents)) {
    if (info.pid) {
      try {
        const out = execSync(`ps -p ${info.pid} -o pcpu=,rss= 2>/dev/null`, { timeout: 2000 }).toString().trim();
        const [cpu, rss] = out.split(/\s+/);
        agentStats.push({
          group,
          pid: info.pid,
          cpu: cpu || '0',
          rss_mb: rss ? (parseInt(rss, 10) / 1024).toFixed(0) : '0',
        });
      } catch { /* process may have exited */ }
    }
  }

  // Get Ollama runner stats
  let ollama: { pid: number; cpu: string; rss_mb: string } | null = null;
  try {
    const out = execSync("ps aux | grep 'ollama runner' | grep -v grep | head -1", { timeout: 2000 }).toString().trim();
    if (out) {
      const parts = out.split(/\s+/);
      ollama = {
        pid: parseInt(parts[1], 10),
        cpu: parts[2] || '0',
        rss_mb: parts[5] ? (parseInt(parts[5], 10) / 1024).toFixed(0) : '0',
      };
    }
  } catch { /* no ollama runner */ }

  return { agents: agentStats, ollama };
}

const HTML_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>NanoClaw — Launch80</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #c8c8c8; font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; font-size: 13px; padding: 20px; }
  h1 { color: #e0e0e0; font-size: 16px; margin-bottom: 16px; display: flex; align-items: center; gap: 12px; }
  h2 { color: #a0a0a0; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0; border: none; padding: 0; }
  .status-bar { display: flex; gap: 16px; padding: 8px 12px; background: #111; border-radius: 4px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
  .status-item { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .status-val { color: #e0e0e0; }
  .status-sep { color: #222; font-size: 10px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
  .green { background: #2d8; }
  .red { background: #d44; }
  .top-bar { position: fixed; top: 12px; right: 16px; display: flex; align-items: center; gap: 10px; z-index: 50; }
  .refresh { color: #444; font-size: 11px; }
  .btn-help { background: #1a1a1a; color: #888; border: 1px solid #333; border-radius: 50%; width: 22px; height: 22px; cursor: pointer; font-size: 12px; font-family: inherit; display: flex; align-items: center; justify-content: center; }
  .btn-help:hover { color: #e0e0e0; border-color: #666; }
  .main-grid { display: grid; grid-template-columns: 240px 1fr 280px; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 1100px) { .main-grid { grid-template-columns: 1fr 280px; } .collab-panel { grid-column: 1 / -1; } }
  @media (max-width: 700px) { .main-grid { grid-template-columns: 1fr; } }
  .collab-panel { min-width: 0; }
  .side-panel > div { margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #555; font-weight: normal; padding: 3px 6px; font-size: 11px; }
  td { padding: 3px 6px; border-top: 1px solid #1a1a1a; font-size: 12px; }
  tr:nth-child(even) td { background: #0e0e0e; }
  .badge { padding: 1px 5px; border-radius: 3px; font-size: 10px; }
  .badge-active { background: #1a3a2a; color: #2d8; }
  .badge-paused { background: #3a3a1a; color: #da2; }
  .badge-completed { background: #1a1a2a; color: #68c; }
  .prompt-col { color: #888; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: #444; font-style: italic; padding: 8px; font-size: 12px; }
  .btn { background: #1a1a2a; color: #8af; border: 1px solid #333; border-radius: 3px; padding: 2px 8px; cursor: pointer; font-family: inherit; font-size: 10px; }
  .btn:hover { background: #252540; border-color: #8af; }
  .btn-pause { background: #2a2a1a; color: #da2; border-color: #444; }
  .btn-pause:hover { background: #3a3a20; border-color: #da2; }
  .btn-resume { background: #1a2a1a; color: #2d8; border-color: #444; }
  .btn-resume:hover { background: #203a20; border-color: #2d8; }
  .task-actions { display: flex; gap: 4px; }
  .filter-bar { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
  .filter-btn { background: #111; border: 1px solid #222; color: #666; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-family: inherit; font-size: 11px; }
  .filter-btn.active { background: #1a1a2a; color: #8af; border-color: #8af; }
  .activity-feed { max-height: 500px; overflow-y: auto; border: 1px solid #1a1a1a; border-radius: 4px; background: #0c0c0c; }
  .activity-row { padding: 6px 10px; border-bottom: 1px solid #151515; cursor: pointer; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; }
  .activity-row:hover { background: #131313; }
  .activity-icon { font-size: 13px; width: 18px; text-align: center; flex-shrink: 0; }
  .activity-summary { flex: 1; min-width: 150px; color: #bbb; }
  .activity-group { color: #8af; font-size: 11px; }
  .activity-time { color: #444; font-size: 11px; flex-shrink: 0; }
  .activity-details { width: 100%; background: #0a0a0a; border: 1px solid #1a1a1a; border-radius: 3px; padding: 8px 10px; margin-top: 4px; font-size: 11px; max-height: 500px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; color: #888; }
  .icon-started { color: #da2; }
  .icon-completed { color: #2d8; }
  .icon-error { color: #d44; }
  .icon-email { color: #68c; }
  .icon-trigger { color: #a8f; }
  .icon-task { color: #8af; }
  .rate-good { color: #2d8; }
  .rate-warn { color: #da2; }
  .rate-bad { color: #d44; }
  .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 100; justify-content: center; align-items: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: #111; border: 1px solid #333; border-radius: 8px; max-width: 650px; width: 90%; max-height: 85vh; overflow-y: auto; padding: 24px; }
  .modal h3 { color: #e0e0e0; font-size: 14px; margin-bottom: 12px; }
  .modal h4 { color: #a0a0a0; font-size: 12px; margin: 14px 0 4px; }
  .modal p, .modal li { color: #999; line-height: 1.5; margin-bottom: 6px; font-size: 12px; }
  .modal ul { padding-left: 18px; }
  .modal .close { float: right; background: none; border: none; color: #666; cursor: pointer; font-size: 18px; }
  .modal .close:hover { color: #e0e0e0; }
  .modal code { background: #1a1a1a; padding: 1px 4px; border-radius: 3px; color: #8af; font-size: 11px; }
  .btn-edit { background: #1a1a2a; color: #a8f; border-color: #444; }
  .btn-edit:hover { background: #252540; border-color: #a8f; }
  .edit-modal { max-width: 520px; }
  .edit-modal label { display: block; color: #999; font-size: 11px; margin: 10px 0 3px; }
  .edit-modal select, .edit-modal input { width: 100%; background: #0a0a0a; color: #e0e0e0; border: 1px solid #333; border-radius: 3px; padding: 6px 8px; font-family: inherit; font-size: 12px; }
  .edit-modal select:focus, .edit-modal input:focus { outline: none; border-color: #8af; }
  .edit-modal .legend { background: #0e0e0e; border: 1px solid #1a1a1a; border-radius: 4px; padding: 10px 12px; margin-top: 12px; }
  .edit-modal .legend h4 { color: #888; font-size: 11px; margin: 0 0 6px; }
  .edit-modal .legend table { font-size: 11px; }
  .edit-modal .legend td { padding: 2px 8px 2px 0; border: none; color: #777; }
  .edit-modal .legend td:first-child { color: #8af; font-weight: bold; }
  .edit-modal .btn-row { display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end; }
  .edit-modal .btn-save { background: #1a2a1a; color: #2d8; border-color: #2d8; padding: 4px 16px; font-size: 12px; }
  .edit-modal .btn-save:hover { background: #203a20; }
  .edit-modal .btn-cancel { background: #1a1a1a; color: #888; border-color: #333; padding: 4px 16px; font-size: 12px; }
  .edit-modal .preview { color: #2d8; font-size: 12px; margin-top: 6px; min-height: 18px; }
  .edit-modal .error-msg { color: #d44; font-size: 11px; margin-top: 4px; min-height: 16px; }
  .agent-card { background: #111; border: 1px solid #222; border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; }
  .agent-card:hover { border-color: #444; }
  .agent-card.viewing { border-color: #8af; background: #0e1020; }
  .agent-card .agent-header { display: flex; justify-content: space-between; align-items: center; }
  .agent-card .agent-group { color: #8af; font-size: 12px; font-weight: bold; }
  .agent-card .agent-time { color: #2d8; font-size: 11px; }
  .agent-card .agent-task { color: #666; font-size: 10px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent-card .agent-events { color: #555; font-size: 10px; margin-top: 2px; }
  .collab-header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
  .collab-score { font-size: 28px; font-weight: bold; line-height: 1; }
  .collab-high { color: #2d8; }
  .collab-mid { color: #da2; }
  .collab-low { color: #d44; }
  .collab-trend { font-size: 14px; }
  .trend-up { color: #2d8; }
  .trend-down { color: #d44; }
  .trend-stable { color: #555; }
  .collab-stats { color: #666; font-size: 11px; margin-bottom: 6px; }
  .collab-pair { display: flex; justify-content: space-between; padding: 2px 0; font-size: 11px; color: #888; }
  .collab-pair-route { color: #a8f; }
  .collab-pair-count { color: #e0e0e0; font-weight: bold; }
  .collab-agents { margin-top: 6px; }
  .collab-agents td { padding: 1px 6px; font-size: 11px; border: none; }
  .admin-ops { max-height: 350px; overflow-y: auto; border: 1px solid #1a1a1a; border-radius: 4px; background: #0c0c0c; }
  .event-line { padding: 2px 10px; font-size: 11px; border-bottom: 1px solid #111; display: flex; gap: 6px; }
  .event-line .ev-type { color: #666; width: 50px; flex-shrink: 0; text-align: right; }
  .event-line .ev-text { color: #bbb; word-break: break-word; white-space: pre-wrap; }
  .event-line.ev-text-type .ev-text { color: #c8c8c8; }
  .event-line.ev-tool-type .ev-type { color: #a8f; }
  .event-line.ev-tool-type .ev-text { color: #a8f; }
  .event-line.ev-thinking-type .ev-text { color: #888; font-style: italic; }
  .event-line.ev-status-type .ev-text { color: #555; }
  .event-line.ev-tool_result-type .ev-type { color: #68c; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: #1a3a2a; color: #2d8; padding: 8px 16px; border-radius: 4px; font-size: 12px; display: none; z-index: 200; }
  /* Accordion */
  .accordion { border: 1px solid #222; border-radius: 4px; margin-bottom: 12px; }
  .accordion-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; cursor: pointer; background: #111; border-radius: 4px; user-select: none; }
  .accordion-header h2 { margin: 0; border: none; padding: 0; }
  .accordion-chevron { color: #555; font-size: 10px; transition: transform 0.2s; }
  .accordion.collapsed .accordion-chevron { transform: rotate(-90deg); }
  .accordion.collapsed .accordion-body { display: none; }
  .accordion-body { padding: 8px; }
  /* Live output */
  .output-tabs { display: flex; gap: 4px; margin-bottom: 6px; flex-wrap: wrap; }
  .output-tab { background: #111; border: 1px solid #222; color: #666; padding: 2px 10px; border-radius: 3px; cursor: pointer; font-family: inherit; font-size: 11px; }
  .output-tab.active { background: #1a1a2a; color: #8af; border-color: #8af; }
  .live-output-feed { max-height: 400px; overflow-y: auto; background: #0a0a0a; border: 1px solid #1a1a1a; border-radius: 4px; min-height: 60px; }
  /* Metrics table */
  .metrics-table { width: 100%; }
  .metrics-table td { padding: 4px 10px; font-size: 12px; }
  .metrics-table td:first-child { color: #888; }
  .metrics-table .metric-before { color: #d44; text-align: center; }
  .metrics-table .metric-after { color: #2d8; text-align: center; font-weight: bold; }
  .metrics-table th { padding: 4px 10px; }
</style>
</head>
<body>
<h1>NanoClaw <span style="color:#555;font-size:12px;font-weight:normal">Launch80 Agent Network</span></h1>
<div class="top-bar">
  <span class="refresh" id="refresh">...</span>
  <button class="btn-help" onclick="toggleHelp()" title="Help">?</button>
</div>
<div class="status-bar" id="status-bar"></div>
<div class="main-grid">
  <div class="collab-panel">
    <div class="accordion" id="acc-collab">
      <div class="accordion-header" onclick="toggleAccordion('acc-collab')">
        <h2>Collaboration</h2><span class="accordion-chevron">&#9660;</span>
      </div>
      <div class="accordion-body">
        <div id="collab"><div class="empty">Loading...</div></div>
      </div>
    </div>
  </div>
  <div>
    <div class="accordion" id="acc-activity">
      <div class="accordion-header" onclick="toggleAccordion('acc-activity')">
        <h2>Activity Feed</h2><span class="accordion-chevron">&#9660;</span>
      </div>
      <div class="accordion-body">
        <div class="filter-bar" id="filter-bar"></div>
        <div class="filter-bar" id="time-filter-bar"></div>
        <div class="activity-feed" id="activity-feed"><div class="empty">Loading...</div></div>
      </div>
    </div>
  </div>
  <div class="side-panel">
    <div class="accordion" id="acc-agents">
      <div class="accordion-header" onclick="toggleAccordion('acc-agents')">
        <h2>Active Agents</h2><span class="accordion-chevron">&#9660;</span>
      </div>
      <div class="accordion-body"><div id="agents"></div></div>
    </div>
    <div class="accordion" id="acc-groups">
      <div class="accordion-header" onclick="toggleAccordion('acc-groups')">
        <h2>Groups</h2><span class="accordion-chevron">&#9660;</span>
      </div>
      <div class="accordion-body"><div id="groups"></div></div>
    </div>
    <div class="accordion" id="acc-chats">
      <div class="accordion-header" onclick="toggleAccordion('acc-chats')">
        <h2>Recent Chats</h2><span class="accordion-chevron">&#9660;</span>
      </div>
      <div class="accordion-body"><div id="chats"></div></div>
    </div>
  </div>
</div>
<div class="accordion" id="acc-live-output">
  <div class="accordion-header" onclick="toggleAccordion('acc-live-output')">
    <h2>Agent Live Output</h2><span class="accordion-chevron">&#9660;</span>
  </div>
  <div class="accordion-body">
    <div class="output-tabs" id="output-tabs"></div>
    <div class="live-output-feed" id="live-output-feed"><div class="empty">No agents running</div></div>
  </div>
</div>
<div class="accordion" id="acc-admin">
  <div class="accordion-header" onclick="toggleAccordion('acc-admin')">
    <h2>Admin Operations</h2><span class="accordion-chevron">&#9660;</span>
  </div>
  <div class="accordion-body">
    <div class="filter-bar" id="admin-time-filter-bar"></div>
    <div id="admin-ops" class="admin-ops"><div class="empty">Loading...</div></div>
  </div>
</div>
<div class="accordion" id="acc-tasks">
  <div class="accordion-header" onclick="toggleAccordion('acc-tasks')">
    <h2>Scheduled Tasks</h2><span class="accordion-chevron">&#9660;</span>
  </div>
  <div class="accordion-body"><div id="tasks" style="overflow-x:auto"></div></div>
</div>
<div class="accordion" id="acc-metrics">
  <div class="accordion-header" onclick="toggleAccordion('acc-metrics')">
    <h2>System Metrics</h2><span class="accordion-chevron">&#9660;</span>
  </div>
  <div class="accordion-body"><div id="metrics-content"><div class="empty">Loading...</div></div></div>
</div>
<div class="toast" id="toast"></div>
<div class="modal-overlay" id="help-modal" onclick="if(event.target===this)toggleHelp()">
  <div class="modal">
    <button class="close" onclick="toggleHelp()">&times;</button>
    <h3>NanoClaw Dashboard</h3>
    <p>Monitoring dashboard for the Launch80 AI agent network. Auto-refreshes every 5 seconds.</p>
    <h4>Activity Feed</h4>
    <p>Real-time log of all system events. Click any row to expand details (full result text, errors, prompts). Use filter buttons to narrow by event type.</p>
    <h4>Status Bar</h4>
    <ul>
      <li><strong>IMAP</strong> — Green = email connection live, Red = disconnected</li>
      <li><strong>Uptime</strong> — Time since last restart</li>
      <li><strong>Triggers/hr</strong> — Cross-agent trigger emails this hour</li>
    </ul>
    <h4>Scheduled Tasks</h4>
    <p>All recurring and one-time tasks. Shows success rate, average duration, and total runs. Click <strong>Run Now</strong> to trigger immediately — the activity feed will show it being picked up.</p>
    <h4>Agent Roster</h4>
    <ul>
      <li><code>[admin]</code> — Gatekeeper &amp; team leader, routes all agent-to-user comms, provides direction</li>
      <li><code>[research]</code> Nova — Startup ecosystem intelligence, web search, daily reports</li>
      <li><code>[content]</code> Echo — Brand and content marketing, tweet drafts, Twitter replies</li>
      <li><code>[social]</code> SocialSpark — Social media SEO, Reddit engagement, trend scanning</li>
    </ul>
    <h4>Collaboration KPI</h4>
    <p>Measures how actively agents collaborate with each other via trigger emails. The score (0-100) is based on:</p>
    <ul>
      <li><strong>Diversity (40pts)</strong> — How many unique agent pairs are interacting</li>
      <li><strong>Volume (30pts)</strong> — Number of triggers in the last 24 hours (20+ = full marks)</li>
      <li><strong>Participation (30pts)</strong> — How many of the 7 agents sent at least one trigger</li>
    </ul>
    <p>Score ranges: <strong style="color:#2d8">70+</strong> = strong collaboration, <strong style="color:#da2">40-69</strong> = developing, <strong style="color:#d44">&lt;40</strong> = siloed. The trend arrow compares the last 24h to the previous 24h.</p>
    <h4>Admin Operations</h4>
    <p>Timeline of all actions taken by the admin agent — approvals routed to agents, feedback sent, direction given, orchestration summaries, and emails to the user. Click any row to expand details.</p>
  </div>
</div>
<div class="modal-overlay" id="edit-modal" onclick="if(event.target===this)closeEditModal()">
  <div class="modal edit-modal">
    <button class="close" onclick="closeEditModal()">&times;</button>
    <h3>Edit Schedule</h3>
    <p style="color:#666;font-size:11px" id="edit-task-label"></p>
    <label>Task Prompt</label>
    <div id="edit-task-prompt" style="background:#0a0a0a;border:1px solid #222;border-radius:3px;padding:8px 10px;color:#bbb;font-size:11px;line-height:1.5;max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;margin-bottom:4px"></div>
    <label>Schedule Type</label>
    <select id="edit-sched-type">
      <option value="cron">Cron</option>
      <option value="interval">Interval</option>
      <option value="once">Once</option>
    </select>
    <label>Value</label>
    <input type="text" id="edit-sched-value" placeholder="e.g. */20 * * * * or 1200000">
    <div class="preview" id="edit-preview"></div>
    <div class="error-msg" id="edit-error"></div>
    <div class="legend" id="edit-legend">
      <h4>Cron Expression Reference</h4>
      <table>
        <tr><td>*</td><td>every value</td><td></td><td></td></tr>
        <tr><td>*/N</td><td>every N units</td><td></td><td></td></tr>
        <tr><td>1,5,10</td><td>specific values</td><td></td><td></td></tr>
        <tr><td>1-5</td><td>range of values</td><td></td><td></td></tr>
      </table>
      <h4 style="margin-top:8px">Fields: minute hour day-of-month month day-of-week</h4>
      <table>
        <tr><td>Minute</td><td>0-59</td><td>Day</td><td>1-31</td></tr>
        <tr><td>Hour</td><td>0-23</td><td>Month</td><td>1-12</td></tr>
        <tr><td>Day-of-week</td><td>0-7 (0,7=Sun)</td><td></td><td></td></tr>
      </table>
      <h4 style="margin-top:8px">Common Patterns</h4>
      <table>
        <tr><td>*/15 * * * *</td><td>Every 15 min</td></tr>
        <tr><td>0 */2 * * *</td><td>Every 2 hours</td></tr>
        <tr><td>0 9 * * *</td><td>Daily at 9:00 AM</td></tr>
        <tr><td>30 8 * * 1-5</td><td>Weekdays at 8:30 AM</td></tr>
        <tr><td>0 14 * * 5</td><td>Fridays at 2:00 PM</td></tr>
        <tr><td>0 9 * * 1</td><td>Mondays at 9:00 AM</td></tr>
      </table>
      <div id="interval-legend" style="display:none">
        <h4 style="margin-top:8px">Interval (milliseconds)</h4>
        <table>
          <tr><td>900000</td><td>15 min</td></tr>
          <tr><td>1200000</td><td>20 min</td></tr>
          <tr><td>1800000</td><td>30 min</td></tr>
          <tr><td>2700000</td><td>45 min</td></tr>
          <tr><td>3600000</td><td>1 hour</td></tr>
          <tr><td>7200000</td><td>2 hours</td></tr>
          <tr><td>21600000</td><td>6 hours</td></tr>
        </table>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn btn-cancel" onclick="closeEditModal()">Cancel</button>
      <button class="btn btn-save" id="edit-save-btn">Save</button>
    </div>
  </div>
</div>
<script>
var activityFilter = 'all';
var expandedId = null;
var activityData = [];
var editingTaskId = null;
var viewingAgent = null;
var agentOutputTimer = null;
var expandedAdminId = null;
var activityTimeframe = 'all';
var adminTimeframe = 'all';

// Accordion with localStorage persistence
function toggleAccordion(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('collapsed');
  var state = JSON.parse(localStorage.getItem('ncAccordions') || '{}');
  state[id] = el.classList.contains('collapsed');
  localStorage.setItem('ncAccordions', JSON.stringify(state));
}
(function restoreAccordions() {
  var saved = JSON.parse(localStorage.getItem('ncAccordions') || '{}');
  Object.keys(saved).forEach(function(id) {
    if (saved[id]) {
      var el = document.getElementById(id);
      if (el) el.classList.add('collapsed');
    }
  });
})();

// Timeframe helpers
var tfHours = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };
function getTimeframeSince(tf) {
  if (tf === 'all') return '';
  return new Date(Date.now() - tfHours[tf] * 3600000).toISOString();
}
function renderTimeFilter(containerId, currentTf, onChange) {
  var tfs = ['1h','6h','24h','7d','all'];
  document.getElementById(containerId).innerHTML = tfs.map(function(tf) {
    return '<button class="filter-btn' + (tf === currentTf ? ' active' : '') + '" data-tf="' + tf + '">' + tf + '</button>';
  }).join('');
  document.getElementById(containerId).addEventListener('click', function(e) {
    var btn = e.target.closest('.filter-btn');
    if (!btn) return;
    onChange(btn.dataset.tf);
    this.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.tf === btn.dataset.tf); });
  });
}
renderTimeFilter('time-filter-bar', activityTimeframe, function(tf) { activityTimeframe = tf; refreshActivity(); });
renderTimeFilter('admin-time-filter-bar', adminTimeframe, function(tf) { adminTimeframe = tf; refreshAll(); });

var DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function humanSchedule(type, value) {
  if (type === 'interval') {
    var ms = parseInt(value, 10);
    if (ms < 60000) return 'Every ' + Math.round(ms/1000) + 's';
    if (ms < 3600000) return 'Every ' + Math.round(ms/60000) + ' min';
    if (ms < 86400000) { var h = ms/3600000; return 'Every ' + (h % 1 === 0 ? h : h.toFixed(1)) + 'h'; }
    return 'Every ' + Math.round(ms/86400000) + 'd';
  }
  if (type === 'once') {
    try { var d = new Date(value); return d.toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}); } catch(e) { return value; }
  }
  if (type === 'cron') {
    var p = value.split(/\\s+/);
    if (p.length < 5) return value;
    var min = p[0], hr = p[1], dom = p[2], mon = p[3], dow = p[4];
    var timeStr = '';
    if (min.indexOf('/') >= 0) {
      var n = parseInt(min.split('/')[1], 10);
      if (hr === '*') return 'Every ' + n + ' min';
    }
    if (hr.indexOf('/') >= 0) {
      var n2 = parseInt(hr.split('/')[1], 10);
      return 'Every ' + n2 + 'h' + (min !== '0' ? ' at :' + min.padStart(2,'0') : '');
    }
    if (hr !== '*' && !hr.includes(',') && !hr.includes('-') && !hr.includes('/')) {
      var h24 = parseInt(hr, 10);
      var ampm = h24 >= 12 ? 'PM' : 'AM';
      var h12 = h24 % 12 || 12;
      timeStr = h12 + ':' + min.padStart(2, '0') + ' ' + ampm;
    } else {
      return value;
    }
    if (dow !== '*' && dow !== '?') {
      var dayParts = dow.split(',').map(function(d) {
        if (d.indexOf('-') >= 0) {
          var range = d.split('-');
          return DAYS[parseInt(range[0],10) % 7] + '-' + DAYS[parseInt(range[1],10) % 7];
        }
        return DAYS[parseInt(d, 10) % 7] || d;
      });
      return dayParts.join(',') + ' ' + timeStr;
    }
    if (dom !== '*') return 'Day ' + dom + ' ' + timeStr;
    return 'Daily ' + timeStr;
  }
  return value;
}

function openEditModal(taskId, schedType, schedValue, prompt) {
  editingTaskId = taskId;
  document.getElementById('edit-task-label').textContent = taskId;
  document.getElementById('edit-task-prompt').textContent = prompt || '(no prompt)';
  document.getElementById('edit-sched-type').value = schedType;
  document.getElementById('edit-sched-value').value = schedValue;
  document.getElementById('edit-error').textContent = '';
  updateEditPreview();
  updateEditLegend();
  document.getElementById('edit-modal').classList.add('open');
}
function closeEditModal() {
  editingTaskId = null;
  document.getElementById('edit-modal').classList.remove('open');
}
function updateEditPreview() {
  var type = document.getElementById('edit-sched-type').value;
  var val = document.getElementById('edit-sched-value').value.trim();
  if (!val) { document.getElementById('edit-preview').textContent = ''; return; }
  document.getElementById('edit-preview').textContent = humanSchedule(type, val);
}
function updateEditLegend() {
  var type = document.getElementById('edit-sched-type').value;
  var cronParts = document.getElementById('edit-legend').querySelectorAll('h4, table');
  var intLegend = document.getElementById('interval-legend');
  if (type === 'interval') {
    for (var i = 0; i < cronParts.length; i++) {
      if (!intLegend.contains(cronParts[i])) cronParts[i].style.display = 'none';
    }
    intLegend.style.display = 'block';
  } else if (type === 'cron') {
    for (var i = 0; i < cronParts.length; i++) {
      if (!intLegend.contains(cronParts[i])) cronParts[i].style.display = '';
    }
    intLegend.style.display = 'none';
  } else {
    document.getElementById('edit-legend').style.display = 'none';
  }
  if (type !== 'once') document.getElementById('edit-legend').style.display = '';
}
function saveSchedule() {
  var type = document.getElementById('edit-sched-type').value;
  var val = document.getElementById('edit-sched-value').value.trim();
  if (!val) { document.getElementById('edit-error').textContent = 'Value is required'; return; }
  document.getElementById('edit-error').textContent = '';
  fetch('/api/update-schedule/' + encodeURIComponent(editingTaskId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduleType: type, scheduleValue: val })
  })
    .then(function(r){ return r.json(); })
    .then(function(d) {
      if (d.ok) {
        showToast('Schedule updated: ' + editingTaskId.replace(/^task-/, ''));
        closeEditModal();
        refreshAll();
      } else {
        document.getElementById('edit-error').textContent = d.error || 'Update failed';
      }
    })
    .catch(function(err) { document.getElementById('edit-error').textContent = err.message; });
}

function fmt(ms) {
  var s = Math.floor(ms / 1000);
  var d = Math.floor(s / 86400);
  var h = Math.floor((s % 86400) / 3600);
  var m = Math.floor((s % 3600) / 60);
  return d > 0 ? d+'d '+h+'h' : h > 0 ? h+'h '+m+'m' : m+'m';
}
function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML.replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function badge(s) { return '<span class="badge badge-'+s+'">'+s+'</span>'; }
function table(headers, rows) {
  if (!rows.length) return '<div class="empty">None</div>';
  var h = '<table><tr>' + headers.map(function(x){return '<th>'+x+'</th>'}).join('') + '</tr>';
  h += rows.map(function(r){return '<tr>' + r.map(function(c){return '<td>'+c+'</td>'}).join('') + '</tr>'}).join('');
  return h + '</table>';
}
function timeAgo(iso) {
  if (!iso) return '-';
  var ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'in ' + fmt(-ms);
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.floor(ms/60000)+'m ago';
  if (ms < 86400000) return Math.floor(ms/3600000)+'h ago';
  return Math.floor(ms/86400000)+'d ago';
}
function toggleHelp() { document.getElementById('help-modal').classList.toggle('open'); }
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(function(){ t.style.display = 'none'; }, 3000);
}
function getIcon(type) {
  var icons = {
    agent_started: '<span class="icon-started">&#9654;</span>',
    agent_completed: '<span class="icon-completed">&#10003;</span>',
    agent_error: '<span class="icon-error">&#10007;</span>',
    task_scheduled_run: '<span class="icon-task">&#9200;</span>',
    task_manual_trigger: '<span class="icon-task">&#9889;</span>',
    email_sent: '<span class="icon-email">&#9993;</span>',
    email_received: '<span class="icon-email">&#128233;</span>',
    trigger_email_sent: '<span class="icon-trigger">&#8644;</span>'
  };
  return icons[type] || '<span>&#8226;</span>';
}
function matchesFilter(type) {
  if (activityFilter === 'all') return true;
  if (activityFilter === 'agents') return type.startsWith('agent_');
  if (activityFilter === 'emails') return type.indexOf('email') >= 0;
  if (activityFilter === 'triggers') return type === 'trigger_email_sent';
  if (activityFilter === 'errors') return type === 'agent_error';
  if (activityFilter === 'tasks') return type.indexOf('task_') >= 0;
  return true;
}
function renderActivity() {
  var filtered = activityData.filter(function(e){ return matchesFilter(e.event_type); });
  if (!filtered.length) {
    document.getElementById('activity-feed').innerHTML = '<div class="empty">No activity' + (activityFilter !== 'all' ? ' matching filter' : '') + '</div>';
    return;
  }
  var html = filtered.map(function(e) {
    var expanded = expandedId === e.id;
    var details = '';
    if (expanded && e.details_json) {
      try {
        var d = JSON.parse(e.details_json);
        var lines = Object.keys(d).map(function(k) {
          var v = d[k];
          if (v === null || v === undefined) return '';
          return k + ': ' + String(v).slice(0, 500);
        }).filter(function(x){return x});
        details = '<div class="activity-details">' + esc(lines.join('\\n')) + '</div>';
      } catch(ex) {}
    }
    return '<div class="activity-row" data-id="' + e.id + '">' +
      '<span class="activity-icon">' + getIcon(e.event_type) + '</span>' +
      '<span class="activity-summary">' + esc(e.summary) + '</span>' +
      (e.group_folder ? '<span class="activity-group">[' + esc(e.group_folder) + ']</span>' : '') +
      '<span class="activity-time">' + timeAgo(e.timestamp) + '</span>' +
      details +
    '</div>';
  }).join('');
  document.getElementById('activity-feed').innerHTML = html;
}
function rateClass(r) { return r >= 90 ? 'rate-good' : r >= 70 ? 'rate-warn' : 'rate-bad'; }

// Live output section (replaces old popup)
function selectLiveAgent(group) {
  viewingAgent = group;
  document.querySelectorAll('.output-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.group === group); });
  document.querySelectorAll('.agent-card').forEach(function(c) { c.classList.toggle('viewing', c.dataset.agent === group); });
  refreshLiveOutput();
  if (agentOutputTimer) clearInterval(agentOutputTimer);
  agentOutputTimer = setInterval(refreshLiveOutput, 2000);
  var acc = document.getElementById('acc-live-output');
  if (acc && acc.classList.contains('collapsed')) toggleAccordion('acc-live-output');
  acc.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function stopLiveOutput() {
  viewingAgent = null;
  if (agentOutputTimer) { clearInterval(agentOutputTimer); agentOutputTimer = null; }
  document.querySelectorAll('.agent-card').forEach(function(c) { c.classList.remove('viewing'); });
}
function refreshLiveOutput() {
  if (!viewingAgent) return;
  fetch('/api/agent-output/' + encodeURIComponent(viewingAgent))
    .then(function(r){ return r.json(); })
    .then(function(events) {
      var el = document.getElementById('live-output-feed');
      var wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (!events.length) {
        el.innerHTML = '<div class="empty" style="padding:12px">Waiting for output...</div>';
      } else {
        el.innerHTML = events.map(function(ev) {
          var cls = 'ev-' + ev.type + '-type';
          var label = ev.type;
          if (ev.type === 'tool_result') label = 'result';
          return '<div class="event-line ' + cls + '"><span class="ev-type">' + esc(label) + '</span><span class="ev-text">' + esc(ev.text) + '</span></div>';
        }).join('');
      }
      if (wasAtBottom) el.scrollTop = el.scrollHeight;
    })
    .catch(function(){});
}

// Render system metrics before/after table
function renderMetrics(m) {
  if (!m) return;
  var avgStr = m.avgCompletionMs ? (m.avgCompletionMs / 1000).toFixed(0) + 's' : '-';
  document.getElementById('metrics-content').innerHTML =
    '<table class="metrics-table">' +
    '<tr><th>Metric</th><th>Before</th><th>Current</th></tr>' +
    '<tr><td>Avg completion time</td><td class="metric-before">10 min (timeout)</td><td class="metric-after">' + avgStr + '</td></tr>' +
    '<tr><td>Agent completions</td><td class="metric-before">0</td><td class="metric-after">' + m.completionCount + '</td></tr>' +
    '<tr><td>Timeouts</td><td class="metric-before">All</td><td class="metric-after">' + m.timeoutCount + '</td></tr>' +
    '<tr><td>Triggers sent</td><td class="metric-before">0 (blocked)</td><td class="metric-after">' + m.triggerSuccessCount + '</td></tr>' +
    '<tr><td>Emails sent</td><td class="metric-before">0</td><td class="metric-after">' + m.emailsSent + '</td></tr>' +
    '<tr><td>Active groups</td><td class="metric-before">8</td><td class="metric-after">' + m.activeGroups + '</td></tr>' +
    '<tr><td>Scheduled tasks</td><td class="metric-before">18</td><td class="metric-after">' + m.activeTasks + '</td></tr>' +
    '</table>';
}

document.addEventListener('click', function(e) {
  var btn = e.target.closest('.btn[data-task]');
  if (btn) {
    var id = btn.dataset.task;
    fetch('/api/trigger/' + encodeURIComponent(id), { method: 'POST' })
      .then(function(r){ return r.json() })
      .then(function(d) {
        if (d.ok) { showToast('Triggered: ' + id.replace(/^task-/, '')); refreshAll(); }
        else showToast('Error: ' + (d.error || 'unknown'));
      })
      .catch(function(err){ showToast('Error: ' + err.message); });
    return;
  }
  var agentCard = e.target.closest('.agent-card[data-agent]');
  if (agentCard) { selectLiveAgent(agentCard.dataset.agent); return; }
  var outputTab = e.target.closest('.output-tab[data-group]');
  if (outputTab) { selectLiveAgent(outputTab.dataset.group); return; }
  var editBtn = e.target.closest('.btn[data-edit]');
  if (editBtn) {
    openEditModal(editBtn.dataset.edit, editBtn.dataset.stype, editBtn.dataset.sval, editBtn.dataset.prompt);
    return;
  }
  var pauseBtn = e.target.closest('.btn[data-pause]');
  if (pauseBtn) {
    var pid = pauseBtn.dataset.pause;
    fetch('/api/pause/' + encodeURIComponent(pid), { method: 'POST' })
      .then(function(r){ return r.json() })
      .then(function(d) {
        if (d.ok) { showToast('Paused: ' + pid.replace(/^task-/, '')); refreshAll(); }
        else showToast('Error: ' + (d.error || 'unknown'));
      })
      .catch(function(err){ showToast('Error: ' + err.message); });
    return;
  }
  var resumeBtn = e.target.closest('.btn[data-resume]');
  if (resumeBtn) {
    var rid2 = resumeBtn.dataset.resume;
    fetch('/api/resume/' + encodeURIComponent(rid2), { method: 'POST' })
      .then(function(r){ return r.json() })
      .then(function(d) {
        if (d.ok) { showToast('Resumed: ' + rid2.replace(/^task-/, '')); refreshAll(); }
        else showToast('Error: ' + (d.error || 'unknown'));
      })
      .catch(function(err){ showToast('Error: ' + err.message); });
    return;
  }
  var row = e.target.closest('.activity-row');
  if (row) {
    if (row.dataset.adminId) {
      var aid = parseInt(row.dataset.adminId, 10);
      expandedAdminId = expandedAdminId === aid ? null : aid;
      refreshAll();
    } else if (row.dataset.id) {
      var rid = parseInt(row.dataset.id, 10);
      expandedId = expandedId === rid ? null : rid;
      renderActivity();
    }
  }
});

var filters = ['all','agents','tasks','emails','triggers','errors'];
document.getElementById('filter-bar').innerHTML = filters.map(function(f) {
  return '<button class="filter-btn' + (f === activityFilter ? ' active' : '') + '" data-filter="' + f + '">' + f.charAt(0).toUpperCase() + f.slice(1) + '</button>';
}).join('');
document.getElementById('filter-bar').addEventListener('click', function(e) {
  var btn = e.target.closest('.filter-btn');
  if (!btn) return;
  activityFilter = btn.dataset.filter;
  document.querySelectorAll('#filter-bar .filter-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.filter === activityFilter); });
  renderActivity();
});

document.getElementById('edit-sched-type').addEventListener('change', function() { updateEditPreview(); updateEditLegend(); });
document.getElementById('edit-sched-value').addEventListener('input', updateEditPreview);
document.getElementById('edit-save-btn').addEventListener('click', saveSchedule);

// Fetch activity with timeframe
async function refreshActivity() {
  try {
    var since = getTimeframeSince(activityTimeframe);
    var url = '/api/activity?limit=100' + (since ? '&since=' + encodeURIComponent(since) : '');
    var ar = await fetch(url);
    activityData = await ar.json();
    renderActivity();
  } catch(e) {}
}

async function refreshAll() {
  try {
    var [sr, psr] = await Promise.all([
      fetch('/api/status'),
      fetch('/api/process-stats').catch(function() { return { json: function() { return { agents: [], ollama: null }; } }; })
    ]);
    var d = await sr.json();
    var ps = await psr.json();
    var hb = d.heartbeat;

    // Status bar with process stats
    var statusItems = [
      '<div class="status-item"><span class="dot '+(hb && hb.imap_connected ? 'green' : 'red')+'"></span>IMAP</div>',
      '<div class="status-item">Up: <span class="status-val">'+fmt(d.uptime_ms)+'</span></div>',
      '<div class="status-item">Groups: <span class="status-val">'+d.groups.length+'</span></div>',
      '<div class="status-item">Tasks: <span class="status-val">'+d.tasks.length+'</span></div>',
      '<div class="status-item">Triggers/hr: <span class="status-val">'+d.triggersThisHour+'</span></div>',
      '<div class="status-item">Timeout: <span class="status-val">'+fmt(d.agentTimeout)+'</span></div>',
    ];
    if (ps.ollama) {
      statusItems.push('<div class="status-sep">|</div>');
      statusItems.push('<div class="status-item">Ollama: <span class="status-val">' + esc(ps.ollama.cpu) + '% CPU, ' + esc(ps.ollama.rss_mb) + 'MB</span></div>');
    }
    ps.agents.forEach(function(a) {
      statusItems.push('<div class="status-item">[' + esc(a.group) + ']: <span class="status-val">' + esc(a.cpu) + '% CPU, ' + esc(a.rss_mb) + 'MB</span></div>');
    });
    document.getElementById('status-bar').innerHTML = statusItems.join('');
    document.getElementById('groups').innerHTML = table(
      ['Tag', 'Model'],
      d.groups.map(function(g){ return ['['+esc(g.tag)+']', '<span style="color:#666;font-size:10px">'+ esc((g.model||'default').replace(/^ollama\\//, '')) +'</span>'] })
    );
    if (d.activeAgents.length) {
      document.getElementById('agents').innerHTML = d.activeAgents.map(function(a) {
        var taskLabel = a.taskId ? a.taskId.replace(/^task-/, '') : 'message';
        var modelLabel = a.model ? a.model.replace(/^ollama\\//, '') : 'default';
        var tps = a.tokensPerSec ? a.tokensPerSec + ' tok/s' : '...';
        return '<div class="agent-card' + (viewingAgent === a.group ? ' viewing' : '') + '" data-agent="' + esc(a.group) + '">' +
          '<div class="agent-header"><span class="agent-group">[' + esc(a.group) + ']</span><span class="agent-time">' + fmt(a.running_ms) + '</span></div>' +
          '<div class="agent-task">' + esc(taskLabel) + ' <span style="color:#555">|</span> ' + esc(modelLabel) + '</div>' +
          '<div class="agent-events"><span style="color:#2d8">' + tps + '</span> <span style="color:#555">|</span> ' + a.tokenCount + ' tokens <span style="color:#555">|</span> ' + a.eventCount + ' events</div>' +
        '</div>';
      }).join('');
      // Update output tabs
      document.getElementById('output-tabs').innerHTML = d.activeAgents.map(function(a) {
        return '<button class="output-tab' + (viewingAgent === a.group ? ' active' : '') + '" data-group="' + esc(a.group) + '">[' + esc(a.group) + ']</button>';
      }).join('');
    } else {
      document.getElementById('agents').innerHTML = '<div class="empty">Idle</div>';
      document.getElementById('output-tabs').innerHTML = '';
      if (viewingAgent) {
        stopLiveOutput();
        document.getElementById('live-output-feed').innerHTML = '<div class="empty">No agents running</div>';
      }
    }
    document.getElementById('tasks').innerHTML = table(
      ['ID', 'Group', 'Schedule', 'Status', 'Last Run', 'Avg', 'Rate', 'Runs', ''],
      d.tasks.map(function(t) {
        var rate = t.successRate !== null
          ? '<span class="'+rateClass(t.successRate)+'">'+t.successRate+'%</span>'
          : '-';
        var avg = t.avgDurationMs ? (t.avgDurationMs / 1000).toFixed(0) + 's' : '-';
        return [
          '<span class="prompt-col" title="'+esc(t.fullPrompt)+'">'+esc(t.id.replace(/^task-/,''))+'</span>',
          esc(t.group),
          humanSchedule(t.scheduleType, t.scheduleValue),
          badge(t.status),
          t.lastRun ? timeAgo(t.lastRun) : '-',
          avg,
          rate,
          String(t.totalRuns),
          '<div class="task-actions">' +
            '<button class="btn btn-edit" data-edit="'+esc(t.id)+'" data-stype="'+esc(t.scheduleType)+'" data-sval="'+esc(t.scheduleValue)+'" data-prompt="'+esc(t.fullPrompt||'')+'">Edit</button>' +
            (t.status === 'paused'
              ? '<button class="btn btn-resume" data-resume="'+esc(t.id)+'">Resume</button>'
              : '<button class="btn btn-pause" data-pause="'+esc(t.id)+'">Pause</button>') +
            '<button class="btn" data-task="'+esc(t.id)+'">Run Now</button>' +
          '</div>'
        ];
      })
    );
    document.getElementById('chats').innerHTML = table(
      ['Chat', 'Last'],
      d.chats.map(function(c){ return [esc(c.name), timeAgo(c.last_message_time)] })
    );

    // Collaboration KPI
    var c = d.collaboration;
    if (c) {
      var scoreClass = c.score >= 70 ? 'collab-high' : c.score >= 40 ? 'collab-mid' : 'collab-low';
      var trendIcon = c.trend === 'up' ? '&#9650;' : c.trend === 'down' ? '&#9660;' : '&#9654;';
      var trendClass = c.trend === 'up' ? 'trend-up' : c.trend === 'down' ? 'trend-down' : 'trend-stable';
      var html = '<div class="collab-header">' +
        '<span class="collab-score ' + scoreClass + '">' + c.score + '</span>' +
        '<span class="collab-trend ' + trendClass + '">' + trendIcon + ' ' + c.trend + '</span>' +
      '</div>' +
      '<div class="collab-stats">24h: ' + c.triggers24h + ' triggers, ' + c.uniquePairs + ' pairs &middot; 7d: ' + c.triggers7d + ' triggers</div>';

      if (c.topPairs && c.topPairs.length > 0) {
        html += '<div style="margin-top:4px">';
        c.topPairs.forEach(function(p) {
          html += '<div class="collab-pair"><span class="collab-pair-route">' + esc(p.source) + ' &#8594; ' + esc(p.target) + '</span><span class="collab-pair-count">' + p.count + '</span></div>';
        });
        html += '</div>';
      }

      var agents = Object.keys(c.byAgent || {});
      if (agents.length > 0) {
        html += '<table class="collab-agents"><tr><th style="color:#555;font-size:10px">Agent</th><th style="color:#555;font-size:10px">Sent</th><th style="color:#555;font-size:10px">Recv</th></tr>';
        agents.sort().forEach(function(a) {
          var s = c.byAgent[a];
          html += '<tr><td style="color:#8af">' + esc(a) + '</td><td style="color:#2d8">' + s.sent + '</td><td>' + s.received + '</td></tr>';
        });
        html += '</table>';
      }

      if (c.triggers24h === 0) {
        html = '<div class="collab-header"><span class="collab-score collab-low">0</span><span class="collab-trend trend-stable">&#9654; no data</span></div>' +
          '<div class="collab-stats">No inter-agent collaboration yet</div>';
      }
      document.getElementById('collab').innerHTML = html;
    }

    // Admin Operations (with timeframe filtering)
    if (d.adminActivity && d.adminActivity.length > 0) {
      var adminSince = getTimeframeSince(adminTimeframe);
      var adminFiltered = adminSince
        ? d.adminActivity.filter(function(a) { return a.timestamp > adminSince; })
        : d.adminActivity;
      if (adminFiltered.length > 0) {
        var ahtml = '';
        adminFiltered.forEach(function(a) {
          var expanded = expandedAdminId === a.id;
          var details = '';
          if (expanded && a.details_json) {
            try {
              var dp = JSON.parse(a.details_json);
              var lines = Object.keys(dp).map(function(k) {
                var v = dp[k];
                if (v === null || v === undefined) return '';
                return k + ': ' + String(v).slice(0, 500);
              }).filter(function(x){return x});
              details = '<div class="activity-details">' + esc(lines.join('\\n')) + '</div>';
            } catch(ex) {}
          }
          ahtml += '<div class="activity-row" data-admin-id="' + a.id + '">' +
            getIcon(a.event_type) +
            '<span class="activity-summary">' + esc(a.summary) + '</span>' +
            '<span class="activity-time">' + timeAgo(a.timestamp) + '</span>' +
            details +
          '</div>';
        });
        document.getElementById('admin-ops').innerHTML = ahtml;
      } else {
        document.getElementById('admin-ops').innerHTML = '<div class="empty">No admin activity in this timeframe</div>';
      }
    } else {
      document.getElementById('admin-ops').innerHTML = '<div class="empty">No admin activity yet</div>';
    }

    // System metrics
    renderMetrics(d.metrics);

    document.getElementById('refresh').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('refresh').textContent = 'error: ' + e.message;
  }
  await refreshActivity();
}
refreshAll();
setInterval(refreshAll, 5000);
</script>
</body>
</html>`;
