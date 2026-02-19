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
  { chatId: 'email:tag:research', name: 'Research', folder: 'research', tag: 'research', model: 'ollama/qwen3-coder:30b' },
  { chatId: 'email:tag:growth', name: 'Growth', folder: 'growth', tag: 'growth', model: 'ollama/qwen3:8b' },
  { chatId: 'email:tag:content', name: 'Content', folder: 'content', tag: 'content', model: 'ollama/glm-4.7-flash' },
  { chatId: 'email:tag:ops', name: 'Ops', folder: 'ops', tag: 'ops', model: 'ollama/gemma3:4b' },
  { chatId: 'email:tag:product', name: 'Product', folder: 'product', tag: 'product', model: 'ollama/llama3.1:8b' },
  { chatId: 'email:tag:community', name: 'Community', folder: 'community', tag: 'community', model: 'ollama/gemma3:4b' },
  { chatId: 'email:tag:social', name: 'Social', folder: 'social', tag: 'social', model: 'ollama/qwen3:8b' },
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

// --- Create Scheduled Tasks ---

function nextCron(expr: string): string {
  return CronExpressionParser.parse(expr, { tz: TIMEZONE }).next().toISOString();
}

function nextInterval(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

const existingIds = new Set(getAllTasks().map((t) => t.id));

const tasks = [
  // =============================================
  // Research (Nova) — continuous scan every 20 min + weekly deep dive
  // =============================================
  {
    id: 'task-research-continuous-scan',
    group_folder: 'research',
    chat_id: 'email:tag:research',
    prompt:
      'Continuous trend scan: Review research/daily/ for your most recent findings and only report NET NEW items — skip anything you have already logged. Search the web for startup ecosystem news — new accelerators, founder tools, funding trends, competitor studios. Append only new findings to research/daily/ (use today\'s date as filename, append to existing file if present). If anything is directly relevant to Launch80\'s positioning as a startup studio and you haven\'t already flagged it, use trigger_email to send it to [content] with a suggested content angle. Only send_message to admin if you found something genuinely new and noteworthy.',
    schedule_type: 'interval' as const,
    schedule_value: '1200000',
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

  // =============================================
  // Growth (Ledger) — continuous scan every 20 min + weekly report
  // =============================================
  {
    id: 'task-growth-continuous-scan',
    group_folder: 'growth',
    chat_id: 'email:tag:growth',
    prompt:
      'Continuous funding scan: Review growth/funding-landscape.md for your most recent entries and only report NET NEW data — skip anything already logged. Search the web for recent startup funding news — angel investment rounds, pre-seed/seed deals, new fund announcements, changing deal terms. Append only new data points to growth/funding-landscape.md with timestamps. Only alert admin via send_message if there is a genuinely new major shift (new fund >$50M, regulatory changes, major trend reversal) that you have not previously reported.',
    schedule_type: 'interval' as const,
    schedule_value: '1200000',
    context_mode: 'group' as const,
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

  // =============================================
  // Content (Echo) — continuous review every 45 min + daily summary
  // =============================================
  {
    id: 'task-content-continuous-review',
    group_folder: 'content',
    chat_id: 'email:tag:content',
    prompt:
      'Continuous content review: Check content/inbox/ for any NEW ideas dropped by other agents since your last check. Review content/calendar.md for upcoming items. If there are new ideas worth drafting, create 1-2 social media posts (Twitter/X and LinkedIn) about Launch80 or startup advice to content/drafts/ with today\'s date. Update content/calendar.md. Send new drafts to admin via send_message for approval. If no new ideas since last check, skip silently — do not send a message. Remember: you NEVER post directly — always draft for human review.',
    schedule_type: 'interval' as const,
    schedule_value: '2700000',
    context_mode: 'group' as const,
  },
  {
    id: 'task-content-daily-summary',
    group_folder: 'content',
    chat_id: 'email:tag:content',
    prompt:
      'Daily content summary: Review all content/drafts/ from today. Compile a summary of what was drafted, what\'s pending approval, and what\'s scheduled for this week in content/calendar.md. Send a concise end-of-day content status to admin via send_message.',
    schedule_type: 'cron' as const,
    schedule_value: '0 18 * * *',
    context_mode: 'group' as const,
  },

  // =============================================
  // Ops (Sentinel) — continuous health every 15 min + daily digest
  // =============================================
  {
    id: 'task-ops-continuous-health',
    group_folder: 'ops',
    chat_id: 'email:tag:ops',
    prompt:
      'Continuous health check: Use get_system_status to check NanoClaw health. Use list_tasks to verify all scheduled tasks are running (no stale tasks). If everything is fine, log silently — do NOT send a message. Only alert admin via send_message if something is wrong (IMAP disconnected, tasks failing, agents timing out, unusual patterns). Review the last few task run results for errors.',
    schedule_type: 'interval' as const,
    schedule_value: '900000',
    context_mode: 'isolated' as const,
  },
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

  // =============================================
  // Product (Atlas) — daily standup + weekly review (unchanged)
  // =============================================
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

  // =============================================
  // Community (Harbor) — continuous pulse every 60 min + weekly spotlight
  // =============================================
  {
    id: 'task-community-continuous-pulse',
    group_folder: 'community',
    chat_id: 'email:tag:community',
    prompt:
      'Continuous community pulse: Review community/daily-prompts/ for what you have already posted today. If you have already done 2 or more prompts today, skip silently. Otherwise, think about what would spark meaningful discussion in the Launch80 Discord right now. Consider current startup news, common founder challenges, trending topics. Draft a discussion prompt or founder tip to community/daily-prompts/ with today\'s date and a sequence number. Send it to admin via send_message for posting in Discord.',
    schedule_type: 'interval' as const,
    schedule_value: '3600000',
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

  // =============================================
  // Social (SocialSpark) — continuous scan every 20 min + weekly strategy
  // =============================================
  {
    id: 'task-social-continuous-scan',
    group_folder: 'social',
    chat_id: 'email:tag:social',
    prompt:
      'Continuous social & SEO scan: Review social/daily/ for your most recent findings and only report NET NEW trends — skip anything already logged. Search the web for trending topics in the startup/founder space across Reddit, X, and Instagram. Identify new viral patterns — what hooks are working, which formats are getting reach, what hashtags are trending. Check for algorithm updates or platform changes. Append only new findings to social/daily/ (use today\'s date as filename, append if exists). If you find genuinely new content ideas not already sent, use trigger_email to send the top items to [content] Echo with specific SEO angles, suggested hooks, optimal posting times, and hashtag strategies. Only send_message to admin if there is a noteworthy new trend.',
    schedule_type: 'interval' as const,
    schedule_value: '1200000',
    context_mode: 'group' as const,
  },
  {
    id: 'task-social-weekly-strategy',
    group_folder: 'social',
    chat_id: 'email:tag:social',
    prompt:
      'Weekly growth strategy report: Review your social/daily/ files from this week. Compile what trending topics and viral patterns you found, platform algorithm updates, and competitor social media moves. Write a strategic growth plan for next week to social/reports/ with this week\'s date — include specific post ideas with hooks, SEO keywords, suggested formats (carousel, thread, reel), and optimal posting times for each platform. Update social/seo-keywords.md with any new target keywords. Send the full report to admin via send_message.',
    schedule_type: 'cron' as const,
    schedule_value: '0 16 * * 5',
    context_mode: 'group' as const,
  },

  // =============================================
  // Social (SocialSpark) — Reddit engagement every 2 hours
  // =============================================
  {
    id: 'task-social-reddit-engagement',
    group_folder: 'social',
    chat_id: 'email:tag:social',
    prompt:
      'Reddit engagement scan: Search relevant startup subreddits (r/startups, r/Entrepreneur, r/SideProject, r/smallbusiness, r/indiehackers, r/nocode, r/SaaS) for recent posts where Launch80 can add genuine value. Look for founders asking questions about idea validation, startup tools, community, mentorship, or early-stage challenges. Check groups/social/reddit-comments/ for today\'s drafts — if you already have 3 or more for today, skip silently with priority "log". For the most relevant post found, draft a helpful comment following the Reddit Engagement Workflow in your CLAUDE.md. The comment must lead with real value and naturally mention the Launch80 Discord (https://discord.gg/UCzFGTwaD4). Save the draft to groups/social/reddit-comments/ with frontmatter (id, subreddit, post_title, post_url, status: pending). Send the draft to admin via send_message with priority: "notify" including the post context, URL, and your drafted comment with approval instructions. If no worthy posts found, use priority: "log".',
    schedule_type: 'interval' as const,
    schedule_value: '7200000',
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
