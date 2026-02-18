import { describe, it, expect } from 'vitest';

// --- chatId ownership patterns ---

describe('chatId ownership patterns', () => {
  it('email tag chatId: starts with email:tag:', () => {
    const chatId = 'email:tag:family';
    expect(chatId.startsWith('email:tag:')).toBe(true);
  });

  it('unknown chatId format: does not match email patterns', () => {
    const chatId = 'unknown:12345';
    expect(chatId.startsWith('email:tag:')).toBe(false);
  });
});

// --- Tag extraction from subject ---

describe('tag extraction from subject', () => {
  const TAG_REGEX = /\[([^\]]+)\]/;

  it('extracts tag from subject', () => {
    const match = '[family] Hello world'.match(TAG_REGEX);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('family');
  });

  it('extracts ADMIN tag', () => {
    const match = '[ADMIN] Do something'.match(TAG_REGEX);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('ADMIN');
  });

  it('extracts first tag when multiple present', () => {
    const match = '[work] Re: [project] Update'.match(TAG_REGEX);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('work');
  });

  it('returns null for subject without tag', () => {
    const match = 'Hello world'.match(TAG_REGEX);
    expect(match).toBeNull();
  });

  it('handles empty brackets', () => {
    const match = '[] Hello'.match(TAG_REGEX);
    expect(match).toBeNull();
  });
});
