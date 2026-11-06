import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInside } from '../workspace';
import type { FetchLike } from './api';
import { extractTarball, readCapped } from './archive';
import { parseRepo } from './parse';
import { redact } from './secret';

/**
 * Репозиторий GitHub в рабочей папке агента: скачать (clone), найти изменения,
 * отправить их в новую ветку и открыть pull request — через API, без git.
 */

const MAX_CLONE_BYTES = 40 * 1024 * 1024;
const MAX_PUSH_FILES = 200;
const MAX_PUSH_BYTES = 8 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.qastom']);
const MANIFEST = '.qastom/repos.json';

interface RepoState {
  repo: string;
  ref: string;
  sha: string;
  defaultBranch: string;
  branch?: string;
  files: Record<string, string>;
}

export interface RepoContext {
  root: string;
  token?: string;
  /** Токен только для чтения метаданных публичных репозиториев (лимит GitHub без токена — 60 запросов в час). */
  readToken?: string;
  /** Репозитории, к которым агенту можно применять токен (приватные, push). */
  allow: string[];
  fetchImpl?: FetchLike;
}

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'qastom-agent',
  'X-GitHub-Api-Version': '2022-11-28',
};

function allowed(allow: string[], fullName: string): boolean {
  return allow.some((item) => item.toLowerCase() === fullName.toLowerCase());
}

