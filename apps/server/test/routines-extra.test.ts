import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';

let handle: AppHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-routines-'));
  handle = await createApp(loadConfig({ dataDir, repoRoot }));
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('routine webhooks and history', () => {
  it('creates a webhook-only routine, runs it, and keeps history', async () => {
    const agents = (await (await handle.app.request('/api/agents')).json()) as {
      id: string;
    }[];
    const agentId = agents[0]?.id;
    if (!agentId) throw new Error('нет агента');
    const created = await handle.app.request(`/api/agents/${agentId}/routines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Вебхук',
        cron: '',
        prompt: 'Скажи: готово',
      }),
    });
    expect(created.status).toBe(201);
    const routine = (await created.json()) as {
      id: string;
      webhookToken: string;
    };
    expect(routine.webhookToken).toBeTruthy();
    const hook = await handle.app.request(`/api/hooks/${routine.webhookToken}`, {
      method: 'POST',
      body: 'payload-1',
    });
    expect(hook.status).toBe(200);
    const runs = (await (
      await handle.app.request(`/api/agents/${agentId}/routines/${routine.id}/runs`)
    ).json()) as { status: string; output: string }[];
    expect(runs[0]?.status).toBe('ok');
    expect(runs[0]?.output.length).toBeGreaterThan(0);
  });
});
