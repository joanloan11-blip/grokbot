import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/prompt';

describe('system prompt', () => {
  it('asks the reasoner to use the language of the latest user message', () => {
    const russian = buildSystemPrompt([], 'ru', { persona: 'Ты редактор.' });
    const english = buildSystemPrompt([], 'en');
    expect(russian).toContain('языке последнего сообщения');
    expect(russian).not.toMatch(/^Ты — Маяк/);
    expect(english).toContain("same language as the user's latest message");
  });
});
