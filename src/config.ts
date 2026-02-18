import path from 'path';

import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'IMAP_HOST',
  'IMAP_PORT',
  'SMTP_HOST',
  'SMTP_PORT',
  'EMAIL_ADDRESS',
  'EMAIL_PASSWORD',
  'NOTIFICATION_EMAIL',
  'MAIN_TAG',
  'OPENCODE_MODEL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';

export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

const PROJECT_ROOT = process.cwd();

export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

// Email configuration
export const IMAP_HOST = process.env.IMAP_HOST || envConfig.IMAP_HOST || '';
export const IMAP_PORT = parseInt(process.env.IMAP_PORT || envConfig.IMAP_PORT || '993', 10);
export const SMTP_HOST = process.env.SMTP_HOST || envConfig.SMTP_HOST || '';
export const SMTP_PORT = parseInt(process.env.SMTP_PORT || envConfig.SMTP_PORT || '587', 10);
export const EMAIL_ADDRESS = process.env.EMAIL_ADDRESS || envConfig.EMAIL_ADDRESS || '';
export const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || envConfig.EMAIL_PASSWORD || '';
export const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || envConfig.NOTIFICATION_EMAIL || '';
export const EMAIL_POLL_INTERVAL = parseInt(
  process.env.EMAIL_POLL_INTERVAL || '10000',
  10,
);

// Tag for the main/admin channel
export const MAIN_TAG = (process.env.MAIN_TAG || envConfig.MAIN_TAG || 'ADMIN').toUpperCase();

// OpenCode configuration
export const OPENCODE_MODEL = process.env.OPENCODE_MODEL || envConfig.OPENCODE_MODEL || 'ollama/qwen2.5-coder:32b';
export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || '1800000',
  10,
);
export const MAX_CONCURRENT_AGENTS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_AGENTS || '5', 10) || 5,
);

export const IPC_POLL_INTERVAL = 1000;

// Timezone for scheduled tasks (cron expressions, etc.)
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
