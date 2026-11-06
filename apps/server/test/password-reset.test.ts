import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PublicUser } from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';

let handle: AppHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-reset-'));
  handle = await createApp(
    loadConfig({
      dataDir,
      repoRoot,
      authEnabled: true,
      jwtSecret: 'test-secret',
      secureCookie: false,
      publicUrl: 'https://mayak.test',
    }),
  );
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

function cookieOf(response: Response): string {
  const pair = response.headers
    .getSetCookie()
    .map((item) => item.split(';')[0] ?? '')
    .find((item) => item.startsWith('mayak_session='));
  if (!pair) throw new Error('нет сессии');
  return pair;
}

function send(pathname: string, body: unknown, cookie?: string) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie) headers.set('cookie', cookie);
  return handle.app.request(pathname, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('password reset', () => {
  let adminCookie = '';
  let managerId = '';

  it('sets up an admin and a manager', async () => {
    const admin = await send('/api/auth/register', {
      email: 'boss@example.com',
      password: 'old-password-1',
      name: 'Boss',
    });
    expect(admin.status).toBe(201);
    adminCookie = cookieOf(admin);
    const manager = await send('/api/auth/register', {
      email: 'worker@example.com',
      password: 'worker-pass-1',
    });
    managerId = ((await manager.json()) as { user: PublicUser }).user.id;
  });

  it('answers forgot the same way for known and unknown emails', async () => {
    const known = await (
      await send('/api/auth/forgot', { email: 'boss@example.com' })
    ).json();
    const unknown = await (
      await send('/api/auth/forgot', { email: 'nobody@example.com' })
    ).json();
    expect(known).toEqual(unknown);
    expect(known).toEqual({ ok: true, mail: false });
  });

  it('lets an admin issue a link that resets the password once', async () => {
    const issued = await send(
      `/api/admin/users/${managerId}/reset-link`,
      {},
      adminCookie,
    );
    expect(issued.status).toBe(200);
    const { link } = (await issued.json()) as { link: string };
    expect(link.startsWith('https://mayak.test/?reset=')).toBe(true);
    const token = new URL(link).searchParams.get('reset') ?? '';

    expect(
      (await send('/api/auth/reset', { token, password: 'short' })).status,
    ).toBe(400);
    const ok = await send('/api/auth/reset', {
      token,
      password: 'new-worker-pass',
    });
    expect(ok.status).toBe(200);
    // Ссылка одноразовая.
    expect(
      (await send('/api/auth/reset', { token, password: 'another-pass-1' }))
        .status,
    ).toBe(400);
  });

  it('managers cannot issue links', async () => {
    const login = await send('/api/auth/login', {
      email: 'boss@example.com',
      password: 'old-password-1',
    });
    expect(login.status).toBe(200);
    const unknown = await send(
      '/api/admin/users/nope/reset-link',
      {},
      adminCookie,
    );
    expect(unknown.status).toBe(404);
    const anonymous = await send(
      `/api/admin/users/${managerId}/reset-link`,
      {},
    );
    expect(anonymous.status).toBe(401);
  });

  it('signs out old sessions after the password changes', async () => {
    const before = await handle.app.request('/api/auth/me', {
      headers: { cookie: adminCookie },
    });
    expect(before.status).toBe(200);
    const admin = ((await await before.json()) as { user: PublicUser }).user;
    const { link } = (await (
      await send(`/api/admin/users/${admin.id}/reset-link`, {}, adminCookie)
    ).json()) as { link: string };
    // Сессия старше смены пароля хотя бы на секунду.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const reset = await send('/api/auth/reset', {
      token: new URL(link).searchParams.get('reset'),
      password: 'brand-new-pass',
    });
    expect(reset.status).toBe(200);
    const fresh = cookieOf(reset);
    expect(
      (
        await handle.app.request('/api/auth/me', {
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (await handle.app.request('/api/auth/me', { headers: { cookie: fresh } }))
        .status,
    ).toBe(200);
    expect(
      (
        await send('/api/auth/login', {
          email: 'boss@example.com',
          password: 'old-password-1',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await send('/api/auth/login', {
          email: 'boss@example.com',
          password: 'brand-new-pass',
        })
      ).status,
    ).toBe(200);
  });

  it('rejects garbage tokens', async () => {
    expect(
      (
        await send('/api/auth/reset', {
          token: 'garbage',
          password: 'whatever-123',
        })
      ).status,
    ).toBe(400);
  });
});
