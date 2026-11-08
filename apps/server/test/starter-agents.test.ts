import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PublicUser } from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';
import {
  DIGEST_PROMPT,
  ensureStarterAgents,
  seedStarterAgents,
} from '../src/seed-agents';

let handle: AppHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-starters-'));
  handle = await createApp(
    loadConfig({
      dataDir,
      repoRoot,
      authEnabled: true,
      jwtSecret: 'test-secret',
      secureCookie: false,
    }),
  );
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

function cookieHeader(response: Response): string {
  const pair = response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0] ?? '')
    .find((item) => item.startsWith('mayak_session='));
  if (!pair) throw new Error('сессия не установлена');
  return pair;
}

async function register(
  email: string,
): Promise<{ user: PublicUser; cookie?: string }> {
  const response = await handle.app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password1', name: email }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { user: PublicUser };
  const cookie = response.headers
    .getSetCookie()
    .some((item) => item.startsWith('mayak_session='))
    ? cookieHeader(response)
    : undefined;
  return { user: body.user, ...(cookie ? { cookie } : {}) };
}

async function agentsOf(ownerId: string | null) {
  return (await handle.runtime.store.listAgents()).filter(
    (agent) => (agent.ownerId ?? null) === ownerId,
  );
}

describe('стартовые агенты', () => {
  it('создаёт «Почтового агента» и «Джарвиса» первому администратору', async () => {
    await register('owner@example.com');
    const store = handle.runtime.store;
    const owner = await store.getUserByEmail('owner@example.com');
    if (!owner) throw new Error('нет владельца');
    const agents = await agentsOf(null);
    const names = agents.map((agent) => agent.name);
    expect(names).toContain('Почтовый агент');
    expect(names).toContain('Джарвис');

    const mail = agents.find((agent) => agent.name === 'Почтовый агент');
    const jarvis = agents.find((agent) => agent.name === 'Джарвис');
    expect(mail?.plugins).toContain('mail');
    expect(mail?.systemPrompt.length).toBeGreaterThan(100);
    expect(jarvis?.plugins).toContain('schedule');
    expect(jarvis?.systemPrompt).toContain('Джарвис');

    const routines = await store.listRoutines(owner.id, mail?.id);
    expect(routines).toHaveLength(1);
    expect(routines[0]?.name).toBe('Утренняя почта');
    expect(routines[0]?.cron).toBe('0 9 * * *');
    expect(routines[0]?.enabled).toBe(false);
    expect(routines[0]?.prompt).toBe(DIGEST_PROMPT);
  });

  it('создаёт стартовых агентов новому клиенту при регистрации', async () => {
    const { user } = await register('client@example.com');
    const agents = await agentsOf(user.id);
    expect(agents.map((agent) => agent.name).sort()).toEqual([
      'Джарвис',
      'Почтовый агент',
    ]);
    const mail = agents.find((agent) => agent.name === 'Почтовый агент');
    const routines = await handle.runtime.store.listRoutines(user.id, mail?.id);
    expect(routines).toHaveLength(1);
    expect(routines[0]?.enabled).toBe(false);
  });

  it('идемпотентен: повторный вызов не дублирует агентов', async () => {
    const store = handle.runtime.store;
    const user = await store.getUserByEmail('owner@example.com');
    if (!user) throw new Error('нет владельца');
    const before = (await store.listAgents()).length;
    await seedStarterAgents(store, user);
    await seedStarterAgents(store, user);
    expect((await store.listAgents()).length).toBe(before);
  });

  it('досоздаёт агентов уже существующему пользователю', async () => {
    const store = handle.runtime.store;
    const existing = await store.insertUser({
      email: 'legacy@example.com',
      name: 'Старый',
      passwordHash: 'x',
      role: 'manager',
      status: 'active',
      dailyRequestLimit: null,
    });
    expect(await agentsOf(existing.id)).toHaveLength(0);
    const created = await ensureStarterAgents(store);
    expect(created).toBe(2);
    expect(
      (await agentsOf(existing.id)).map((agent) => agent.name).sort(),
    ).toEqual(['Джарвис', 'Почтовый агент']);
  });
});
