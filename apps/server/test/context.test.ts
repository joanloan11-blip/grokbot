import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@mayak/shared';
import type { ProviderRow, Store } from '../src/db';
import { compactHistory, cutIndex } from '../src/context';
import type { ModelMessage } from '../src/providers/types';
import { buildHistory } from '../src/turn';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeStore(): Store {
  const settings = new Map<string, string>();
  return {
    getSetting: async (key: string) => settings.get(key),
    setSetting: async (key: string, value: string) =>
      void settings.set(key, value),
    insertUsage: async () => 'u',
    getUpload: async () => undefined,
  } as unknown as Store;
}

const provider: ProviderRow = {
  id: 'p',
  name: 'P',
  kind: 'openai',
  baseUrl: 'https://ctx.test/v1',
  apiKey: 'k',
  models: ['m'],
  enabled: true,
  createdAt: '',
  ownerUserId: null,
};

function longHistory(turns: number): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `вопрос ${i} ${'x'.repeat(1500)}` });
    out.push({ role: 'assistant', content: `ответ ${i} ${'y'.repeat(1500)}` });
  }
  return out;
}

describe('context saving', () => {
  it('cuts on a user message', () => {
    const history = longHistory(10);
    const cut = cutIndex(history, 5);
    expect(history[cut]?.role).toBe('user');
    expect(history.length - cut).toBeGreaterThanOrEqual(5);
  });

  it('summarizes old messages once and reuses the summary', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'СВОДКА: договорились о рейке' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    }) as typeof fetch;
    const store = fakeStore();
    const history = longHistory(20);
    const input = {
      history,
      conversationId: 'c',
      provider,
      model: 'm',
      userId: 'u',
      agentId: 'a',
    };
    const first = await compactHistory(store, input);
    expect(first[0]?.role).toBe('system');
    expect(first[0]?.content).toContain('СВОДКА');
    expect(first.length).toBeLessThan(history.length);
    const chars = (list: ModelMessage[]) =>
      list.reduce((sum, item) => sum + item.content.length, 0);
    expect(chars(first)).toBeLessThan(chars(history) / 2);
    await compactHistory(store, input);
    expect(calls).toBe(1);
  });

  it('keeps short chats untouched', async () => {
    const history = longHistory(3);
    expect(
      await compactHistory(fakeStore(), {
        history,
        conversationId: 'c2',
        provider,
        model: 'm',
        userId: 'u',
        agentId: 'a',
      }),
    ).toBe(history);
  });

  it('trims old tool results but keeps the current turn', async () => {
    const big = 'z'.repeat(5000);
    const messages: ChatMessage[] = [
      {
        id: '1',
        conversationId: 'c',
        role: 'user',
        content: 'склад',
        createdAt: '1',
      },
      {
        id: '2',
        conversationId: 'c',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'stock_lookup', arguments: '{}' }],
        createdAt: '2',
      },
      {
        id: '3',
        conversationId: 'c',
        role: 'tool',
        content: big,
        toolCallId: 't1',
        toolName: 'stock_lookup',
        createdAt: '3',
      },
      {
        id: '4',
        conversationId: 'c',
        role: 'assistant',
        content: 'есть',
        createdAt: '4',
      },
      {
        id: '5',
        conversationId: 'c',
        role: 'user',
        content: 'ещё',
        createdAt: '5',
      },
      {
        id: '6',
        conversationId: 'c',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't2', name: 'stock_lookup', arguments: '{}' }],
        createdAt: '6',
      },
      {
        id: '7',
        conversationId: 'c',
        role: 'tool',
        content: big,
        toolCallId: 't2',
        toolName: 'stock_lookup',
        createdAt: '7',
      },
    ] as ChatMessage[];
    const history = await buildHistory(fakeStore(), messages, 'openai');
    expect(history[2]?.content.length).toBeLessThan(2000);
    expect(history[2]?.content).toContain('сокращено');
    expect(history[6]?.content.length).toBe(5000);
  });
});
