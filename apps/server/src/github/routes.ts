import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  GithubPreview,
  GithubRepoInfo,
  GithubStatus,
  McpServerPublic,
} from '@mayak/shared';
import type { Context, Hono } from 'hono';
import type { AppConfig } from '../config';
import type { McpRow, Store, UserRecord } from '../db';
import { HttpError, badRequest } from '../errors';
import type { McpManager } from '../mcp/manager';
import { parseSkillMarkdown, type SkillLibrary } from '../skills';
import { newId } from '../util';
import { githubRepos, githubUser, type FetchLike } from './api';
import { extractTarball, readCapped } from './archive';
import { detectProject } from './detect';
import { parseRepo } from './parse';
import { clearGithubToken, readGithubToken, saveGithubToken } from './tools';

const states = new Map<string, number>();
const OFFICIAL_HTTP = 'https://api.githubcopilot.com/mcp/';
const OFFICIAL_IMAGE = 'ghcr.io/github/github-mcp-server';

export interface GithubRouteDeps {
  store: Store;
  mcp: McpManager;
  skills: SkillLibrary;
  config: AppConfig;
  actor: (c: Context) => Promise<UserRecord>;
  readBody: (c: Context) => Promise<unknown>;
  present: (row: McpRow) => McpServerPublic;
  fetchImpl?: FetchLike;
}

