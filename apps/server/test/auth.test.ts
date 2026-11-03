import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Conversation, PublicUser, UsageRow } from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';
import { toPostgres } from '../src/sql';

let handle: AppHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-auth-'));
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

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
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

async function patch(
  pathname: string,
  body: unknown,
  cookie: string,
): Promise<Response> {
  return handle.app.request(pathname, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

describe('auth and isolation', () => {
  it('converts sqlite placeholders for postgres', () => {
    expect(toPostgres('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });

  it('makes the first user an admin and keeps later signups pending', async () => {
    const open = await get('/api/agents');
    expect(open.status).toBe(401);

    const adminResponse = await send('/api/auth/register', {
      email: 'owner@example.com',
      password: 'password1',
      name: 'Владелец',
    });
    expect(adminResponse.status).toBe(201);
    const adminBody = await json<{ user: PublicUser }>(adminResponse);
    expect(adminBody.user.role).toBe('admin');
    expect(adminBody.user.status).toBe('active');
    const adminCookie = cookieHeader(adminResponse);

    const pending = await send('/api/auth/register', {
      email: 'manager@example.com',
      password: 'password2',
      name: 'Менеджер',
    });
    expect(pending.status).toBe(201);
    const pendingBody = await json<{ user: PublicUser; pending: boolean }>(
      pending,
    );
    expect(pendingBody.user.role).toBe('manager');
    expect(pendingBody.user.status).toBe('pending');
    expect(pendingBody.pending).toBe(true);
    expect(
      pending.headers
        .getSetCookie()
        .some((item) => item.startsWith('mayak_session=')),
    ).toBe(false);

    const denied = await send('/api/auth/login', {
      email: 'manager@example.com',
      password: 'password2',
    });
    expect(denied.status).toBe(403);

    const agents = await json<{ id: string }[]>(
      await get('/api/agents', adminCookie),
    );
    expect(agents.length).toBeGreaterThan(0);
    const agentId = agents[0]?.id;
    if (!agentId) throw new Error('нет агента');

    const approved = await patch(
      `/api/admin/users/${pendingBody.user.id}`,
      { status: 'active', agentIds: [agentId], dailyRequestLimit: 1 },
      adminCookie,
    );
    expect(approved.status).toBe(200);

    const managerLogin = await send('/api/auth/login', {
      email: 'manager@example.com',
      password: 'password2',
    });
    expect(managerLogin.status).toBe(200);
    const managerCookie = cookieHeader(managerLogin);

    const forbidden = await send(
      '/api/providers',
      { name: 'чужой', kind: 'mock', models: ['mock'] },
      managerCookie,
    );
    expect(forbidden.status).toBe(403);

    const adminChat = await json<Conversation>(
      await send('/api/conversations', { agentId, locale: 'ru' }, adminCookie),
    );
    const managerChat = await json<Conversation>(
      await send(
        '/api/conversations',
        { agentId, locale: 'ru' },
        managerCookie,
      ),
    );
    expect(adminChat.userId).not.toBe(managerChat.userId);

    const hidden = await get(
      `/api/conversations/${adminChat.id}`,
      managerCookie,
    );
    expect(hidden.status).toBe(404);
    const managerList = await json<Conversation[]>(
      await get(`/api/conversations?agentId=${agentId}`, managerCookie),
    );
    expect(managerList.map((item) => item.id)).not.toContain(adminChat.id);

    const note = await handle.app.request(
      `/api/agents/${agentId}/memory/${encodeURIComponent('branch')}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: managerCookie },
        body: JSON.stringify({ content: 'север' }),
      },
    );
    expect(note.status).toBe(200);
    const adminNotes = await json<{ key: string }[]>(
      await get(`/api/agents/${agentId}/memory`, adminCookie),
    );
    expect(adminNotes).toEqual([]);
    const managerNotes = await json<{ content: string }[]>(
      await get(`/api/agents/${agentId}/memory`, managerCookie),
    );
    expect(managerNotes.map((item) => item.content)).toContain('север');

    const first = await send(
      `/api/conversations/${managerChat.id}/messages`,
      { content: 'привет', locale: 'ru' },
      managerCookie,
    );
    expect(first.status).toBe(200);
    await first.text();
    const usage = await json<UsageRow[]>(
      await get('/api/admin/usage', adminCookie),
    );
    const row = usage.find((item) => item.email === 'manager@example.com');
    expect(row?.calls).toBeGreaterThanOrEqual(1);
    expect(row?.limit).toBe(1);

    const limited = await send(
      `/api/conversations/${managerChat.id}/messages`,
      { content: 'ещё', locale: 'ru' },
      managerCookie,
    );
    expect(limited.status).toBe(429);

    const disabled = await patch(
      `/api/admin/users/${pendingBody.user.id}`,
      { status: 'disabled' },
      adminCookie,
    );
    expect(disabled.status).toBe(200);
    const blocked = await get('/api/auth/me', managerCookie);
    expect(blocked.status).toBe(403);

    const invited = await send(
      '/api/admin/users/invite',
      { email: 'invite@example.com', name: 'Филиал', agentIds: [agentId] },
      adminCookie,
    );
    expect(invited.status).toBe(201);
    const inviteBody = await json<{ inviteToken: string }>(invited);
    const accepted = await send('/api/auth/accept', {
      token: inviteBody.inviteToken,
      password: 'password3',
      name: 'Филиал',
    });
    expect(accepted.status).toBe(200);
    const acceptedUser = await json<{ user: PublicUser }>(accepted);
    expect(acceptedUser.user.status).toBe('active');
    expect(acceptedUser.user.role).toBe('manager');
    expect(acceptedUser.user.agentIds).toEqual([agentId]);
  });
});
