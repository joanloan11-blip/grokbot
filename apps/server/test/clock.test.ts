import { describe, expect, it } from 'vitest';
import { dateLine, withClock } from '../src/clock';

describe('дата и время для модели', () => {
  const now = new Date('2026-11-06T18:12:00Z');
  it('дата в системном промпте, без минут', () => {
    const line = dateLine('ru', now, 'Asia/Yekaterinburg');
    expect(line).toContain('пятница, 6 ноября 2026');
    expect(line).toContain('UTC+5');
    expect(line).not.toContain('23:12');
  });
  it('точное время — в последнем сообщении пользователя, остальные не трогаем', () => {
    const out = withClock(
      [
        { role: 'user', content: 'первый' },
        { role: 'assistant', content: 'ответ' },
        { role: 'user', content: 'который час?' },
      ],
      'ru',
      now,
      'Asia/Yekaterinburg',
    );
    expect(out[0]!.content).toBe('первый');
    expect(out[2]!.content).toBe(
      '[Сейчас: пятница, 6 ноября 2026 г., 23:12]\nкоторый час?',
    );
  });
});
