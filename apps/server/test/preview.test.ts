import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';

let handle: AppHandle;
let dataDir: string;
let agentId = '';
let userId = '';

const safe = (value: string) =>
  value.replace(/[^\w-]+/g, '_').slice(0, 80);

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-preview-'));
  handle = await createApp(loadConfig({ dataDir, repoRoot }));
  const users = await handle.runtime.store.listUsers();
  const user = users[0];
  if (!user) throw new Error('в тестовой базе нет пользователя');
  userId = user.id;
  const agents = await handle.runtime.store.listAgentsFor(user);
  const agent = agents[0];
  if (!agent) throw new Error('в тестовой базе нет агента');
  agentId = agent.id;
  const root = path.join(dataDir, 'workspaces', safe(userId), safe(agentId));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<h1>Превью работает</h1>',
  );
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'docs', 'readme.txt'), 'файл');
  // Секрет вне рабочей папки не должен отдаваться.
  fs.writeFileSync(path.join(dataDir, 'secret.txt'), 'SECRET');
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('превью рабочей папки', () => {
  it('отдаёт index.html с sandbox-CSP и без allow-same-origin', async () => {
    const response = await handle.app.request(
      `/api/preview/${agentId}/`,
      { headers: { accept: 'text/html' } },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Превью работает');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox');
    expect(csp).not.toContain('allow-same-origin');
  });

  it('отдаёт ассеты с правильным MIME', async () => {
    const response = await handle.app.request(
      `/api/preview/${agentId}/assets/app.js`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(
      'text/javascript',
    );
    expect(await response.text()).toBe('console.log(1)');
  });

  it('показывает список файлов для папки без index.html', async () => {
    const response = await handle.app.request(
      `/api/preview/${agentId}/docs/`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('readme.txt');
  });

  it('не выпускает за пределы рабочей папки и не отдаёт секреты', async () => {
    for (const attempt of [
      `/api/preview/${agentId}/../secret.txt`,
      `/api/preview/${agentId}/%2e%2e/%2e%2e/secret.txt`,
    ]) {
      const response = await handle.app.request(attempt);
      const text = await response.text();
      expect(response.status).not.toBe(200);
      expect(text).not.toContain('SECRET');
    }
  });

  it('не отдаёт чужой агент', async () => {
    const response = await handle.app.request(
      '/api/preview/00000000-0000-0000-0000-000000000000/',
    );
    expect(response.status).toBe(404);
  });
});
