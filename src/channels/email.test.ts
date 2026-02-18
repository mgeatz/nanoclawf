import { describe, it, expect } from 'vitest';

// Test email channel helpers without requiring IMAP/SMTP connections

const TAG_REGEX = /\[([^\]]+)\]/;

describe('email tag extraction', () => {
  it('extracts lowercase tag from subject', () => {
    const match = '[Family] Hello world'.match(TAG_REGEX);
    expect(match).toBeTruthy();
    expect(match![1].toLowerCase()).toBe('family');
  });

  it('extracts ADMIN tag', () => {
    const match = '[ADMIN] Check status'.match(TAG_REGEX);
    expect(match).toBeTruthy();
    expect(match![1].toUpperCase()).toBe('ADMIN');
  });

  it('returns null for no tag', () => {
    const match = 'No tag here'.match(TAG_REGEX);
    expect(match).toBeNull();
  });

  it('handles tag with spaces', () => {
    const match = '[my project] Update'.match(TAG_REGEX);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('my project');
  });
});

describe('email self-to-self filter', () => {
  const EMAIL_ADDRESS = 'user@example.com';
  const NOTIFICATION_EMAIL = 'notify@example.com';

  function shouldProcess(from: string, toList: string[]): boolean {
    const myEmail = EMAIL_ADDRESS.toLowerCase();
    const notifyEmail = NOTIFICATION_EMAIL.toLowerCase();

    // Self-to-self filter
    if (from.toLowerCase() !== myEmail || !toList.some((t) => t.toLowerCase() === myEmail)) {
      return false;
    }
    // Ignore bot replies
    if (toList.some((t) => t.toLowerCase() === notifyEmail)) {
      return false;
    }
    return true;
  }

  it('processes self-to-self email', () => {
    expect(shouldProcess('user@example.com', ['user@example.com'])).toBe(true);
  });

  it('rejects email from someone else', () => {
    expect(shouldProcess('other@example.com', ['user@example.com'])).toBe(false);
  });

  it('rejects email to someone else', () => {
    expect(shouldProcess('user@example.com', ['other@example.com'])).toBe(false);
  });

  it('rejects bot reply (to notification email)', () => {
    expect(shouldProcess('user@example.com', ['user@example.com', 'notify@example.com'])).toBe(false);
  });

  it('handles case-insensitive matching', () => {
    expect(shouldProcess('User@Example.COM', ['USER@EXAMPLE.COM'])).toBe(true);
  });
});

describe('email chatId format', () => {
  it('produces correct chatId from tag', () => {
    const tag = 'family';
    const chatId = `email:tag:${tag}`;
    expect(chatId).toBe('email:tag:family');
  });

  it('ownsChatId checks prefix', () => {
    const ownsChatId = (id: string) => id.startsWith('email:tag:');
    expect(ownsChatId('email:tag:family')).toBe(true);
    expect(ownsChatId('whatsapp:123')).toBe(false);
    expect(ownsChatId('email:tag:')).toBe(true);
  });
});

describe('email body extraction', () => {
  it('strips signature at -- delimiter', () => {
    const body = 'Hello world\n\nThis is my message\n-- \nJohn Doe\nSent from my iPhone';
    const sigIndex = body.indexOf('\n-- \n');
    const stripped = sigIndex !== -1 ? body.slice(0, sigIndex).trim() : body.trim();
    expect(stripped).toBe('Hello world\n\nThis is my message');
  });

  it('preserves body without signature', () => {
    const body = 'Hello world\n\nThis is my message';
    const sigIndex = body.indexOf('\n-- \n');
    const stripped = sigIndex !== -1 ? body.slice(0, sigIndex).trim() : body.trim();
    expect(stripped).toBe('Hello world\n\nThis is my message');
  });
});