async function api<T>(
  context: RepoContext,
  method: string,
  urlPath: string,
  body?: unknown,
  useToken: boolean | 'read' = true,
): Promise<{ status: number; data: T }> {
  const token =
    useToken === 'read'
      ? (context.token ?? context.readToken)
      : useToken
        ? context.token
        : undefined;
  const fetchImpl = context.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com${urlPath}`, {
      method,
      headers: {
        ...HEADERS,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'сеть недоступна';
    throw new Error(redact(`GitHub: ${message}`, token ?? ''));
  }
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok && response.status !== 422) {
    const detail = (data as { message?: string }).message;
    let hint = '';
    if (response.status === 404)
      hint = token
        ? ' (нет доступа или репозиторий не найден)'
        : ' (репозиторий не найден или приватный)';
    if (response.status === 403 && !token)
      hint = ' (лимит GitHub для запросов без токена — 60 в час)';
    throw new Error(
      redact(
        `GitHub ${response.status}${detail ? `: ${detail}` : ''}${hint}`,
        token ?? '',
      ),
    );
  }
  return { status: response.status, data: data as T };
}

/** sha, как его считает git для содержимого файла. */
export function blobSha(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}

export function hasClonedRepos(root: string): boolean {
  return fs.existsSync(path.join(root, MANIFEST));
}

function readStates(root: string): Record<string, RepoState> {
  const file = path.join(root, MANIFEST);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
      string,
      RepoState
    >;
  } catch {
    return {};
  }
}

function writeStates(root: string, states: Record<string, RepoState>): void {
  const file = path.join(root, MANIFEST);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(states), 'utf8');
}

/** Все файлы папки (без .git и node_modules): путь → полный путь. */
function walkFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        const full = path.join(current, entry.name);
        out.set(path.relative(dir, full).replace(/\\/g, '/'), full);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function cleanDir(name: string): string {
  return name
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^\w./-]+/g, '-');
}

export async function cloneRepo(
  context: RepoContext,
  input: { repo: string; ref?: string; dir?: string },
): Promise<string> {
  const parsed = parseRepo(input.repo);
  if (!parsed)
    return 'Укажите репозиторий как owner/name или ссылку https://github.com/owner/name.';
  const useToken = Boolean(
    context.token && allowed(context.allow, parsed.fullName),
  );
  const readMode = useToken ? true : 'read';
  let defaultBranch = '';
  let ref = input.ref?.trim() || '';
  let sha = '';
  try {
    const info = await api<{
      default_branch?: string;
      private?: boolean;
      size?: number;
    }>(context, 'GET', `/repos/${parsed.fullName}`, undefined, readMode);
    if (info.status !== 200) return `Репозиторий ${parsed.fullName} не найден.`;
    // Токеном администратора видны и приватные репозитории — их отдаём, только если они подключены к агенту.
    if (info.data.private && !useToken)
      return `Репозиторий ${parsed.fullName} приватный и не подключён к этому агенту. Подключить его можно в настройках агента (GitHub).`;
    if ((info.data.size ?? 0) > 200_000)
      return `Репозиторий слишком большой (${Math.round((info.data.size ?? 0) / 1024)} МБ). Скачать можно до 40 МБ архива — укажите репозиторий поменьше.`;
    defaultBranch = info.data.default_branch ?? 'main';
    ref = ref || defaultBranch;
    const commit = await api<{ sha?: string }>(
      context,
      'GET',
      `/repos/${parsed.fullName}/commits/${encodeURIComponent(ref)}`,
      undefined,
      readMode,
    );
    sha = commit.data.sha ?? '';
    if (!sha) return `Ветка или коммит «${ref}» не найдены.`;
  } catch (error) {
    // Лимит API без токена исчерпан — публичный архив всё равно можно скачать.
    if (useToken || !/лимит GitHub|rate limit/i.test(String(error)))
      throw error;
    ref = ref || 'HEAD';
  }

  const dirName = cleanDir(input.dir || `repos/${parsed.repo}`);
  if (!dirName || dirName === '.qastom' || dirName.startsWith('.qastom/'))
    return 'Некорректная папка.';
  const target = resolveInside(context.root, dirName);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0)
    return `Папка «${dirName}» уже занята. Укажите другую (dir) или удалите её.`;

  const fetchImpl = context.fetchImpl ?? fetch;
  const url = useToken
    ? `https://api.github.com/repos/${parsed.fullName}/tarball/${sha}`
    : `https://codeload.github.com/${parsed.fullName}/tar.gz/${sha || encodeURIComponent(ref)}`;
  const response = await fetchImpl(url, {
    headers: {
      ...HEADERS,
      ...(useToken ? { Authorization: `Bearer ${context.token}` } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    return `GitHub не отдал архив (${response.status}).${useToken ? '' : ' Если репозиторий приватный — подключите его к агенту в настройках GitHub.'}`;
  const archive = await readCapped(response, MAX_CLONE_BYTES);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qastom-clone-'));
  try {
    const file = path.join(temp, 'repo.tgz');
    fs.writeFileSync(file, archive);
    const out = path.join(temp, 'out');
    await extractTarball(file, out);
    const tops = fs.readdirSync(out);
    const top = tops.length === 1 ? path.join(out, tops[0]!) : out;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(top, target, { recursive: true });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const files: Record<string, string> = {};
  for (const [rel, full] of walkFiles(target))
    files[rel] = blobSha(fs.readFileSync(full));
  const states = readStates(context.root);
  states[dirName] = {
    repo: parsed.fullName,
    ref,
    sha,
    defaultBranch,
    files,
  };
  writeStates(context.root, states);

  const top = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => !SKIP_DIRS.has(entry.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort()
    .slice(0, 60);
  const canPush = Boolean(
    context.token && allowed(context.allow, parsed.fullName),
  );
  return [
    `Скачан ${parsed.fullName} (${ref}${sha ? `, ${sha.slice(0, 7)}` : ''}) в папку ${dirName}: ${Object.keys(files).length} файлов.`,
    `Верхний уровень: ${top.join(', ')}`,
    'Дальше: workspace_search и workspace_read — изучить код, workspace_edit/workspace_write — править.',
    canPush
      ? 'Изменения можно отправить в новую ветку с pull request: github_push.'
      : 'Отправить изменения в этот репозиторий нельзя (он не подключён к агенту). Готовый результат пользователь скачает по ссылке из workspace_download.',
  ].join('\n');
}

export function repoChanges(
  root: string,
  dir: string,
): {
  state?: RepoState;
  changed: string[];
  added: string[];
  deleted: string[];
} {
  const dirName = cleanDir(dir);
  const state = readStates(root)[dirName];
  if (!state) return { changed: [], added: [], deleted: [] };
  const target = resolveInside(root, dirName);
  const now = walkFiles(target);
  const changed: string[] = [];
  const added: string[] = [];
  for (const [rel, full] of now) {
    const before = state.files[rel];
    if (!before) added.push(rel);
    else if (before !== blobSha(fs.readFileSync(full))) changed.push(rel);
  }
  const deleted = Object.keys(state.files).filter((rel) => !now.has(rel));
  return { state, changed, added, deleted };
}

export function describeChanges(root: string, dir: string): string {
  const { state, changed, added, deleted } = repoChanges(root, dir);
  if (!state)
    return `В папке «${dir}» нет скачанного репозитория (сначала github_clone).`;
  const total = changed.length + added.length + deleted.length;
  if (!total) return `${state.repo}: изменений нет.`;
  const list = (title: string, items: string[]) =>
    items.length
      ? `${title}: ${items.slice(0, 50).join(', ')}${items.length > 50 ? ` и ещё ${items.length - 50}` : ''}`
      : '';
  return [
    `${state.repo}${state.sha ? ` (от ${state.sha.slice(0, 7)})` : ''}, изменено файлов: ${total}`,
    list('Изменены', changed),
    list('Новые', added),
    list('Удалены', deleted),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function pushRepo(
  context: RepoContext,
  input: { dir: string; branch?: string; title?: string; body?: string },
): Promise<string> {
  const dirName = cleanDir(input.dir);
  const { state, changed, added, deleted } = repoChanges(context.root, dirName);
  if (!state)
    return `В папке «${input.dir}» нет скачанного репозитория (сначала github_clone).`;
  if (!context.token || !allowed(context.allow, state.repo))
    return `Отправлять изменения можно только в репозитории, подключённые к агенту (${context.allow.join(', ') || 'нет'}). Пусть пользователь скачает результат через workspace_download.`;
  if (!state.sha)
    return 'Не знаю, от какого коммита скачан репозиторий. Скачайте его заново (github_clone) и повторите.';
  const files = [...changed, ...added];
  if (!files.length && !deleted.length)
    return 'Изменений нет — нечего отправлять.';
  if (files.length > MAX_PUSH_FILES)
    return `Слишком много файлов (${files.length}), максимум ${MAX_PUSH_FILES} за раз.`;

  const branch = (
    input.branch?.trim() ||
    state.branch ||
    `qastom/${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`
  ).replace(/[^\w./-]+/g, '-');
  if (branch.toLowerCase() === state.defaultBranch.toLowerCase())
    return `В основную ветку ${state.defaultBranch} напрямую не отправляю — только в отдельную ветку с pull request.`;

  const target = resolveInside(context.root, dirName);
  let bytes = 0;
  const tree: {
    path: string;
    mode: string;
    type: 'blob';
    sha: string | null;
  }[] = [];
  const repoPath = `/repos/${state.repo}`;
  for (const rel of files) {
    const full = path.join(target, rel);
    const content = fs.readFileSync(full);
    bytes += content.length;
    if (bytes > MAX_PUSH_BYTES)
      return 'Изменения больше 8 МБ — слишком много для одной отправки.';
    const blob = await api<{ sha?: string }>(
      context,
      'POST',
      `${repoPath}/git/blobs`,
      { content: content.toString('base64'), encoding: 'base64' },
    );
    if (!blob.data.sha) return `GitHub не принял файл ${rel}.`;
    const executable = (fs.statSync(full).mode & 0o111) !== 0;
    tree.push({
      path: rel,
      mode: executable ? '100755' : '100644',
      type: 'blob',
      sha: blob.data.sha,
    });
  }
  for (const rel of deleted)
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: null });

  const base = await api<{ tree?: { sha?: string } }>(
    context,
    'GET',
    `${repoPath}/git/commits/${state.sha}`,
  );
  const newTree = await api<{ sha?: string }>(
    context,
    'POST',
    `${repoPath}/git/trees`,
    { base_tree: base.data.tree?.sha, tree },
  );
  if (!newTree.data.sha) return 'GitHub не создал дерево файлов.';
  const title = input.title?.trim() || 'Изменения от QASTOM AGENT';
  const commit = await api<{ sha?: string }>(
    context,
    'POST',
    `${repoPath}/git/commits`,
    { message: title, tree: newTree.data.sha, parents: [state.sha] },
  );
  const commitSha = commit.data.sha;
  if (!commitSha) return 'GitHub не создал коммит.';

  const created = await api<{ message?: string }>(
    context,
    'POST',
    `${repoPath}/git/refs`,
    { ref: `refs/heads/${branch}`, sha: commitSha },
  );
  if (created.status === 422) {
    // Ветка уже есть: обновляем, только если это продолжение (без перезаписи чужих коммитов).
    const updated = await api<{ message?: string }>(
      context,
      'PATCH',
      `${repoPath}/git/refs/heads/${branch
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
      { sha: commitSha, force: false },
    );
    if (updated.status === 422)
      return `Ветка ${branch} уже есть и ушла вперёд. Укажите другое имя ветки (branch).`;
  }

  let prUrl = '';
  const pr = await api<{ html_url?: string; errors?: unknown }>(
    context,
    'POST',
    `${repoPath}/pulls`,
    {
      title,
      head: branch,
      base: state.defaultBranch,
      body: `${input.body?.trim() ?? ''}\n\n_Создано QASTOM AGENT._`.trim(),
    },
  );
  if (pr.status === 201) prUrl = pr.data.html_url ?? '';
  else {
    const owner = state.repo.split('/')[0];
    const open = await api<{ html_url?: string }[]>(
      context,
      'GET',
      `${repoPath}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`,
    );
    prUrl = Array.isArray(open.data) ? (open.data[0]?.html_url ?? '') : '';
  }

  // Новая точка отсчёта: следующие правки уйдут в эту же ветку.
  const states = readStates(context.root);
  const next: Record<string, string> = {};
  for (const [rel, full] of walkFiles(target))
    next[rel] = blobSha(fs.readFileSync(full));
  states[dirName] = { ...state, sha: commitSha, branch, files: next };
  writeStates(context.root, states);

  return [
    `Отправлено в ${state.repo}, ветка ${branch}: изменено ${changed.length}, новых ${added.length}, удалено ${deleted.length}.`,
    prUrl
      ? `Pull request: ${prUrl}`
      : `Pull request создать не удалось — откройте вручную: https://github.com/${state.repo}/compare/${state.defaultBranch}...${branch}`,
  ].join('\n');
}
