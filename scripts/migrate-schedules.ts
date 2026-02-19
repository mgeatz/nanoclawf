/**
 * Migration script: delete old daily/interval tasks being replaced by continuous schedules.
 * Run BEFORE setup-agents.ts to avoid ID conflicts.
 *
 * Usage: npx tsx scripts/migrate-schedules.ts
 */
import { initDatabase, getAllTasks } from '../src/db.js';
import Database from 'better-sqlite3';
import path from 'path';

initDatabase();

const STORE_DIR = path.resolve(process.cwd(), 'store');
const db = new Database(path.join(STORE_DIR, 'messages.db'));

const OLD_TASK_IDS = [
  'task-research-daily-scan',
  'task-growth-funding-scan',
  'task-content-daily-review',
  'task-ops-health-check',
  'task-community-daily-pulse',
  'task-social-daily-scan',
];

let deleted = 0;
const existingIds = new Set(getAllTasks().map((t) => t.id));

for (const id of OLD_TASK_IDS) {
  if (existingIds.has(id)) {
    // Delete associated run logs first (foreign key constraint)
    const logsDeleted = db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    console.log(`Deleted old task: ${id} (${logsDeleted.changes} run logs cleared)`);
    deleted++;
  } else {
    console.log(`Skipped (not found): ${id}`);
  }
}

db.close();
console.log(`\nMigration complete: ${deleted} old tasks deleted.`);
