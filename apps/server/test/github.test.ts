import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';
import { readCapped } from '../src/github/archive';
import { detectProject } from '../src/github/detect';
import { parseRepo, unsafeTarPath } from '../src/github/parse';
import { encryptSecret, decryptSecret } from '../src/github/secret';
import { runGithubTool } from '../src/github/tools';

const TOKEN = 'ghp_test_token_should_not_leak';

describe('github helpers', () => {
  it('encrypts the token so the stored value is not the token', () => {
    const stored = encryptSecret(TOKEN, 'jwt-secret');
    expect(stored).not.toContain(TOKEN);
    expect(decryptSecret(stored, 'jwt-secret')).toBe(TOKEN);
    expect(() => decryptSecret(stored, 'other-secret')).toThrow();
  });

  it('parses repository URLs and rejects path traversal', () => {
    expect(parseRepo('https://github.com/acme/tool.git')?.fullName).toBe(
      'acme/tool',
    );
    expect(parseRepo('acme/tool')?.repo).toBe('tool');
    expect(parseRepo('https://example.com/acme/tool')).toBeUndefined();
    expect(unsafeTarPath('../etc/passwd')).toBe(true);
    expect(unsafeTarPath('/tmp/x')).toBe(true);
    expect(unsafeTarPath('owner-repo/SKILL.md')).toBe(false);
  });

  it('stops reading an archive past the size cap', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(80));
        controller.enqueue(new Uint8Array(40));
        controller.close();
      },
    });
    await expect(readCapped(new Response(stream), 100)).rejects.toThrow(
      /больше/,
    );
  });

  it('detects a node bin, a Dockerfile, a README command, and a skill', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mayak-gh-'));
    await mkdir(path.join(root, 'pkg'));
    await writeFile(
      path.join(root, 'pkg', 'package.json'),
      JSON.stringify({ name: 'demo', bin: 'server.js' }),
    );
    await writeFile(path.join(root, 'pkg', 'server.js'), 'console.log(1)\n');
    await mkdir(path.join(root, 'pkg', 'summary'));
    await writeFile(
      path.join(root, 'pkg', 'summary', 'SKILL.md'),
      '---\ndescription: Кратко\nenabled: true\n---\n\nСжимай текст.\n',
    );
    const node = detectProject(path.join(root, 'pkg'), 'node');
    expect(node.kind).toBe('node');
    expect(node.command).toBe('node');
    expect(node.args[0]).toContain('server.js');
    expect(node.skills.map((item) => item.name)).toEqual(['summary']);

    const dockerRoot = await mkdtemp(path.join(tmpdir(), 'mayak-gh-'));
    await writeFile(path.join(dockerRoot, 'Dockerfile'), 'FROM scratch\n');
    expect(detectProject(dockerRoot).kind).toBe('docker');

    const readmeRoot = await mkdtemp(path.join(tmpdir(), 'mayak-gh-'));
    await writeFile(
      path.join(readmeRoot, 'README.md'),
      '```json\n{"mcpServers":{"demo":{"command":"node","args":["srv.js"]}}}\n```\n',
    );
    const fromReadme = detectProject(readmeRoot);
    expect(fromReadme.kind).toBe('config');
    expect(fromReadme.command).toBe('node');
    expect(fromReadme.args).toEqual(['srv.js']);
    await rm(root, { recursive: true, force: true });
    await rm(dockerRoot, { recursive: true, force: true });
    await rm(readmeRoot, { recursive: true, force: true });
  });

  it('does not call GitHub for a repository the agent cannot access', async () => {
    const calls: string[] = [];
    const text = await runGithubTool(
      'github_read_file',
      { repo: 'evil/other', path: 'README.md' },
      {
        token: TOKEN,
        allow: ['acme/app'],
        fetchImpl: async (input) => {
          calls.push(String(input));
          return new Response('no', { status: 500 });
        },
      },
    );
    expect(text).toContain('не подключён');
    expect(text).not.toContain(TOKEN);
    expect(calls).toEqual([]);
  });
});

describe('github API', () => {
  let handle: AppHandle;
  let dataDir: string;
  let adminCookie = '';

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-gh-api-'));
    handle = await createApp(
      loadConfig({
        dataDir,
        repoRoot,
        authEnabled: true,
        jwtSecret: 'github-test-secret',
      }),
    );
    vi.stubGlobal('fetch', async (input: string | URL | { url: string }) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify({ login: 'octocat' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    const response = await handle.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'git-admin@example.com',
        password: 'password1',
        name: 'Админ',
      }),
    });
    adminCookie =
      response.headers
        .getSetCookie()
        .map((item) => item.split(';')[0] ?? '')
        .find((item) => item.startsWith('mayak_session=')) ?? '';
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await handle.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('stores a token for the admin, hides it, and blocks managers', async () => {
    const saved = await handle.app.request('/api/github/token', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(saved.status).toBe(200);
    const body = await saved.text();
    expect(body).not.toContain(TOKEN);
    expect(body).toContain('octocat');

    const manager = await handle.app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'git-manager@example.com',
        password: 'password2',
        name: 'Менеджер',
      }),
    });
    const managerBody = (await manager.json()) as { user: { id: string } };
    await handle.app.request(`/api/admin/users/${managerBody.user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'active' }),
    });
    const login = await handle.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'git-manager@example.com',
        password: 'password2',
      }),
    });
    const managerCookie =
      login.headers
        .getSetCookie()
        .map((item) => item.split(';')[0] ?? '')
        .find((item) => item.startsWith('mayak_session=')) ?? '';
    const denied = await handle.app.request('/api/github/import/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: managerCookie },
      body: JSON.stringify({ repo: 'acme/tool' }),
    });
    expect(denied.status).toBe(403);

    const oauth = await handle.app.request('/api/github/oauth/start', {
      headers: { cookie: adminCookie },
    });
    expect(oauth.status).toBe(400);
  });

  it('adds an inspected server only after confirm and does not start it', async () => {
    const id = 'previewtest01';
    const dir = path.join(dataDir, 'github-previews', id);
    const source = path.join(dir, 'source');
    await mkdir(path.join(source, 'brief'), { recursive: true });
    await writeFile(path.join(source, 'server.js'), 'console.log(1)\n');
    await writeFile(
      path.join(source, 'brief', 'SKILL.md'),
      '---\ndescription: Коротко\nenabled: true\n---\n\nПиши короче.\n',
    );
    await writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        id,
        repo: 'acme/tool',
        kind: 'node',
        summary: 'test',
        command: process.execPath,
        args: [path.join(source, 'server.js')],
        skills: [{ name: 'brief', description: 'Коротко' }],
        source,
      }),
    );
    const response = await handle.app.request('/api/github/import/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        id,
        confirm: true,
        enabled: false,
        skillNames: ['brief'],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      server: {
        enabled: boolean;
        command: string;
        args: string[];
        hasEnv: boolean;
      };
      skills: string[];
    };
    expect(payload.server.enabled).toBe(false);
    expect(payload.server.args[0]).toContain(
      path.join('github-sources', 'acme', 'tool', 'server.js'),
    );
    expect(payload.skills).toEqual(['brief']);
    expect(JSON.stringify(payload)).not.toContain(TOKEN);

    const official = await handle.app.request('/api/github/mcp/official', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ mode: 'http' }),
    });
    expect(official.status).toBe(201);
    const officialBody = await official.text();
    expect(officialBody).not.toContain(TOKEN);
    expect(officialBody).toContain('githubcopilot.com');
  });
});
