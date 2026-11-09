import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Conversation, ProviderPublic, UsageMeter } from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';
import { dayStart, weekStart } from '../src/meter';

let handle: AppHandle;
let dataDir: string;
beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-meter-'));
  handle = await createApp(loadConfig({ dataDir, repoRoot }));
});
afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});
const send = (method: string, pathname: string, body?: unknown) =>
  handle.app.request(pathname, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('usage meter', () => {
  it('starts the week on Monday and the day at midnight', () => {
    const thursday = new Date(2026, 10, 5, 15, 30);
    expect(weekStart(thursday).getDay()).toBe(1);
    expect(weekStart(thursday).getDate()).toBe(2);
    const sunday = new Date(2026, 10, 8, 23, 0);
    expect(weekStart(sunday).getDate()).toBe(2);
    expect(dayStart(thursday).getHours()).toBe(0);
  });

  it('shows percent of the limit and stops requests over it', async () => {
    const providers = (await (
      await send('GET', '/api/providers')
    ).json()) as ProviderPublic[];
    const mock = providers.find((item) => item.kind === 'mock');
    await send('PUT', '/api/admin/prices', {
      overrides: { mock: { input: 100_000, cached: 0, output: 100_000 } },
    });
    await send('PUT', '/api/admin/budgets/default', { day: 1, week: 5 });
    const chat = (await (
      await send('POST', '/api/conversations', {
        locale: 'ru',
        providerId: mock?.id,
        model: 'mock',
      })
    ).json()) as Conversation;
    await (
      await send('POST', `/api/conversations/${chat.id}/messages`, {
        content: 'привет',
        locale: 'ru',
      })
    ).text();
    const meter = (await (
      await send('GET', '/api/usage/meter')
    ).json()) as UsageMeter;
    expect(meter.day.limitUsd).toBe(1);
    expect(meter.week.limitUsd).toBe(5);
    expect(meter.day.percent).toBeGreaterThanOrEqual(100);
    expect(meter.week.tokens).toBeGreaterThan(0);
    const blocked = await (
      await send('POST', `/api/conversations/${chat.id}/messages`, {
        content: 'ещё',
        locale: 'ru',
      })
    ).text();
    expect(blocked).toMatch(/лимит расходов исчерпан/);
    await send('PUT', '/api/admin/budgets/default', { day: null, week: null });
    const free = (await (
      await send('GET', '/api/usage/meter')
    ).json()) as UsageMeter;
    expect(free.day.percent).toBeNull();
  });
});
