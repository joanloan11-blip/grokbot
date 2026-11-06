import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatMessage, Conversation, ProviderPublic } from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';
import { mapLimit, normalizeTasks, runDelegation } from '../src/orchestrator';

let handle: AppHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-orch-'));
  handle = await createApp(loadConfig({ dataDir, repoRoot }));
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

function send(method: string, pathname: string, body?: unknown) {
  return handle.app.request(pathname, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('orchestrator helpers', () => {
  it('runs with a concurrency limit and keeps order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value * 5));
      active--;
      return value * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });

  it('normalizes tasks', () => {
    expect(
      normalizeTasks([{ agent: ' self ', task: ' x ' }, { task: '' }, 'junk']),
    ).toEqual([{ agent: 'self', title: undefined, task: 'x' }]);
  });
});

describe('delegate tool', () => {
  it('runs subtasks in separate chats and returns all results', async () => {
    const providers = (await (
      await send('GET', '/api/providers')
    ).json()) as ProviderPublic[];
    const mock = providers.find((item) => item.kind === 'mock');
    const parent = (await (
      await send('POST', '/api/conversations', {
        locale: 'ru',
        providerId: mock?.id,
        model: 'mock',
      })
    ).json()) as Conversation;
    const payload = JSON.stringify({
      tasks: [
        { agent: 'self', title: 'Склад', task: 'add 2 3' },
        { agent: 'self', title: 'Конкуренты', task: 'echo цены' },
        { agent: 'Нет такого', title: 'Ошибка', task: 'x' },
      ],
    });
    await (
      await send('POST', `/api/conversations/${parent.id}/messages`, {
        content: `tool delegate ${payload}`,
        locale: 'ru',
      })
    ).text();
    const data = (await (
      await send('GET', `/api/conversations/${parent.id}`)
    ).json()) as {
      messages: ChatMessage[];
    };
    const tool = data.messages.find(
      (message) => message.role === 'tool' && message.toolName === 'delegate',
    );
    expect(tool?.content.startsWith('DELEGATE:')).toBe(true);
    const { results } = JSON.parse(tool?.content.slice(9) ?? '{}') as {
      results: {
        title: string;
        status: string;
        conversationId: string | null;
      }[];
    };
    expect(results.map((item) => [item.title, item.status])).toEqual([
      ['Склад', 'done'],
      ['Конкуренты', 'done'],
      ['Ошибка', 'error'],
    ]);
    // Чаты подзадач существуют, но в списке не видны: там промпты для других моделей.
    const chats = (await (
      await send('GET', '/api/conversations')
    ).json()) as Conversation[];
    expect(chats.some((chat) => chat.title.startsWith('Подзадача:'))).toBe(
      false,
    );
    const ids = results
      .map((item) => item.conversationId)
      .filter((id): id is string => Boolean(id));
    expect(ids).toHaveLength(2);
    for (const id of ids)
      expect(await handle.runtime.store.getConversation(id)).toBeTruthy();
  });

  it('refuses nested delegation', async () => {
    const agents = await handle.runtime.store.listAgents();
    const text = await runDelegation(handle.runtime, {
      from: agents[0]!,
      userId: 'local',
      conversationId: 'x',
      depth: 1,
      locale: 'ru',
      tasks: [{ task: 'y' }],
    });
    expect(text).toContain('не может');
  });
});
