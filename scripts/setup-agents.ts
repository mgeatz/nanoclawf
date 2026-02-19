/**
 * One-shot script to register Launch80 agent groups and create initial scheduled tasks.
 * Run with: npx tsx scripts/setup-agents.ts
 *
 * Safe to re-run — uses INSERT OR REPLACE for groups and skips existing tasks.
 */
import { CronExpressionParser } from 'cron-parser';

import { initDatabase, setRegisteredGroup, createTask, getAllTasks } from '../src/db.js';

const TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Initialize the database
initDatabase();

// --- Register Groups ---

const groups = [
  { chatId: 'email:tag:research', name: 'Research', folder: 'research', tag: 'research' },
  { chatId: 'email:tag:growth', name: 'Growth', folder: 'growth', tag: 'growth' },
  { chatId: 'email:tag:content', name: 'Content', folder: 'content', tag: 'content' },
  { chatId: 'email:tag:ops', name: 'Ops', folder: 'ops', tag: 'ops' },
  { chatId: 'email:tag:product', name: 'Product', folder: 'product', tag: 'product' },
  { chatId: 'email:tag:community', name: 'Community', folder: 'community', tag: 'community' },
];

for (const g of groups) {
  setRegisteredGroup(g.chatId, {
    name: g.name,
    folder: g.folder,
    tag: g.tag,
    added_at: new Date().toISOString(),
  });
  console.log(`Registered group: [${g.tag}] ${g.name} → ${g.folder}/`);
}

// --- Create Scheduled Tasks ---

function nextCron(expr: string): string {
  return CronExpressionParser.parse(expr, { tz: TIMEZONE }).next().toISOString();
}