export function registerGithubRoutes(app: Hono, deps: GithubRouteDeps): void {
  const admin = async (c: Context) => {
    const user = await deps.actor(c);
    if (user.role !== 'admin') {
      throw new HttpError(403, 'Только для администратора');
    }
    return user;
  };

  app.get('/api/github/status', async (c) => {
    await admin(c);
    return c.json(await statusOf(deps));
  });

  app.put('/api/github/token', async (c) => {
    await admin(c);
    const body = await deps.readBody(c);
    const token =
      body && typeof body === 'object' && 'token' in body
        ? String((body as { token?: unknown }).token ?? '')
        : '';
    if (token.trim().length < 8) throw badRequest('Вставьте токен GitHub');
    await saveGithubToken(deps.store, token.trim(), deps.config.jwtSecret);
    const payload = await statusOf(deps);
    return c.json(payload);
  });

  app.delete('/api/github/token', async (c) => {
    await admin(c);
    await clearGithubToken(deps.store);
    return c.json({ connected: false, login: null, oauth: oauthReady(deps) });
  });

  app.get('/api/github/oauth/start', async (c) => {
    await admin(c);
    if (!deps.config.githubClientId || !deps.config.githubClientSecret) {
      throw badRequest(
        'OAuth не настроен. Задайте GITHUB_CLIENT_ID и GITHUB_CLIENT_SECRET.',
      );
    }
    const state = randomBytes(16).toString('hex');
    states.set(state, Date.now() + 10 * 60 * 1000);
    const redirectUri = `${originOf(c, deps.config)}/api/github/oauth/callback`;
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', deps.config.githubClientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'repo');
    url.searchParams.set('state', state);
    return c.json({ url: url.toString() });
  });

  app.get('/api/github/oauth/callback', async (c) => {
    await admin(c);
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code') ?? '';
    const expires = states.get(state);
    states.delete(state);
    if (!expires || expires < Date.now() || !code) {
      throw badRequest('Сессия входа GitHub истекла. Начните ещё раз.');
    }
    if (!deps.config.githubClientId || !deps.config.githubClientSecret) {
      throw badRequest('OAuth не настроен');
    }
    const redirectUri = `${originOf(c, deps.config)}/api/github/oauth/callback`;
    const response = await (deps.fetchImpl ?? fetch)(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'mayak',
        },
        body: JSON.stringify({
          client_id: deps.config.githubClientId,
          client_secret: deps.config.githubClientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      },
    );
    const payload = (await response.json()) as { access_token?: string };
    if (!payload.access_token) throw badRequest('GitHub не выдал токен');
    await saveGithubToken(
      deps.store,
      payload.access_token,
      deps.config.jwtSecret,
    );
    return c.redirect(`${originOf(c, deps.config)}/?github=connected`);
  });

  app.get('/api/github/repos', async (c) => {
    await admin(c);
    const token = await requireToken(deps);
    const repos = await githubRepos(token, deps.fetchImpl);
    const visible: GithubRepoInfo[] = repos;
    return c.json(visible);
  });

  app.post('/api/github/import/preview', async (c) => {
    await admin(c);
    const token = await requireToken(deps);
    const body = await deps.readBody(c);
    const raw =
      body && typeof body === 'object' && 'repo' in body
        ? String((body as { repo?: unknown }).repo ?? '')
        : '';
    const repo = parseRepo(raw);
    if (!repo)
      throw badRequest('Нужна ссылка github.com/owner/repo или owner/repo');
    const response = await (deps.fetchImpl ?? fetch)(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/tarball`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'mayak',
        },
        redirect: 'follow',
      },
    );
    if (!response.ok) throw badRequest(`GitHub ${response.status}`);
    const bytes = await readCapped(response);
    const id = newId();
    const dir = path.join(deps.config.dataDir, 'github-previews', id);
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, 'archive.tgz');
    fs.writeFileSync(archive, bytes);
    const source = path.join(dir, 'source');
    await extractTarball(archive, source);
    const detected = detectProject(source, process.execPath);
    const preview: GithubPreview = {
      id,
      repo: repo.fullName,
      kind: detected.kind,
      summary: detected.summary,
      command: detected.command,
      args: detected.args,
      skills: detected.skills,
    };
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ ...preview, source }),
    );
    return c.json(preview);
  });

  app.post('/api/github/import/confirm', async (c) => {
    await admin(c);
    const body = await deps.readBody(c);
    if (!body || typeof body !== 'object') throw badRequest('Ожидался JSON');
    const record = body as Record<string, unknown>;
    if (record.confirm !== true) {
      throw badRequest('Подтвердите импорт полем confirm: true');
    }
    const id = typeof record.id === 'string' ? record.id : '';
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(id))
      throw badRequest('Черновик не найден');
    const dir = path.join(deps.config.dataDir, 'github-previews', id);
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) throw badRequest('Черновик не найден');
    const meta = JSON.parse(
      fs.readFileSync(metaPath, 'utf8'),
    ) as GithubPreview & {
      source: string;
    };
    const finalRoot = path.join(
      deps.config.dataDir,
      'github-sources',
      ...meta.repo.split('/'),
    );
    fs.rmSync(finalRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(finalRoot), { recursive: true });
    fs.renameSync(meta.source, finalRoot);
    const command = rewrite(
      typeof record.command === 'string' ? record.command : meta.command,
      meta.source,
      finalRoot,
    ).trim();
    const args = (Array.isArray(record.args) ? record.args : meta.args)
      .filter((item): item is string => typeof item === 'string')
      .map((item) => rewrite(item, meta.source, finalRoot));
    if (!command) throw badRequest('Укажите команду запуска');
    const name = slug(
      typeof record.name === 'string' && record.name.trim()
        ? record.name
        : meta.repo.split('/')[1] || 'github',
    );
    const saved = await deps.store.upsertMcp({
      name,
      transport: 'stdio',
      command,
      args,
      enabled: record.enabled === true,
    });
    if (saved.enabled) await deps.mcp.connect(saved);
    const wanted = new Set(
      Array.isArray(record.skillNames)
        ? record.skillNames.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    );
    const imported: string[] = [];
    if (wanted.size > 0) {
      importSkills(finalRoot, wanted, deps.skills, imported);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return c.json({ server: deps.present(saved), skills: imported });
  });

  app.post('/api/github/mcp/official', async (c) => {
    await admin(c);
    const token = await requireToken(deps);
    const body = await deps.readBody(c);
    const mode =
      body && typeof body === 'object' && 'mode' in body
        ? String((body as { mode?: unknown }).mode ?? '')
        : '';
    const saved =
      mode === 'docker'
        ? await deps.store.upsertMcp({
            name: 'github',
            transport: 'stdio',
            command: 'docker',
            args: [
              'run',
              '-i',
              '--rm',
              '-e',
              'GITHUB_PERSONAL_ACCESS_TOKEN',
              OFFICIAL_IMAGE,
            ],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
            headers: {},
            enabled: false,
          })
        : await deps.store.upsertMcp({
            name: 'github',
            transport: 'http',
            command: '',
            args: [],
            url: OFFICIAL_HTTP,
            headers: { Authorization: `Bearer ${token}` },
            env: {},
            enabled: false,
          });
    return c.json(deps.present(saved), 201);
  });
}

async function requireToken(deps: GithubRouteDeps): Promise<string> {
  const token = await readGithubToken(deps.store, deps.config.jwtSecret);
  if (!token) throw badRequest('Сначала сохраните токен GitHub');
  return token;
}

function oauthReady(deps: GithubRouteDeps): boolean {
  return Boolean(deps.config.githubClientId && deps.config.githubClientSecret);
}

async function statusOf(deps: GithubRouteDeps): Promise<GithubStatus> {
  const token = await readGithubToken(deps.store, deps.config.jwtSecret);
  if (!token) {
    return { connected: false, login: null, oauth: oauthReady(deps) };
  }
  try {
    const login = await githubUser(token, deps.fetchImpl);
    return { connected: true, login, oauth: oauthReady(deps) };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'GitHub недоступен';
    return {
      connected: true,
      login: null,
      oauth: oauthReady(deps),
      error: message,
    };
  }
}

function originOf(c: Context, config: AppConfig): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, '');
  const proto = c.req.header('x-forwarded-proto') ?? 'http';
  const host =
    c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '127.0.0.1';
  return `${proto}://${host}`;
}

function rewrite(value: string, from: string, to: string): string {
  return value.split(from).join(to);
}

function slug(value: string): string {
  const clean = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return clean || 'github';
}

function importSkills(
  root: string,
  wanted: Set<string>,
  skills: SkillLibrary,
  imported: string[],
  dir = root,
  depth = 0,
): void {
  if (depth > 4) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      importSkills(root, wanted, skills, imported, full, depth + 1);
    }
    if (entry.isFile() && entry.name === 'SKILL.md') {
      const name = path.basename(dir).toLowerCase();
      if (!wanted.has(name)) continue;
      const parsed = parseSkillMarkdown(fs.readFileSync(full, 'utf8'));
      skills.save({ name, ...parsed });
      imported.push(name);
    }
  }
}
