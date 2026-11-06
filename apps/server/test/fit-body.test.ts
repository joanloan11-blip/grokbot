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
    expect(messages.map((m) => m.role)).toContain('user');
    expect(messages[0]!.content).toHaveLength(300);
  });

  it('свежий длинный результат инструмента тоже ужимается, вопрос пользователя остаётся', () => {
    const body = {
      messages: [
        { role: 'system', content: 's'.repeat(1900) },
        { role: 'user', content: 'глянь на гитхабе mcp' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'a' }] },
        { role: 'tool', tool_call_id: 'a', content: 'r'.repeat(20_000) },
      ],
      tools: Array.from({ length: 30 }, (_, i) => ({
        type: 'function',
        function: {
          name: `t${i}`,
          description: 'd'.repeat(300),
          parameters: {},
        },
      })),
    };
    const out = fitBody(body, 16_000);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(16_000);
    const messages = out.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
  });

  it('маленькое тело не меняет', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    expect(fitBody(body, 1000)).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
    });
  });
});
