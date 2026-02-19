import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from './config.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL,
      auto_registered INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS email_threads (
      chat_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      subject TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS digest_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      group_folder TEXT,
      summary TEXT NOT NULL,
      details_json TEXT,
      task_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON activity_log(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_log_event_type ON activity_log(event_type);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add trigger_depth column for trigger email loop protection
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN trigger_depth INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Migration: drop container_config and requires_trigger if they exist (v1 → v2)
  // SQLite doesn't support DROP COLUMN before 3.35, so we just ignore the old columns
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN auto_registered INTEGER DEFAULT 0`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN model TEXT`);
  } catch {
    /* column already exists */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 */
export function storeChatMetadata(
  chatId: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatId, name, timestamp);
  } else {
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatId, chatId, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 */
export function updateChatName(chatId: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatId, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Store a message with full content.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, trigger_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_id,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.triggerDepth || 0,
  );
}

/**
 * Store a message directly (for channels that don't use the NewMessage constructor).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_id,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  chatIds: string[],
  lastTimestamp: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (chatIds.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = chatIds.map(() => '?').join(',');
  const sql = `
    SELECT id, chat_jid as chat_id, sender, sender_name, content, timestamp, trigger_depth as triggerDepth
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...chatIds) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatId: string,
  sinceTimestamp: string,
): NewMessage[] {
  const sql = `
    SELECT id, chat_jid as chat_id, sender, sender_name, content, timestamp, trigger_depth as triggerDepth
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatId, sinceTimestamp) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_id,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | (Omit<ScheduledTask, 'chat_id'> & { chat_jid: string })
    | undefined;
  if (!row) return undefined;
  return { ...row, chat_id: row.chat_jid } as unknown as ScheduledTask;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  const rows = db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as Array<Omit<ScheduledTask, 'chat_id'> & { chat_jid: string }>;
  return rows.map((r) => ({ ...r, chat_id: r.chat_jid }) as unknown as ScheduledTask);
}

export function getAllTasks(): ScheduledTask[] {
  const rows = db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as Array<Omit<ScheduledTask, 'chat_id'> & { chat_jid: string }>;
  return rows.map((r) => ({ ...r, chat_id: r.chat_jid }) as unknown as ScheduledTask);
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as Array<Omit<ScheduledTask, 'chat_id'> & { chat_jid: string }>;
  return rows.map((r) => ({ ...r, chat_id: r.chat_jid }) as unknown as ScheduledTask);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  chatId: string,
): (RegisteredGroup & { chatId: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(chatId) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        auto_registered: number | null;
        model: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    chatId: row.jid,
    name: row.name,
    folder: row.folder,
    tag: row.trigger_pattern,
    added_at: row.added_at,
    autoRegistered: row.auto_registered === 1,
    model: row.model || undefined,
  };
}

export function setRegisteredGroup(
  chatId: string,
  group: RegisteredGroup,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, auto_registered, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId,
    group.name,
    group.folder,
    group.tag,
    group.added_at,
    group.autoRegistered ? 1 : 0,
    group.model || null,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    auto_registered: number | null;
    model: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      tag: row.trigger_pattern,
      added_at: row.added_at,
      autoRegistered: row.auto_registered === 1,
      model: row.model || undefined,
    };
  }
  return result;
}

// --- Email thread accessors ---

export function getEmailThread(chatId: string): { message_id: string; subject: string | null } | undefined {
  return db
    .prepare('SELECT message_id, subject FROM email_threads WHERE chat_id = ?')
    .get(chatId) as { message_id: string; subject: string | null } | undefined;
}

export function setEmailThread(chatId: string, messageId: string, subject?: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO email_threads (chat_id, message_id, subject, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(chatId, messageId, subject || null, now);
}

// --- Activity log ---

export interface ActivityLogEntry {
  id: number;
  timestamp: string;
  event_type: string;
  group_folder: string | null;
  summary: string;
  details_json: string | null;
  task_id: string | null;
}

export function logActivity(entry: {
  event_type: string;
  group_folder?: string | null;
  summary: string;
  details?: Record<string, unknown> | null;
  task_id?: string | null;
}): void {
  db.prepare(
    `INSERT INTO activity_log (timestamp, event_type, group_folder, summary, details_json, task_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    entry.event_type,
    entry.group_folder || null,
    entry.summary,
    entry.details ? JSON.stringify(entry.details) : null,
    entry.task_id || null,
  );
}

export function getActivityLog(
  limit = 50,
  offset = 0,
  eventType?: string,
): ActivityLogEntry[] {
  if (eventType) {
    return db
      .prepare(
        `SELECT * FROM activity_log WHERE event_type = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      )
      .all(eventType, limit, offset) as ActivityLogEntry[];
  }
  return db
    .prepare(
      `SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as ActivityLogEntry[];
}

export function getTaskRunStats(
  taskId: string,
): { total: number; successes: number; failures: number; avg_duration_ms: number } {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failures,
        AVG(duration_ms) as avg_duration_ms
      FROM task_run_logs WHERE task_id = ?`,
    )
    .get(taskId) as {
    total: number;
    successes: number;
    failures: number;
    avg_duration_ms: number;
  };
  return row;
}

export function pruneActivityLog(keepDays = 7): void {
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
  db.prepare('DELETE FROM activity_log WHERE timestamp < ?').run(cutoff);
}

// --- Digest queue ---

export interface DigestItem {
  id: number;
  chat_id: string;
  group_folder: string;
  text: string;
  created_at: string;
}

export function queueDigestMessage(chatId: string, groupFolder: string, text: string): void {
  db.prepare(
    `INSERT INTO digest_queue (chat_id, group_folder, text, created_at) VALUES (?, ?, ?, ?)`,
  ).run(chatId, groupFolder, text, new Date().toISOString());
}

export function getAndClearDigestQueue(): DigestItem[] {
  const items = db
    .prepare('SELECT * FROM digest_queue ORDER BY created_at')
    .all() as DigestItem[];

  if (items.length > 0) {
    db.prepare('DELETE FROM digest_queue').run();
  }

  return items;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [chatId, group] of Object.entries(groups)) {
      setRegisteredGroup(chatId, group);
    }
  }
}
