import { Channel, NewMessage } from './types.js';

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map(
    (m) => `[${m.sender_name} at ${m.timestamp}]: ${m.content}`,
  );
  return lines.join('\n');
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  chatId: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsChatId(chatId) && c.isConnected());
  if (!channel) throw new Error(`No channel for chat ID: ${chatId}`);
  return channel.sendMessage(chatId, text);
}

export function findChannel(
  channels: Channel[],
  chatId: string,
): Channel | undefined {
  return channels.find((c) => c.ownsChatId(chatId));
}
