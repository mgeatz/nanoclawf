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
  getTaskById,
  updateTask,
} from './db.js';
import { getTriggerCountThisHour } from './ipc.js';
import { logger } from './logger.js';
import { ScheduledTask } from './types.js';

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

    // Trigger a task to run now by setting next_run to now
    const triggerMatch = req.url?.match(/^\/api\/trigger\/(.+)$/);
    if (triggerMatch && req.method === 'POST') {
      const taskId = decodeURIComponent(triggerMatch[1]);
      const task = getTaskById(taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      // Set next_run to now so the scheduler picks it up
      updateTask(taskId, { next_run: new Date().toISOString(), status: 'active' });
      logger.info({ taskId }, 'Task manually triggered from dashboard');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, taskId }));
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
    fullPrompt: t.prompt,
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

  // Recent logs (last 3 log files per group)
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

const HTML_PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>NanoClaw — Launch80</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #c8c8c8; font-family: 'SF Mono', 'Menlo', 'Consolas', monospace; font-size: 13px; padding: 20px; }
  h1 { color: #e0e0e0; font-size: 16px; margin-bottom: 16px; display: flex; align-items: center; gap: 12px; }
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
  .top-bar { position: fixed; top: 12px; right: 16px; display: flex; align-items: center; gap: 12px; }
  .refresh { color: #444; font-size: 11px; }
  .badge { padding: 1px 6px; border-radius: 3px; font-size: 11px; }
  .badge-active { background: #1a3a2a; color: #2d8; }
  .badge-paused { background: #3a3a1a; color: #da2; }
  .badge-completed { background: #1a1a2a; color: #68c; }
  .prompt { color: #888; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: #444; font-style: italic; padding: 8px; }
  .btn { background: #1a1a2a; color: #8af; border: 1px solid #333; border-radius: 3px; padding: 2px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }
  .btn:hover { background: #252540; border-color: #8af; }
  .btn:active { background: #303050; }
  .btn-help { background: #1a1a1a; color: #888; border: 1px solid #333; border-radius: 50%; width: 24px; height: 24px; cursor: pointer; font-size: 13px; font-family: inherit; display: flex; align-items: center; justify-content: center; }
  .btn-help:hover { color: #e0e0e0; border-color: #666; }
  .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 100; justify-content: center; align-items: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: #111; border: 1px solid #333; border-radius: 8px; max-width: 700px; width: 90%; max-height: 85vh; overflow-y: auto; padding: 24px; }
  .modal h3 { color: #e0e0e0; font-size: 15px; margin-bottom: 16px; }
  .modal h4 { color: #a0a0a0; font-size: 13px; margin: 16px 0 6px; }
  .modal p, .modal li { color: #999; line-height: 1.6; margin-bottom: 8px; }
  .modal ul { padding-left: 20px; }
  .modal .close { float: right; background: none; border: none; color: #666; cursor: pointer; font-size: 18px; font-family: inherit; }
  .modal .close:hover { color: #e0e0e0; }
  .modal code { background: #1a1a1a; padding: 1px 5px; border-radius: 3px; color: #8af; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: #1a3a2a; color: #2d8; padding: 8px 16px; border-radius: 4px; font-size: 12px; display: none; z-index: 200; }
</style>
</head>
<body>
<h1>NanoClaw <span style="color:#555;font-size:12px;font-weight:normal">Launch80 Agent Network</span></h1>
<div class="top-bar">
  <span class="refresh" id="refresh">...</span>
  <button class="btn-help" onclick="toggleHelp()" title="Help">?</button>
</div>
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
<div class="toast" id="toast"></div>
<div class="modal-overlay" id="help-modal" onclick="if(event.target===this)toggleHelp()">
  <div class="modal">
    <button class="close" onclick="toggleHelp()">&times;</button>
    <h3>NanoClaw Dashboard</h3>
    <p>This is the monitoring dashboard for NanoClaw, the AI agent network powering Launch80. It auto-refreshes every 5 seconds.</p>

    <h4>Status Bar</h4>
    <ul>
      <li><strong>IMAP</strong> — Green dot means the email connection is live. Red means disconnected.</li>
      <li><strong>Uptime</strong> — How long NanoClaw has been running since last restart.</li>
      <li><strong>Groups</strong> — Number of registered agent groups (tags).</li>
      <li><strong>Tasks</strong> — Total scheduled tasks across all agents.</li>
      <li><strong>Triggers/hr</strong> — Cross-agent trigger emails sent this hour (limit: 30/hr).</li>
    </ul>

    <h4>Groups</h4>
    <p>All registered agent groups. Each group is an independent agent with its own persona, workspace, and CLAUDE.md instructions. Email tag (e.g., <code>[research]</code>) routes messages to that group.</p>

    <h4>Active Agents</h4>
    <p>Agents currently processing a task or message. Shows which group is running and for how long. If an agent runs longer than 30 minutes, it will be killed.</p>

    <h4>Scheduled Tasks</h4>
    <p>All recurring and one-time tasks. Each row shows the task ID, which agent it belongs to, a prompt summary, schedule (cron expression or interval), status, and when it next fires. Click <strong>Run Now</strong> to manually trigger a task immediately.</p>

    <h4>Recent Chats</h4>
    <p>Last 20 chat groups with activity timestamps. Shows when each group last received an email.</p>

    <h4>Recent Logs</h4>
    <p>Last few agent execution logs per group. Shows duration and exit code. <code>exit:0</code> = success. <code>TIMEOUT</code> = agent was killed after 30 minutes.</p>

    <h4>How Agents Communicate</h4>
    <ul>
      <li><strong>Email in:</strong> Send yourself an email with <code>[tag] subject</code> to trigger an agent.</li>
      <li><strong>Email out:</strong> Agent responses go to <code>NOTIFICATION_EMAIL</code>.</li>
      <li><strong>Cross-agent:</strong> Agents use <code>trigger_email</code> to send work to other agents.</li>
      <li><strong>Scheduled:</strong> Tasks fire automatically on their schedule (cron/interval).</li>
    </ul>

    <h4>Agent Roster</h4>
    <ul>
      <li><code>[admin]</code> — Overseer, delegates work, approves content</li>
      <li><code>[research]</code> Nova — Startup ecosystem intelligence</li>
      <li><code>[growth]</code> Ledger — Funding landscape and metrics</li>
      <li><code>[content]</code> Echo — Brand and content marketing</li>
      <li><code>[ops]</code> Sentinel — Operations, daily digest, health checks</li>
      <li><code>[product]</code> Atlas — DIY Portal, platform features, backlog</li>
      <li><code>[community]</code> Harbor — Discord community, founder relations</li>
    </ul>
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
  if (ms < 0) return 'in ' + fmt(-ms);
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return Math.floor(ms/60000)+'m ago';
  if (ms < 86400000) return Math.floor(ms/3600000)+'h ago';
  return Math.floor(ms/86400000)+'d ago';
}
function toggleHelp() {
  const m = document.getElementById('help-modal');
  m.classList.toggle('open');
}
async function triggerTask(id) {
  try {
    const r = await fetch('/api/trigger/' + encodeURIComponent(id), { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      showToast('Task triggered: ' + id.slice(-12));
      refresh();
    } else {
      showToast('Error: ' + (d.error || 'unknown'));
    }
  } catch(e) {
    showToast('Error: ' + e.message);
  }
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3000);
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
      ['ID', 'Group', 'Prompt', 'Schedule', 'Status', 'Next Run', ''],
      d.tasks.map(t => [
        esc(t.id.slice(-12)), esc(t.group),
        '<span class="prompt" title="'+esc(t.fullPrompt || t.prompt)+'">'+esc(t.prompt)+'</span>',
        esc(t.schedule), badge(t.status),
        t.nextRun ? timeAgo(t.nextRun) : '-',
        '<button class="btn" onclick="triggerTask(\''+esc(t.id)+'\')">Run Now</button>'
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
