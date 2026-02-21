/**
 * One-shot script to register Launch80 agent groups and create initial scheduled tasks.
 * Run with: npx tsx scripts/setup-agents.ts
 *
 * Safe to re-run — uses INSERT OR REPLACE for groups and skips existing tasks.
 * Use --force to update existing task prompts and schedules.
 */
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  initDatabase,
  setRegisteredGroup,
  deleteRegisteredGroup,
  createTask,
  deleteTask,
  getAllTasks,
  updateTask,
} from '../src/db.js';

const forceUpdate = process.argv.includes('--force');

const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Initialize the database
initDatabase();

// --- Register Groups (4 agents) ---

const groups = [
  {
    chatId: 'email:tag:admin',
    name: 'Admin',
    folder: 'main',
    tag: 'admin',
    model: 'ollama/qwen3:8b',
  },
  {
    chatId: 'email:tag:research',
    name: 'Research',
    folder: 'research',
    tag: 'research',
    model: 'ollama/qwen3:8b',
  },
  {
    chatId: 'email:tag:content',
    name: 'Content',
    folder: 'content',
    tag: 'content',
    model: 'ollama/qwen3:8b',
  },
  {
    chatId: 'email:tag:social',
    name: 'Social',
    folder: 'social',
    tag: 'social',
    model: 'ollama/qwen3:8b',
  },
];

for (const g of groups) {
  setRegisteredGroup(g.chatId, {
    name: g.name,
    folder: g.folder,
    tag: g.tag,
    added_at: new Date().toISOString(),
    model: g.model,
  });
  console.log(`Registered group: [${g.tag}] ${g.name} → ${g.folder}/`);
}

// --- Ensure workspace directories exist ---

const GROUPS_DIR = path.join(import.meta.dirname, '..', 'groups');
const workspaceDirs = [
  'content/daily',
  'content/drafts',
  'content/published',
  'content/twitter-replies',
  'content/twitter-replies/posted',
  'research/daily',
  'research/reports',
  'social/daily',
  'social/reddit-comments',
  'social/reddit-comments/posted',
  'social/reddit-dms',
  'social/reddit-dms/sent',
  'main/logs',
];
for (const dir of workspaceDirs) {
  fs.mkdirSync(path.join(GROUPS_DIR, dir), { recursive: true });
}
console.log(`Created ${workspaceDirs.length} workspace directories`);

// --- Clean up removed groups ---

const removedGroups = [
  { chatId: 'email:tag:growth', folder: 'growth' },
  { chatId: 'email:tag:ops', folder: 'ops' },
  { chatId: 'email:tag:product', folder: 'product' },
  { chatId: 'email:tag:community', folder: 'community' },
];
for (const rg of removedGroups) {
  const tasks = getAllTasks().filter((t) => t.group_folder === rg.folder);
  for (const t of tasks) {
    deleteTask(t.id);
    console.log(`Deleted task: ${t.id} (removed group: ${rg.folder})`);
  }
  deleteRegisteredGroup(rg.chatId);
  console.log(`Removed group: [${rg.folder}]`);
}

// --- Create Scheduled Tasks (8 tasks) ---

function nextCron(expr: string): string {
  return CronExpressionParser.parse(expr, { tz: TIMEZONE })
    .next()
    .toISOString();
}

