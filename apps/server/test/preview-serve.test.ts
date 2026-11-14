import http from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';

let handle: AppHandle;
let dataDir: string;
let fakeRunner: http.Server;
let fakeDev: http.Server;
let devPort = 0;
let agentId = '';
const saved = { url: process.env.RUNNER_URL, token: process.env.RUNNER_TOKEN };
const serves = new Map<string, Record<string, unknown>>();

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

beforeAll(async () => {
  fakeDev = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>живое превью</h1>');
  });
  devPort = await listen(fakeDev);

  fakeRunner = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/serve') {
        res.end(JSON.stringify({ serves: [...serves.values()] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/serve') {
        const body = JSON.parse(raw) as Record<string, unknown>;
        const entry = {
          id: String(body.id),
          user: String(body.user),
          scope: String(body.scope),
          command: String(body.command),
          port: Number(body.port),
          status: 'running',
          startedAt: new Date().toISOString(),
          logs: '',
        };
        serves.set(entry.id, entry);
        res.statusCode = 201;
        res.end(JSON.stringify(entry));
        return;
      }
      const stop = req.url?.match(/^\/serve\/([a-z0-9]+)\/stop$/);
      if (req.method === 'POST' && stop) {
        const entry = serves.get(stop[1] as string);
        if (entry) entry.status = 'stopped';
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const info = req.url?.match(/^\/serve\/([a-z0-9]+)$/);
      if (req.method === 'GET' && info) {
        res.end(JSON.stringify({ serve: serves.get(info[1] as string) }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  const runnerPort = await listen(fakeRunner);
  process.env.RUNNER_URL = `http://127.0.0.1:${runnerPort}`;
  process.env.RUNNER_TOKEN = 'test';

  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-preview-serve-'));
  handle = await createApp(loadConfig({ dataDir, repoRoot }));
  await handle.runtime.store.setSetting('code_sandbox', '1');
  const users = await handle.runtime.store.listUsers();
  const user = users[0];
  if (!user) throw new Error('нет пользователя');
  const agents = await handle.runtime.store.listAgentsFor(user);
  agentId = agents[0]?.id ?? '';
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
  await new Promise<void>((resolve) => fakeRunner.close(() => resolve()));
  await new Promise<void>((resolve) => fakeDev.close(() => resolve()));
  if (saved.url === undefined) delete process.env.RUNNER_URL;
  else process.env.RUNNER_URL = saved.url;
  if (saved.token === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = saved.token;
});

describe('живой dev-сервер превью', () => {
  it('запускает сервер, проксирует HTTP и останавливает', async () => {
    const created = await handle.app.request('/api/preview/serve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: agentId,
        command: 'npm run dev -- --port 5173',
        port: devPort,
      }),
    });
    expect(created.status).toBe(201);
    const serve = (await created.json()) as { id: string; status: string };
    expect(serve.status).toBe('running');

    const list = (await (
      await handle.app.request(`/api/preview/serve?scope=${agentId}`)
    ).json()) as { serves: { id: string; status: string }[] };
    expect(list.serves.some((item) => item.id === serve.id)).toBe(true);

    const proxy = await handle.app.request(
      `/api/preview/live/${serve.id}/index.html`,
    );
    expect(proxy.status).toBe(200);
    expect(await proxy.text()).toContain('живое превью');

    const stopped = await handle.app.request(
      `/api/preview/serve/${serve.id}/stop`,
      { method: 'POST' },
    );
    expect(stopped.status).toBe(200);
    const after = (await (
      await handle.app.request(`/api/preview/serve?scope=${agentId}`)
    ).json()) as { serves: { id: string; status: string }[] };
    expect(after.serves.find((item) => item.id === serve.id)?.status).toBe(
      'stopped',
    );
  });

  it('не даёт запустить сервер без команды или с неверным портом', async () => {
    const noCommand = await handle.app.request('/api/preview/serve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: agentId, command: '', port: 5173 }),
    });
    expect(noCommand.status).toBe(400);
    const badPort = await handle.app.request('/api/preview/serve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: agentId, command: 'npm run dev', port: 80 }),
    });
    expect(badPort.status).toBe(400);
  });
});
