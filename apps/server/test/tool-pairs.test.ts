import { describe, expect, it } from 'vitest';
import { repairToolCalls } from '../src/turn';
import type { ModelMessage } from '../src/providers/types';

const call = (id: string) => ({ id, name: 'web_search', arguments: '{}' });

describe('ремонт пар tool_call → tool', () => {
  it('не трогает корректную историю', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'привет' },
      { role: 'assistant', content: '', toolCalls: [call('a')] },
      { role: 'tool', content: 'результат', toolCallId: 'a' },
    ];
    expect(repairToolCalls(history)).toEqual(history);
  });

  it('добавляет заглушку, если ответа инструмента нет', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'найди цену' },
      { role: 'assistant', content: '', toolCalls: [call('a')] },
      { role: 'user', content: 'что?' },
    ];
    const fixed = repairToolCalls(history);
    expect(fixed).toHaveLength(4);
    expect(fixed[2]).toMatchObject({ role: 'tool', toolCallId: 'a' });
    expect(fixed[2]!.content).toContain('Результата нет');
    expect(fixed[3]).toMatchObject({ role: 'user', content: 'что?' });
  });

  it('закрывает только недостающий вызов из двух', () => {
    const history: ModelMessage[] = [
      { role: 'assistant', content: '', toolCalls: [call('a'), call('b')] },
      { role: 'tool', content: 'ok', toolCallId: 'a' },
      { role: 'user', content: 'дальше' },
    ];
    const fixed = repairToolCalls(history);
    expect(fixed.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(fixed[1]).toMatchObject({ toolCallId: 'a', content: 'ok' });
    expect(fixed[2]).toMatchObject({ toolCallId: 'b' });
  });

  it('выбрасывает результат без вызова', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'привет' },
      { role: 'tool', content: 'сирота', toolCallId: 'zzz' },
      { role: 'assistant', content: 'ответ' },
    ];
    expect(repairToolCalls(history).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('сохраняет несколько ответов на несколько вызовов', () => {
    const history: ModelMessage[] = [
      { role: 'assistant', content: '', toolCalls: [call('a'), call('b')] },
      { role: 'tool', content: '1', toolCallId: 'a' },
      { role: 'tool', content: '2', toolCallId: 'b' },
    ];
    expect(repairToolCalls(history)).toEqual(history);
  });
});