function nextInterval(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

const existingIds = new Set(getAllTasks().map((t) => t.id));

// Delete old task IDs that no longer exist in the new config
const oldTaskIds = [
  'task-research-continuous-scan',
  'task-research-weekly-deep-dive',
  'task-growth-continuous-scan',
  'task-growth-weekly-report',
  'task-content-continuous-review',
  'task-content-daily-summary',
  'task-content-twitter-replies',
  'task-content-repurpose',
  'task-ops-continuous-health',
  'task-ops-daily-digest',
  'task-product-daily-standup',
  'task-product-weekly-review',
  'task-community-continuous-pulse',
  'task-community-weekly-spotlight',
  'task-social-continuous-scan',
  'task-social-weekly-strategy',
  'task-social-reddit-performance',
  'task-social-reddit-engagement',
  'task-main-team-review',
  'task-main-orchestration-summary',
];

const tasks = [
  // =============================================
  // Research (Nova) — scan every 2 hours + weekly deep dive
  // =============================================
  {
    id: 'task-research-scan',
    group_folder: 'research',
    chat_id: 'email:tag:research',
    prompt:
      'Use web_search to find 1-2 startup ecosystem news items (trends, funding rounds, founder tools). Read daily/ to check what you already logged today. If you found something NEW, append it to daily/YYYY-MM-DD.md. Then trigger_email(tag: "content", body: "<the finding and a suggested content angle>"). If nothing new, do nothing.',
    schedule_type: 'interval' as const,
    schedule_value: '7200000',
    context_mode: 'group' as const,
  },
  {
    id: 'task-research-weekly',
    group_folder: 'research',
    chat_id: 'email:tag:research',
    prompt:
      'Read all files in daily/ from this week. Pick the most important topic. Write a detailed report to reports/YYYY-MM-DD.md. Send summary via send_message(text: "Weekly research report: [topic]. Key takeaway: [1 sentence]", priority: "notify").',
    schedule_type: 'cron' as const,
    schedule_value: '0 14 * * 5',
    context_mode: 'group' as const,
  },

  // =============================================
  // Content (Echo) — review every 2 hours + twitter replies + daily summary
  // =============================================
  {
    id: 'task-content-review',
    group_folder: 'content',
    chat_id: 'email:tag:content',
    prompt:
      'Check for content opportunities. Use web_search to find 1 trending startup topic. Also check daily/ for any notes from previous runs. If you find a compelling topic, draft ONE tweet to drafts/draft-YYYYMMDD-HHMMSS.md following brand voice. NEVER use the "\u2014" character. Then send_message(text: "CONTENT DRAFT FOR APPROVAL:\\n\\n[full draft text]\\n\\nPlatform: Twitter\\nFile: drafts/[filename]\\n\\nReply approve to post, or reject to discard.", priority: "notify"). If nothing compelling, send_message(text: "No new content ideas", priority: "log"). Do NOT read inbox/.',
    schedule_type: 'interval' as const,
    schedule_value: '7200000',
    context_mode: 'group' as const,
  },
  {
    id: 'task-content-twitter-replies',
    group_folder: 'content',
    chat_id: 'email:tag:content',
    prompt:
      'Read twitter-replies/ to count today\'s drafts. If 3+ exist for today, send_message(text: "Twitter reply limit reached", priority: "log") and stop. Otherwise, use web_search(query: "recent tweets on X/Twitter from founders about startup challenges or building in public") to find 1 recent tweet by a founder. Draft a helpful reply (2-3 sentences, genuine insight, mention Discord https://discord.gg/UCzFGTwaD4?utm_source=twitter_reply naturally). NEVER use "\u2014". Save to twitter-replies/reply-YYYYMMDD-HHMMSS.md. Send_message(text: "TWITTER REPLY DRAFT:\\n\\nTweet by @[author]: [text]\\nURL: [url]\\n\\nReply:\\n[your reply]\\n\\nReply approve to post, or reject.", priority: "notify").',
    schedule_type: 'interval' as const,
    schedule_value: '14400000',
    context_mode: 'group' as const,
  },
  {
    id: 'task-content-daily-summary',
    group_folder: 'content',
    chat_id: 'email:tag:content',
    prompt:
      'Quick status check. Do these steps fast: 1. List files in drafts/ and count them (do NOT read contents). 2. List files in published/ and count them (do NOT read contents). 3. Append one line to calendar.md: "YYYY-MM-DD: X pending, Y published". 4. send_message(text: "CONTENT STATUS: X pending, Y published", priority: "digest"). Do NOT open or read file contents. Only count files. Finish in under 30 seconds.',
    schedule_type: 'cron' as const,
    schedule_value: '0 18 * * *',
    context_mode: 'group' as const,
  },

  // =============================================
  // Social (SocialSpark) — reddit engagement + trend scan
  // =============================================
  {
    id: 'task-social-reddit-engagement',
    group_folder: 'social',
    chat_id: 'email:tag:social',
    prompt:
      'Read reddit-comments/ to count today\'s drafts. If 3+ exist for today, send_message(text: "Reddit comment limit reached", priority: "log") and stop. Otherwise, use web_search(query: "recent Reddit posts in r/startups or r/Entrepreneur about idea validation, finding co-founders, or early-stage startup challenges") to find 1 recent post. Draft a 2-3 paragraph comment that leads with genuine advice and naturally mentions the Launch80 Discord (https://discord.gg/UCzFGTwaD4?utm_source=reddit). Save to reddit-comments/comment-YYYYMMDD-HHMMSS.md. Send_message(text: "REDDIT COMMENT DRAFT:\\n\\nSubreddit: [sub]\\nPost: [title]\\nURL: [url]\\n\\nComment:\\n[text]\\n\\nReply approve to post, or reject.", priority: "notify").',
    schedule_type: 'interval' as const,
    schedule_value: '10800000',
    context_mode: 'group' as const,
  },
  {
    id: 'task-social-scan',
    group_folder: 'social',
    chat_id: 'email:tag:social',
    prompt:
      'Use web_search to find 1-2 trending topics in the startup/founder space. Read daily/ to check what is already logged today. If you found something NEW, append to daily/YYYY-MM-DD.md with hook, hashtags, and optimal posting time. Then trigger_email(tag: "content", body: "<the trend, suggested hook, and hashtags>"). If nothing new, do nothing.',
    schedule_type: 'interval' as const,
    schedule_value: '10800000',
    context_mode: 'group' as const,
  },

  // =============================================
  // Admin — team review every 4 hours
  // =============================================
  {
    id: 'task-admin-review',
    group_folder: 'main',
    chat_id: 'email:tag:admin',
    prompt:
      'Call get_activity_log(limit: 30) to review recent agent activity. Identify the agent that needs direction most. Send 1 trigger_email with specific instructions to that agent. If all agents are productive, send_message(text: "Team status: all agents active, no issues", priority: "digest").',
    schedule_type: 'interval' as const,
    schedule_value: '14400000',
    context_mode: 'group' as const,
  },
];

let created = 0;
let updated = 0;
let skipped = 0;

// Delete old tasks that are no longer in the new config
const newTaskIds = new Set(tasks.map((t) => t.id));
for (const oldId of oldTaskIds) {
  if (!newTaskIds.has(oldId) && existingIds.has(oldId)) {
    deleteTask(oldId);
    console.log(`Deleted old task: ${oldId}`);
  }
}

for (const task of tasks) {
  if (existingIds.has(task.id)) {
    if (forceUpdate) {
      // Update the prompt and schedule, preserve status and run history
      updateTask(task.id, {
        prompt: task.prompt,
        schedule_type: task.schedule_type,
        schedule_value: task.schedule_value,
      });
      console.log(`Updated (--force): ${task.id}`);
      updated++;
    } else {
      console.log(`Skipped (already exists): ${task.id}`);
      skipped++;
    }
    continue;
  }

  const nextRun =
    task.schedule_type === 'cron'
      ? nextCron(task.schedule_value)
      : nextInterval(parseInt(task.schedule_value, 10));

  createTask({
    id: task.id,
    group_folder: task.group_folder,
    chat_id: task.chat_id,
    prompt: task.prompt,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    context_mode: task.context_mode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  console.log(
    `Created task: ${task.id} (${task.schedule_type}: ${task.schedule_value})`,
  );
  created++;
}

// --- Protect AppleScripts from agent modification ---
const scriptsDir = path.join(import.meta.dirname, '..', 'scripts');
try {
  execSync(`chmod 444 ${scriptsDir}/*.applescript`);
  console.log('Protected scripts/*.applescript (chmod 444)');
} catch {
  console.warn('Warning: could not chmod scripts/*.applescript');
}

console.log(
  `\nDone! ${groups.length} groups registered, ${created} created, ${updated} updated, ${skipped} skipped.`,
);