function nextInterval(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

const existingIds = new Set(getAllTasks().map((t) => t.id));

const tasks = [
  // --- Research (Nova) ---
  {
    id: 'task-research-daily-scan',
    group_folder: 'research',
    chat_id: 'email:tag:research',
    prompt:
      'Daily trend scan: Search the web for startup ecosystem news from the last 24 hours — new accelerators, founder tools, funding trends, competitor studios. Save findings to research/daily/ with today\'s date as filename. If anything is directly relevant to Launch80\'s positioning as a startup studio, use trigger_email to send it to [content] with a suggested content angle. Send a brief summary of the top 3 findings to admin via send_message.',
    schedule_type: 'cron' as const,
    schedule_value: '30 8 * * *',
    context_mode: 'group' as const,
  },
  {
    id: 'task-research-weekly-deep-dive',
    group_folder: 'research',
    chat_id: 'email:tag:research',
    prompt:
      'Weekly deep dive: Review your research/daily/ files from this week. Pick the most important or interesting topic. Do a thorough deep dive — check multiple sources, analyze implications for Launch80. Write a detailed report to research/reports/ with this week\'s date. Send a summary to admin via send_message.',
    schedule_type: 'cron' as const,
    schedule_value: '0 14 * * 5',
    context_mode: 'group' as const,
  },

  // --- Growth (Ledger) ---
  {
    id: 'task-growth-funding-scan',
    group_folder: 'growth',
    chat_id: 'email:tag:growth',
    prompt:
      'Funding landscape scan: Search the web for recent startup funding news — angel investment rounds, pre-seed/seed deals, new fund announcements, changing deal terms. Append key data points to growth/funding-landscape.md with today\'s date. Only alert admin via send_message if there\'s a major shift (new fund >$50M, regulatory changes, major trend reversal).',
    schedule_type: 'interval' as const,
    schedule_value: '21600000',
    context_mode: 'isolated' as const,
  },
  {
    id: 'task-growth-weekly-report',
    group_folder: 'growth',
    chat_id: 'email:tag:growth',
    prompt:
      'Weekly growth report: Review growth/funding-landscape.md for this week\'s data. Compile a summary of funding trends, notable deals, and what it means for Launch80\'s angel investment strategy. Save to growth/weekly/ with this week\'s date. Send the report to admin via send_message. If any data point would make compelling content, trigger [content] with the data and a suggested angle.',
    schedule_type: 'cron' as const,
    schedule_value: '0 9 * * 1',
    context_mode: 'group' as const,
  },

  // --- Content (Echo) ---
  {
    id: 'task-content-daily-review',
    group_folder: 'content',
    chat_id: 'email:tag:content',
    prompt:
      'Daily content review: Check content/inbox/ for any ideas dropped by other agents. Also review content/calendar.md for what\'s scheduled. Draft 1-2 social media posts (Twitter/X and LinkedIn) about Launch80 or startup advice to content/drafts/ with today\'s date. Update content/calendar.md. Send the drafts to admin via send_message for approval. Remember: you NEVER post directly — always draft for human review.',
    schedule_type: 'cron' as const,
    schedule_value: '0 10 * * *',
    context_mode: 'group' as const,
  },

  // --- Ops (Sentinel) ---
  {
    id: 'task-ops-daily-digest',
    group_folder: 'ops',
    chat_id: 'email:tag:ops',
    prompt:
      'Daily digest: Check system status with get_system_status. Then scan sibling workspaces for recent activity: ../research/daily/ (latest scan), ../growth/funding-landscape.md (recent entries), ../content/drafts/ (pending drafts), ../product/backlog.md (active items), ../community/daily-prompts/ (latest prompt). Compile a morning briefing in the LAUNCH80 DAILY DIGEST format from your CLAUDE.md. Save to ops/digests/ and send to admin via send_message.',
    schedule_type: 'cron' as const,
    schedule_value: '0 8 * * *',
    context_mode: 'isolated' as const,
  },
  {
    id: 'task-ops-health-check',
    group_folder: 'ops',
    chat_id: 'email:tag:ops',
    prompt:
      'System health check: Use get_system_status to check NanoClaw health. Use list_tasks to verify all scheduled tasks are running (no stale tasks). If everything is fine, log silently — do NOT send a message. Only alert admin via send_message if something is wrong (IMAP disconnected, tasks failing, agents timing out).',
    schedule_type: 'interval' as const,
    schedule_value: '14400000',
    context_mode: 'isolated' as const,
  },

  // --- Product (Atlas) ---
  {
    id: 'task-product-daily-standup',
    group_folder: 'product',
    chat_id: 'email:tag:product',
    prompt:
      'Daily standup: Review product/backlog.md and product/projects/ for active work items. If these files don\'t exist yet, create them with initial structure (backlog with sections for P0/P1/P2, projects folder). Send a brief standup to admin via send_message using the PRODUCT STANDUP format from your CLAUDE.md.',
    schedule_type: 'cron' as const,
    schedule_value: '0 9 * * *',
    context_mode: 'group' as const,
  },
  {
    id: 'task-product-weekly-review',
    group_folder: 'product',
    chat_id: 'email:tag:product',
    prompt:
      'Weekly product review: Review product/changelog.md and product/backlog.md. Compile the week\'s progress — what shipped, what slipped, what changed priority. Plan next week\'s priorities. If something shipped that\'s worth announcing, use trigger_email to [content] with the details. Send the full review to admin via send_message.',
    schedule_type: 'cron' as const,
    schedule_value: '0 17 * * 5',
    context_mode: 'group' as const,
  },

  // --- Community (Harbor) ---
  {
    id: 'task-community-daily-pulse',
    group_folder: 'community',
    chat_id: 'email:tag:community',
    prompt:
      'Daily community pulse: Think about what would spark meaningful discussion in the Launch80 Discord today. Consider what stage most founders are at, common challenges, recent startup news. Draft a discussion prompt or founder tip to community/daily-prompts/ with today\'s date. Send it to admin via send_message for posting in Discord.',
    schedule_type: 'cron' as const,
    schedule_value: '30 9 * * *',
    context_mode: 'group' as const,
  },
  {
    id: 'task-community-weekly-spotlight',
    group_folder: 'community',
    chat_id: 'email:tag:community',
    prompt:
      'Weekly founder spotlight: Draft a "founder spotlight" template or success story angle that celebrates founders in the Launch80 community. Think about common founder challenges and triumphs. Save to community/spotlights/ with this week\'s date. Use trigger_email to [content] with a social media angle. Send the draft to admin via send_message.',
    schedule_type: 'cron' as const,
    schedule_value: '0 15 * * 3',
    context_mode: 'group' as const,
  },
];

let created = 0;
let skipped = 0;

for (const task of tasks) {
  if (existingIds.has(task.id)) {
    console.log(`Skipped (already exists): ${task.id}`);
    skipped++;
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

  console.log(`Created task: ${task.id} (${task.schedule_type}: ${task.schedule_value})`);
  created++;
}

console.log(`\nDone! ${groups.length} groups registered, ${created} tasks created, ${skipped} tasks skipped.`);
