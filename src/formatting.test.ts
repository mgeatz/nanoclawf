import { describe, it, expect } from 'vitest';

import {
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_id: 'email:tag:family',
    sender: 'user@example.com',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- formatMessages (plain text) ---

describe('formatMessages', () => {
  it('formats a single message as plain text', () => {
    const result = formatMessages([makeMsg()]);
    expect(result).toBe(
      '[Alice at 2024-01-01T00:00:00.000Z]: hello',
    );
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({ id: '1', sender_name: 'Alice', content: 'hi', timestamp: 't1' }),
      makeMsg({ id: '2', sender_name: 'Bob', content: 'hey', timestamp: 't2' }),
    ];
    const result = formatMessages(msgs);
    expect(result).toContain('[Alice at t1]: hi');
    expect(result).toContain('[Bob at t2]: hey');
  });

  it('handles special characters without escaping (plain text)', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })]);
    expect(result).toContain('[A & B <Co> at');
  });

  it('handles empty array', () => {
    const result = formatMessages([]);
    expect(result).toBe('');
  });
});

// --- Outbound formatting (internal tag stripping) ---

describe('stripInternalTags', () => {
  it('strips single-line internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multi-line internal tags', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world'),
    ).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(
      stripInternalTags(
        '<internal>a</internal>hello<internal>b</internal>',
      ),
    ).toBe('hello');
  });

  it('returns empty string when text is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });
});

describe('formatOutbound', () => {
  it('returns text with internal tags stripped', () => {
    expect(formatOutbound('hello world')).toBe('hello world');
  });

  it('returns empty string when all text is internal', () => {
    expect(formatOutbound('<internal>hidden</internal>')).toBe('');
  });

  it('strips internal tags from remaining text', () => {
    expect(
      formatOutbound('<internal>thinking</internal>The answer is 42'),
    ).toBe('The answer is 42');
  });
});
