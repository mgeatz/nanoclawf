export interface RegisteredGroup {
  name: string;
  folder: string;
  tag: string;
  added_at: string;
  autoRegistered?: boolean;
  model?: string;
}

export interface NewMessage {
  id: string;
  chat_id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  subject?: string;
  message_id?: string;
  triggerDepth?: number;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_id: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsChatId(chatId: string): boolean;
  disconnect(): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatId: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
export type OnChatMetadata = (chatId: string, timestamp: string, name?: string) => void;
