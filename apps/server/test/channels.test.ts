import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MailAccountStatus, TelegramBotState } from '@mayak/shared';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';

let handle: AppHandle;
let dataDir: string;
let cookie = '';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-channels-'));
  handle = await createApp(
    loadConfig({
      dataDir,
      repoRoot,
      authEnabled: true,
      jwtSecret: 'test-secret',
      secureCookie: false,
    }),
  );
  const response = await handle.app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'channels@example.com',
      password: 'password1',
      name: 'Каналы',
    }),
  });
  expect(response.status).toBe(201);
  cookie =
    response.headers
      .getSetCookie()
      .map((item) => item.split(';')[0] ?? '')
      .find((item) => item.startsWith('mayak_session=')) ?? '';
  expect(cookie).not.toBe('');
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function get(
  pathname: string,
  session = cookie,
): Promise<Response> {
  return handle.app.request(pathname, { headers: { cookie: session } });
}

async function send(
  method: string,
  pathname: string,
  body: unknown,
  session = cookie,
): Promise<Response> {
  return handle.app.request(pathname, {
    method,
    headers: { 'content-type': 'application/json', cookie: session },
    body: JSON.stringify(body),
  });
}

describe('маршруты почты', () => {
  it('без сессии — 401', async () => {
    expect((await get('/api/mail', '')).status).toBe(401);
  });

  it('отдаёт статус и созданную рутину выжимки', async () => {
    const response = await get('/api/mail');
    expect(response.status).toBe(200);
    const status = (await response.json()) as MailAccountStatus;
    expect(status.connected).toBe(false);
    expect(status.hasPassword).toBe(false);
    expect(status.digest?.cron).toBe('0 9 * * *');
    expect(status.digest?.enabled).toBe(false);
  });

  it('проверяет ввод при подключении ящика', async () => {
    const badHost = await send('PUT', '/api/mail', {
      host: 'imap example ru',
      port: 993,
      secure: true,
      user: 'a@example.ru',
      password: 'secret',
    });
    expect(badHost.status).toBe(400);
    const badPort = await send('PUT', '/api/mail', {
      host: 'imap.example.ru',
      port: 0,
      secure: true,
      user: 'a@example.ru',
      password: 'secret',
    });
    expect(badPort.status).toBe(400);
    const noPassword = await send('POST', '/api/mail/test', {
      host: 'imap.example.ru',
      port: 993,
      secure: true,
      user: 'a@example.ru',
    });
    expect(noPassword.status).toBe(200);
    expect((await noPassword.json()) as { ok: boolean }).toMatchObject({
      ok: false,
    });
  });

  it('меняет время выжимки и отклоняет некорректный cron', async () => {
    const updated = await send('PUT', '/api/mail/digest', {
      cron: '30 8 * * *',
      enabled: true,
    });
    expect(updated.status).toBe(200);
    const status = (await updated.json()) as MailAccountStatus;
    expect(status.digest?.cron).toBe('30 8 * * *');
    expect(status.digest?.enabled).toBe(true);

    const bad = await send('PUT', '/api/mail/digest', { cron: 'каждый день' });
    expect(bad.status).toBe(400);
  });

  it('не запускает выжимку без подключённого ящика', async () => {
    const response = await send('POST', '/api/mail/digest', {});
    expect(response.status).toBe(400);
  });
});

describe('маршруты Telegram', () => {
  it('без сессии — 401', async () => {
    expect((await get('/api/telegram', '')).status).toBe(401);
  });

  it('отдаёт статус и агента «Джарвис»', async () => {
    const response = await get('/api/telegram');
    expect(response.status).toBe(200);
    const status = (await response.json()) as TelegramBotState;
    expect(status.connected).toBe(false);
    expect(status.agentName).toBe('Джарвис');
  });

  it('проверяет ID и токен до обращения к Telegram', async () => {
    const empty = await send('PUT', '/api/telegram', {});
    expect(empty.status).toBe(400);
    const badId = await send('PUT', '/api/telegram', {
      token: '123456789:AAFakeTokenForValidationOnly',
      tgUserId: 'не число',
    });
    expect(badId.status).toBe(400);
    const shortToken = await send('PUT', '/api/telegram', {
      token: 'short',
      tgUserId: '123456789',
    });
    expect(shortToken.status).toBe(400);
  });

  it('тест и отключение без подключения', async () => {
    const test = await send('POST', '/api/telegram/test', {});
    expect(test.status).toBe(400);
    const removed = await send('DELETE', '/api/telegram', {});
    expect(removed.status).toBe(200);
  });
});
