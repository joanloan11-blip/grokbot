import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Agent,
  ChatMessage,
  ClientEvent,
  Conversation,
  MemoryNote,
} from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';

let handle: AppHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-agents-'));
  handle = await createApp(loadConfig({ dataDir, repoRoot }));
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function send(
  pathname: string,
  body: unknown,
  method = 'POST',
): Promise<Response> {
  return handle.app.request(pathname, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readEvents(response: Response): Promise<ClientEvent[]> {
  const raw = await response.text();
  const events: ClientEvent[] = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((item) => item.startsWith('data:'));
    if (!line) continue;
    events.push(JSON.parse(line.slice(5).trim()) as ClientEvent);
  }
  return events;
}

describe('agents', () => {
  it('creates, updates and deletes an agent, and keeps chats separate', async () => {
    const listed = (await (
      await handle.app.request('/api/agents')
    ).json()) as Agent[];
    expect(listed.map((agent) => agent.name)).toContain('QASTOM AGENT');
    const primary = listed[0];
    expect(primary).toBeTruthy();

    const created = (await (
      await send('/api/agents', {
        name: 'Редактор',
        emoji: '✍️',
        description: 'Правит текст',
        systemPrompt: 'Ты редактор.',
        skillNames: ['summary'],
        mcpServerIds: [],
      })
    ).json()) as Agent;
    expect(created.name).toBe('Редактор');
    expect(created.emoji).toBe('✍️');

    const renamed = (await (
      await send(
        `/api/agents/${created.id}`,
        { description: 'Правит черновики' },
        'PATCH',
      )
    ).json()) as Agent;
    expect(renamed.description).toBe('Правит черновики');

    const primaryChat = (await (
      await send('/api/conversations', { agentId: primary?.id, locale: 'ru' })
    ).json()) as Conversation;
    const editorChat = (await (
      await send('/api/conversations', { agentId: created.id, locale: 'ru' })
    ).json()) as Conversation;
    expect(primaryChat.agentId).toBe(primary?.id);
    expect(editorChat.agentId).toBe(created.id);

    const primaryList = (await (
      await handle.app.request(`/api/conversations?agentId=${primary?.id}`)
    ).json()) as Conversation[];
    const editorList = (await (
      await handle.app.request(`/api/conversations?agentId=${created.id}`)
    ).json()) as Conversation[];
    expect(primaryList.some((item) => item.id === editorChat.id)).toBe(false);
    expect(editorList.map((item) => item.id)).toEqual([editorChat.id]);

    const removed = await handle.app.request(`/api/agents/${created.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    const last = await handle.app.request(`/api/agents/${primary?.id}`, {
      method: 'DELETE',
    });
    expect(last.status).toBe(400);
  });

  it('delivers send_to_agent into the other agent chat', async () => {
    const agents = (await (
      await handle.app.request('/api/agents')
    ).json()) as Agent[];
    const primary = agents.find((agent) => agent.name === 'QASTOM AGENT');
    expect(primary).toBeTruthy();
    const editor = (await (
      await send('/api/agents', {
        name: 'Редактор',
        emoji: '✍️',
        description: 'Правит текст',
        systemPrompt: 'Ты редактор.',
      })
    ).json()) as Agent;

    const chat = (await (
      await send('/api/conversations', { agentId: primary?.id })
    ).json()) as Conversation;
    const response = await send(`/api/conversations/${chat.id}/messages`, {
      content:
        'tool send_to_agent {"agent":"Редактор","message":"привет от маяка"}',
    });
    expect(response.status).toBe(200);
    const events = await readEvents(response);
    const tool = events.find(
      (event) => event.type === 'message' && event.message.role === 'tool',
    );
    expect(
      tool && tool.type === 'message' ? tool.message.content : '',
    ).toContain('привет от маяка');

    const inbox = (await (
      await handle.app.request(`/api/conversations?agentId=${editor.id}`)
    ).json()) as Conversation[];
    // Переписка агентов — служебная: в списке чатов её нет.
    expect(inbox.some((item) => item.title === 'От: QASTOM AGENT')).toBe(false);
    const owner = (await handle.runtime.store.listUsers())[0];
    const thread = await handle.runtime.store.findConversationByTitle(
      owner?.id ?? '',
      editor.id,
      'От: QASTOM AGENT',
    );
    expect(thread).toBeTruthy();
    const stored = (await (
      await handle.app.request(`/api/conversations/${thread?.id}`)
    ).json()) as { messages: ChatMessage[] };
    expect(
      stored.messages.some((message) =>
        message.content.includes('привет от маяка'),
      ),
    ).toBe(true);

    await handle.app.request(`/api/agents/${editor.id}`, { method: 'DELETE' });
  });

  it('stores memory through the built-in tool and runs a routine into a chat', async () => {
    const agents = (await (
      await handle.app.request('/api/agents')
    ).json()) as Agent[];
    const primary = agents.find((agent) => agent.name === 'QASTOM AGENT');
    expect(primary).toBeTruthy();
    const chat = (await (
      await send('/api/conversations', { agentId: primary?.id })
    ).json()) as Conversation;
    const memoryResponse = await send(
      `/api/conversations/${chat.id}/messages`,
      {
        content:
          'tool memory_write {"key":"project","content":"QASTOM AGENT хранит заметки"}',
      },
    );
    const memoryEvents = await readEvents(memoryResponse);
    const toolText = memoryEvents
      .filter(
        (event) => event.type === 'message' && event.message.role === 'tool',
      )
      .map((event) => (event.type === 'message' ? event.message.content : ''))
      .join('\n');
    const notes = (await (
      await handle.app.request(`/api/agents/${primary?.id}/memory`)
    ).json()) as MemoryNote[];
    expect(toolText, JSON.stringify(memoryEvents)).toContain('Запомнил');
    expect(notes.find((note) => note.key === 'project')?.content).toBe(
      'QASTOM AGENT хранит заметки',
    );

    const routineResponse = await send(`/api/agents/${primary?.id}/routines`, {
      name: 'Утро',
      cron: '0 9 * * 1-5',
      prompt: 'скажи одно слово: готово',
      enabled: true,
    });
    expect(routineResponse.status).toBe(201);
    const routine = (await routineResponse.json()) as { id: string };
    const bad = await send(`/api/agents/${primary?.id}/routines`, {
      name: 'Плохо',
      cron: 'не cron',
      prompt: 'нет',
    });
    expect(bad.status).toBe(400);

    const run = await send(
      `/api/agents/${primary?.id}/routines/${routine.id}/run`,
      {},
    );
    expect(run.status).toBe(200);
    const chats = (await (
      await handle.app.request(`/api/conversations?agentId=${primary?.id}`)
    ).json()) as Conversation[];
    const scheduled = chats.find((item) => item.title === 'Расписание: Утро');
    expect(scheduled).toBeTruthy();
    const detail = (await (
      await handle.app.request(`/api/conversations/${scheduled?.id}`)
    ).json()) as { messages: ChatMessage[] };
    expect(
      detail.messages.some(
        (message) =>
          message.role === 'assistant' && message.content.includes('готово'),
      ),
    ).toBe(true);
  });
});

describe('agent plugins', () => {
  it('hides built-in tools of disabled plugins', async () => {
    const { toolAllowedByPlugins } = await import('@mayak/shared');
    expect(toolAllowedByPlugins('web_search', null)).toBe(true);
    expect(toolAllowedByPlugins('web_search', ['stock'])).toBe(false);
    expect(toolAllowedByPlugins('stock_lookup', ['stock'])).toBe(true);
    expect(toolAllowedByPlugins('ask_user', [])).toBe(true);
    expect(toolAllowedByPlugins('mcp__amocrm__leads_get', [])).toBe(true);
  });
});
