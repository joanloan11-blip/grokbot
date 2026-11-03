import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderPublic, UsageRow } from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';

let handle: AppHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-models-'));
  handle = await createApp(
    loadConfig({
      dataDir,
      repoRoot,
      authEnabled: true,
      jwtSecret: 'model-secret',
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

async function send(
  pathname: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie) headers.set('cookie', cookie);
  return handle.app.request(pathname, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function get(pathname: string, cookie?: string): Promise<Response> {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return handle.app.request(pathname, { headers });
}

describe('model allowlist', () => {
  it('rejects a model the admin has not shared and records the one that was allowed', async () => {
    const adminResponse = await send('/api/auth/register', {
      email: 'lead@example.com',
      password: 'password1',
      name: 'Админ',
    });
    const adminCookie = cookieHeader(adminResponse);
    const managerResponse = await send('/api/auth/register', {
      email: 'sales@example.com',
      password: 'password2',
      name: 'Продажи',
    });
    const managerBody = (await managerResponse.json()) as {
      user: { id: string };
    };
    const agents = (await (await get('/api/agents', adminCookie)).json()) as {
      id: string;
    }[];
    const agentId = agents[0]?.id;
    if (!agentId) throw new Error('нет агента');
    const approved = await handle.app.request(
      `/api/admin/users/${managerBody.user.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ status: 'active', agentIds: [agentId] }),
      },
    );
    expect(approved.status).toBe(200);
    const managerCookie = cookieHeader(
      await send('/api/auth/login', {
        email: 'sales@example.com',
        password: 'password2',
      }),
    );

    const keyed = await send(
      '/api/providers',
      {
        name: 'OpenAI',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-not-returned',
        models: ['gpt-test'],
      },
      adminCookie,
    );
    expect(keyed.status).toBe(201);
    const keyedBody = (await keyed.json()) as ProviderPublic & {
      apiKey?: string;
    };
    expect(keyedBody.hasApiKey).toBe(true);
    expect(keyedBody.apiKey).toBeUndefined();
    expect(JSON.stringify(keyedBody)).not.toContain('sk-test-not-returned');

    const created = await send(
      '/api/providers',
      { name: 'Рабочие', kind: 'mock', models: ['alpha', 'beta'] },
      adminCookie,
    );
    expect(created.status).toBe(201);
    const provider = (await created.json()) as ProviderPublic;

    const hidden = await send(
      '/api/conversations',
      { agentId, providerId: provider.id, model: 'alpha', locale: 'ru' },
      managerCookie,
    );
    expect(hidden.status).toBe(403);

    const shared = await handle.app.request('/api/admin/models/shared', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        models: [
          { providerId: provider.id, model: 'alpha' },
          { providerId: provider.id, model: 'beta' },
        ],
      }),
    });
    expect(shared.status).toBe(200);

    const managerProviders = (await (
      await get('/api/providers', managerCookie)
    ).json()) as ProviderPublic[];
    const visible = managerProviders.find((item) => item.id === provider.id);
    expect(visible?.models).toEqual(['alpha', 'beta']);

    const chat = (await (
      await send(
        '/api/conversations',
        { agentId, providerId: provider.id, model: 'alpha', locale: 'ru' },
        managerCookie,
      )
    ).json()) as { id: string };

    const denied = await send(
      `/api/conversations/${chat.id}/messages`,
      {
        content: 'привет',
        model: 'secret',
        providerId: provider.id,
        locale: 'ru',
      },
      managerCookie,
    );
    expect(denied.status).toBe(400);

    const blocked = await handle.app.request(
      `/api/admin/users/${managerBody.user.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({
          modelsRestricted: true,
          models: [{ providerId: provider.id, model: 'beta' }],
        }),
      },
    );
    expect(blocked.status).toBe(200);

    const narrowed = (await (
      await get('/api/providers', managerCookie)
    ).json()) as ProviderPublic[];
    expect(narrowed.find((item) => item.id === provider.id)?.models).toEqual([
      'beta',
    ]);

    const forbidden = await send(
      `/api/conversations/${chat.id}/messages`,
      {
        content: 'привет',
        model: 'alpha',
        providerId: provider.id,
        locale: 'ru',
      },
      managerCookie,
    );
    expect(forbidden.status).toBe(403);

    const allowed = await send(
      `/api/conversations/${chat.id}/messages`,
      {
        content: 'привет',
        model: 'beta',
        providerId: provider.id,
        locale: 'ru',
      },
      managerCookie,
    );
    expect(allowed.status).toBe(200);
    await allowed.text();

    const usage = (await (
      await get('/api/admin/usage', adminCookie)
    ).json()) as UsageRow[];
    const row = usage.find((item) => item.email === 'sales@example.com');
    expect(row?.models).toEqual([{ model: 'beta', calls: 1 }]);
  });
});
