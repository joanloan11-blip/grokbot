import { describe, expect, it } from 'vitest';
import { fitBody } from '../src/providers/http';

describe('fitBody: тело запроса через прокси не больше лимита', () => {
  it('сначала ужимает старые результаты инструментов, вопрос не трогает', () => {
    const body = {
      model: 'gpt',
      messages: [
        { role: 'system', content: 'sys'.repeat(100) },
        { role: 'user', content: 'найди' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'a',
              type: 'function',
              function: { name: 'web_search', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: 'r'.repeat(30_000) },
        { role: 'user', content: `вопрос ${'q'.repeat(2000)}` },
      ],
    };
    const out = fitBody(body, 12_000);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(12_000);
    const messages = out.messages as { role: string; content: string }[];
    expect(messages[3]!.content).toContain('сокращено');
    expect(messages.at(-1)!.content).toHaveLength(2007);
    expect(messages[0]!.content).toHaveLength(300);
  });

  it('маленькое тело не меняет', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    expect(fitBody(body, 1000)).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
    });
  });
});
