/**
 * Localhost status dashboard for NanoClaw.
 * Serves a self-contained HTML page on MONITOR_PORT.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import { DATA_DIR, MONITOR_PORT, GROUPS_DIR } from './config.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getDueTasks,
} from './db.js';
import { getTriggerCountThisHour } from './ipc.js';
import { logger } from './logger.js';

export interface MonitorState {
  activeAgents: () => Record<string, { chatId: string; startedAt: number }>;
}

const startTime = Date.now();

export function startMonitor(state: MonitorState): void {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getStatus(state)));
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
  } catch { /* ignore */ }

  // Groups
  const groups = getAllRegisteredGroups();
  const groupList = Object.entries(groups).map(([chatId, g]) => ({
    chatId,
    name: g.name,
    folder: g.folder,
    tag: g.tag,
  }));

  // Tasks
  const tasks = getAllTasks().map((t) => ({
    id: t.id,
    group: t.group_folder,
    prompt: t.prompt.slice(0, 80),
    schedule: `${t.schedule_type}: ${t.schedule_value}`,
    status: t.status,
    nextRun: t.next_run,
    lastRun: t.last_run,
    lastResult: t.last_result?.slice(0, 80) || null,
  }));

  // Recent chats
  const chats = getAllChats().slice(0, 20);

  // Active agents
  const agents = state.activeAgents();

  // Recent logs (last 5 log files per group)
  const recentLogs: Array<{ group: string; file: string; lines: string }> = [];
  try {
    for (const g of groupList) {
      const logsDir = path.join(GROUPS_DIR, g.folder, 'logs');
      if (!fs.existsSync(logsDir)) continue;
      const files = fs.readdirSync(logsDir)
        .filter((f) => f.endsWith('.log'))
        .sort()
        .slice(-3);
      for (const file of files) {
        const content = fs.readFileSync(path.join(logsDir, file), 'utf-8');
        // Extract key info: duration, exit code
        const durationMatch = content.match(/Duration: (\d+)ms/);
        const exitMatch = content.match(/Exit Code: (\d+)/);
        const timedMatch = content.match(/Timed Out: (true|false)/);
        recentLogs.push({
          group: g.folder,
          file,
          lines: [
            durationMatch ? `${Math.round(parseInt(durationMatch[1]) / 1000)}s` : '?',
            exitMatch ? `exit:${exitMatch[1]}` : '',
            timedMatch?.[1] === 'true' ? 'TIMEOUT' : '',
          ].filter(Boolean).join(' '),
        });
      }
    }
  } catch { /* ignore */ }

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
    })),
    triggersThisHour: getTriggerCountThisHour(),
    recentLogs,
  };
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

const HTML_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>NanoClaw</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #c8c8c8; font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; font-size: 13px; padding: 20px; }
  h1 { color: #e0e0e0; font-size: 16px; margin-bottom: 16px; }
  h2 { color: #a0a0a0; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin: 20px 0 8px; border-bottom: 1px solid #222; padding-bottom: 4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .full { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: #666; font-weight: normal; padding: 4px 8px; }
  td { padding: 4px 8px; border-top: 1px solid #1a1a1a; }
  tr:nth-child(even) td { background: #111; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .green { background: #2d8; }
  .red { background: #d44; }
  .yellow { background: #da2; }
  .status-bar { display: flex; gap: 24px; padding: 10px 12px; background: #111; border-radius: 4px; margin-bottom: 16px; flex-wrap: wrap; }
  .status-item { display: flex; align-items: center; gap: 6px; }
  .status-val { color: #e0e0e0; }
  .refresh { position: fixed; top: 12px; right: 16px; color: #444; font-size: 11px; }
  .badge { padding: 1px 6px; border-radius: 3px; font-size: 11px; }
  .badge-active { background: #1a3a2a; color: #2d8; }
  .badge-paused { background: #3a3a1a; color: #da2; }
  .badge-completed { background: #1a1a2a; color: #68c; }
  .prompt { color: #888; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: #444; font-style: italic; padding: 8px; }
</style>
</head>
<body>
<h1>NanoClaw</h1>
<div class="refresh" id="refresh">...</div>
<div class="status-bar" id="status-bar"></div>
<div class="grid">
  <div>
    <h2>Groups</h2>
    <div id="groups"></div>
  </div>
  <div>
    <h2>Active Agents</h2>
    <div id="agents"></div>
  </div>
  <div class="full">
    <h2>Scheduled Tasks</h2>
    <div id="tasks"></div>
  </div>
  <div>
    <h2>Recent Chats</h2>
    <div id="chats"></div>
  </div>
  <div>
    <h2>Recent Logs</h2>
    <div id="logs"></div>
  </div>
</div>
<script>
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? d+'d '+h+'h '+m+'m' : h > 0 ? h+'h '+m+'m' : m+'m';
}
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function badge(s) { return '<span class="badge badge-'+s+'">'+s+'</span>'; }
function table(headers, rows) {
  if (!rows.length) return '<div class="empty">None</div>';
  let h = '<table><tr>' + headers.map(h => '<th>'+h+'</th>').join('') + '</tr>';
  h += rows.map(r => '<tr>' + r.map(c => '<td>'+c+'</td>').join('') + '</tr>').join('');
  return h + '</table>';
}
function timeAgo(iso) {
  if (!iso) return '-';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.floor(ms/60000)+'m ago';
  if (ms < 86400000) return Math.floor(ms/3600000)+'h ago';
  return Math.floor(ms/86400000)+'d ago';
}
async function refresh() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    const hb = d.heartbeat;
    document.getElementById('status-bar').innerHTML = [
      '<div class="status-item"><span class="dot '+(hb?.imap_connected ? 'green' : 'red')+'"></span>IMAP</div>',
      '<div class="status-item">Uptime: <span class="status-val">'+fmt(d.uptime_ms)+'</span></div>',
      '<div class="status-item">Groups: <span class="status-val">'+d.groups.length+'</span></div>',
      '<div class="status-item">Tasks: <span class="status-val">'+d.tasks.length+'</span></div>',
      '<div class="status-item">Triggers/hr: <span class="status-val">'+d.triggersThisHour+'</span></div>',
    ].join('');
    document.getElementById('groups').innerHTML = table(
      ['Tag', 'Name', 'Folder'],
      d.groups.map(g => ['['+esc(g.tag)+']', esc(g.name), esc(g.folder)])
    );
    document.getElementById('agents').innerHTML = d.activeAgents.length
      ? table(['Group', 'Running'], d.activeAgents.map(a => [esc(a.group), fmt(a.running_ms)]))
      : '<div class="empty">No agents running</div>';
    document.getElementById('tasks').innerHTML = table(
      ['ID', 'Group', 'Prompt', 'Schedule', 'Status', 'Next Run'],
      d.tasks.map(t => [
        esc(t.id.slice(-8)), esc(t.group),
        '<span class="prompt" title="'+esc(t.prompt)+'">'+esc(t.prompt)+'</span>',
        esc(t.schedule), badge(t.status),
        t.nextRun ? timeAgo(t.nextRun) : '-'
      ])
    );
    document.getElementById('chats').innerHTML = table(
      ['Chat', 'Last Activity'],
      d.chats.map(c => [esc(c.name), timeAgo(c.last_message_time)])
    );
    document.getElementById('logs').innerHTML = table(
      ['Group', 'Log', 'Info'],
      d.recentLogs.map(l => [esc(l.group), esc(l.file.slice(-20)), esc(l.lines)])
    );
    document.getElementById('refresh').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('refresh').textContent = 'error: ' + e.message;
  }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
