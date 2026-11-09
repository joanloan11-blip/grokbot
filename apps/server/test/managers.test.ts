import { deliverToAgent } from '../src/turn';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Agent, Conversation, Project, PublicUser } from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildAgentPrompt } from '../../web/src/agent-context';
import { AGENT_TEMPLATES } from '../src/templates';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';
import { formatStock, searchStock } from '../src/moysklad';

let handle: AppHandle;
let dataDir: string;
let admin = '';
let manager = '';
let other = '';

function cookieOf(response: Response): string {
  const pair = response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0] ?? '')
    .find((item) => item.startsWith('mayak_session='));
  if (!pair) throw new Error('нет сессии');
  return pair;
}

function call(
  method: string,
  pathname: string,
  cookie: string,
  body?: unknown,
) {
  const headers = new Headers({ cookie });
  if (body !== undefined) headers.set('content-type', 'application/json');
  return handle.app.request(pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function registerManager(email: string): Promise<string> {
  const created = await handle.app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'manager-pass-1' }),
  });
  const user = ((await created.json()) as { user: PublicUser }).user;
  await call('PATCH', `/api/admin/users/${user.id}`, admin, {
    status: 'active',
  });
  const login = await handle.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'manager-pass-1' }),
  });
  return cookieOf(login);
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-managers-'));
  handle = await createApp(
    loadConfig({
      dataDir,
      repoRoot,
      authEnabled: true,
      jwtSecret: 's',
      secureCookie: false,
    }),
  );
  admin = cookieOf(
    await handle.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@x.ru', password: 'admin-pass-1' }),
    }),
  );
  const providers = (await (
    await call('GET', '/api/providers', admin)
  ).json()) as {
    id: string;
    models: string[];
  }[];
  const demo = providers[0];
  await call('PUT', '/api/admin/models/shared', admin, {
    models: [{ providerId: demo?.id, model: demo?.models[0] }],
  });
  manager = await registerManager('m1@x.ru');
  other = await registerManager('m2@x.ru');
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('personal agents', () => {
  let mine: Agent;

  it('a newly registered user can create a niche agent without changing existing agents', async () => {
    const before = (await (
      await call('GET', '/api/agents', admin)
    ).json()) as Agent[];
    const templates = await call('GET', '/api/agent-templates', manager);
    expect(templates.status).toBe(200);
    expect(await templates.json()).toEqual(AGENT_TEMPLATES);
    const template = AGENT_TEMPLATES.find(
      (item) => item.id === 'market-analyst',
    );
    if (!template) throw new Error('missing template');
    const systemPrompt = buildAgentPrompt(
      template.systemPrompt,
      'Фотосъёмка',
      'Сравнить цены студий',
    );
    const response = await call('POST', '/api/agents', manager, {
      name: 'Аналитик фотостудий',
      systemPrompt,
      skillNames: [],
      mcpServerIds: [],
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as Agent;
    const saved = (await (
      await call('GET', `/api/agents/${created.id}`, manager)
    ).json()) as Agent;
    expect(saved.systemPrompt).toBe(systemPrompt);
    expect(saved.ownerId).toBeTruthy();
    expect(saved.skillNames).toEqual([]);
    expect(saved.mcpServerIds).toEqual([]);
    expect((await call('GET', `/api/agents/${created.id}`, other)).status).toBe(
      404,
    );
    for (const agent of before) {
      const after = (await (
        await call('GET', `/api/agents/${agent.id}`, admin)
      ).json()) as Agent;
      expect(after.systemPrompt).toBe(agent.systemPrompt);
    }
  });

  it('keeps names unique per owner rather than across all users', async () => {
    const shared = await call('POST', '/api/agents', admin, { name: 'Разработчик' });
    expect(shared.status).toBe(201);
    const sharedAgent = await shared.json() as Agent;
    const first = await call('POST', '/api/agents', manager, { name: 'Разработчик' });
    expect(first.status).toBe(201);
    const personal = await first.json() as Agent;
    expect((await call('POST', '/api/agents', other, { name: 'Разработчик' })).status).toBe(201);
    expect((await call('POST', '/api/agents', manager, { name: ' разработчик ' })).status).toBe(400);
    expect((await call('POST', '/api/agents', admin, { name: 'Разработчик' })).status).toBe(400);
    expect((await call('GET', `/api/agents/${personal.id}`, other)).status).toBe(404);
    const second = await call('POST', '/api/agents', manager, { name: 'Другое имя' });
    expect(second.status).toBe(201);
    const secondAgent = await second.json() as Agent;
    expect((await call('PATCH', `/api/agents/${secondAgent.id}`, manager, { name: 'Разработчик' })).status).toBe(400);
    expect((await call('PATCH', `/api/agents/${personal.id}`, manager, { description: 'Обновлено' })).status).toBe(200);
    expect((await call('PATCH', `/api/agents/${personal.id}`, admin, { shared: true })).status).toBe(400);
    expect((await handle.runtime.store.getAgent(personal.id))?.ownerId).toBe(personal.ownerId);
    expect((await handle.runtime.store.getAgent(sharedAgent.id))?.ownerId).toBeNull();
    if (!personal.ownerId) throw new Error('missing owner');
    const forwarded = await deliverToAgent(handle.runtime, { from: secondAgent, userId: personal.ownerId, targetName: 'Разработчик', message: 'Привет', depth: 0, locale: 'ru' });
    expect(forwarded).not.toContain('не найден');
    expect(await handle.runtime.store.findConversationByTitle(personal.ownerId, personal.id, `От: ${secondAgent.name}`)).toBeTruthy();
    expect(await handle.runtime.store.findConversationByTitle(personal.ownerId, sharedAgent.id, `От: ${secondAgent.name}`)).toBeUndefined();

    // Убираем только фикстуры, чтобы не влиять на последующие проверки общего списка.
    for (const agent of await handle.runtime.store.listAgents()) {
      if ([sharedAgent.id, personal.id, secondAgent.id].includes(agent.id) || agent.name === 'Разработчик')
        await handle.runtime.store.deleteAgent(agent.id);
    }
  });

  it('a manager creates a private agent', async () => {
    const response = await call('POST', '/api/agents', manager, {
      name: 'Мой продажник',
      systemPrompt: 'Помогай продавать',
      mcpServerIds: ['should-be-ignored'],
    });
    expect(response.status).toBe(201);
    mine = (await response.json()) as Agent;
    expect(mine.ownerId).toBeTruthy();
    expect(mine.mcpServerIds).toEqual([]);
    const list = (await (
      await call('GET', '/api/agents', manager)
    ).json()) as Agent[];
    expect(list.map((agent) => agent.id)).toContain(mine.id);
  });

  it('other managers cannot see or edit it', async () => {
    const list = (await (
      await call('GET', '/api/agents', other)
    ).json()) as Agent[];
    expect(list.map((agent) => agent.id)).not.toContain(mine.id);
    expect(
      (await call('PATCH', `/api/agents/${mine.id}`, other, { name: 'x' }))
        .status,
    ).toBe(404);
    expect((await call('DELETE', `/api/agents/${mine.id}`, other)).status).toBe(
      404,
    );
  });

  it('the owner edits it; shared agents stay admin-only', async () => {
    const edited = await call('PATCH', `/api/agents/${mine.id}`, manager, {
      description: 'Avito',
    });
    expect(edited.status).toBe(200);
    const agents = (await (
      await call('GET', '/api/agents', admin)
    ).json()) as Agent[];
    const shared = agents.find((agent) => !agent.ownerId);
    if (!shared) throw new Error('нет общего агента');
    const users = (await (
      await call('GET', '/api/admin/users', admin)
    ).json()) as PublicUser[];
    const m1 = users.find((user) => user.email === 'm1@x.ru');
    await call('PATCH', `/api/admin/users/${m1?.id}`, admin, {
      agentIds: [shared.id],
    });
    expect(
      (
        await call('PATCH', `/api/agents/${shared.id}`, manager, {
          name: 'hack',
        })
      ).status,
    ).toBe(403);
  });

  it('the admin can publish a personal agent to the team', async () => {
    const response = await call('PATCH', `/api/agents/${mine.id}`, admin, {
      shared: true,
    });
    expect(response.status).toBe(200);
    const after = (await (
      await call('GET', `/api/agents/${mine.id}`, manager)
    ).json()) as Agent;
    expect(after.ownerId).toBeNull();
  });
});

describe('projects', () => {
  let project: Project;

  it('creates a project and starts a chat inside it', async () => {
    const created = await call('POST', '/api/projects', manager, {
      name: 'ООО Ромашка',
      client: 'Иван, Камаз',
      instructions: 'Клиент берёт рейки на Камаз, скидка 5%.',
    });
    expect(created.status).toBe(201);
    project = (await created.json()) as Project;
    const agents = (await (
      await call('GET', '/api/agents', manager)
    ).json()) as Agent[];
    const chat = (await (
      await call('POST', '/api/conversations', manager, {
        locale: 'ru',
        agentId: agents[0]?.id,
        projectId: project.id,
      })
    ).json()) as Conversation;
    expect(chat.projectId).toBe(project.id);
    const inProject = (await (
      await call('GET', `/api/conversations?projectId=${project.id}`, manager)
    ).json()) as Conversation[];
    expect(inProject.map((item) => item.id)).toEqual([chat.id]);
  });

  it('keeps projects private', async () => {
    const list = (await (
      await call('GET', '/api/projects', other)
    ).json()) as Project[];
    expect(list).toEqual([]);
    expect(
      (await call('PATCH', `/api/projects/${project.id}`, other, { name: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (await (
        await call('GET', `/api/conversations?projectId=${project.id}`, other)
      ).json()) as unknown[],
    ).toEqual([]);
  });

  it('deleting a project keeps its chats', async () => {
    expect(
      (await call('DELETE', `/api/projects/${project.id}`, manager)).status,
    ).toBe(200);
    const all = (await (
      await call('GET', '/api/conversations', manager)
    ).json()) as Conversation[];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((item) => !item.projectId)).toBe(true);
  });
});

describe('moysklad stock', () => {
  it('merges assortment and per-store stock', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        const body = url.includes('/entity/assortment')
          ? {
              rows: [
                {
                  id: 'p1',
                  name: 'Рейка рулевая Камаз 5320',
                  article: 'RR-5320',
                  code: '00123',
                  stock: 5,
                  reserve: 2,
                  quantity: 3,
                  salePrices: [{ value: 4_500_000 }],
                },
              ],
            }
          : {
              rows: [
                {
                  meta: {
                    href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1?expand=x',
                  },
                  stockByStore: [
                    { name: 'Екатеринбург', stock: 4, reserve: 2 },
                    { name: 'Челябинск', stock: 1, reserve: 0 },
                    { name: 'Москва', stock: 0, reserve: 0 },
                  ],
                },
              ],
            };
        return new Response(JSON.stringify(body), { status: 200 });
      });
    try {
      const items = await searchStock('token', 'Камаз 5320');
      expect(items[0]?.price).toBe(45_000);
      expect(items[0]?.available).toBe(3);
      expect(items[0]?.stores.map((store) => store.name)).toEqual([
        'Екатеринбург',
        'Челябинск',
      ]);
      const text = formatStock('Камаз 5320', items);
      expect(text).toContain('арт. RR-5320');
      expect(text).toContain('доступно: 3 шт.');
      expect(text).toContain('Екатеринбург: 4 (резерв 2)');
    } finally {
      fetchMock.mockRestore();
    }
  });
});
