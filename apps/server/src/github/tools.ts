import type { Store } from '../db';
import { githubJson, type FetchLike } from './api';
import { parseRepo } from './parse';
import { decryptSecret, encryptSecret, redact } from './secret';

const TOKEN_KEY = 'github_token';

export async function saveGithubToken(
  store: Store,
  token: string,
  secret: string,
): Promise<void> {
  await store.setSetting(TOKEN_KEY, encryptSecret(token.trim(), secret));
}

export async function clearGithubToken(store: Store): Promise<void> {
  await store.setSetting(TOKEN_KEY, '');
}

export async function readGithubToken(
  store: Store,
  secret: string,
): Promise<string | undefined> {
  const stored = await store.getSetting(TOKEN_KEY);
  if (!stored) return undefined;
  try {
    const token = decryptSecret(stored, secret).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export interface GithubToolContext {
  token: string;
  allow: string[];
  fetchImpl?: FetchLike;
}

export async function runGithubTool(
  name: string,
  args: Record<string, unknown>,
  context: GithubToolContext,
): Promise<string> {
  try {
    if (name === 'github_list_repos') return await listRepos(context);
    const repo = asArg(args.repo);
    if (!allowed(context.allow, repo)) {
      return `Репозиторий «${repo || '—'}» не подключён к этому агенту. Доступны: ${context.allow.join(', ') || '—'}.`;
    }
    if (name === 'github_read_file') {
      return await readFile(context, repo, asArg(args.path), asArg(args.ref));
    }
    if (name === 'github_search_code') {
      return await searchCode(context, asArg(args.query), repo);
    }
    if (name === 'github_list_issues') {
      return await listIssues(context, repo, asArg(args.state) || 'open');
    }
    if (name === 'github_list_pulls') {
      return await listPulls(context, repo, asArg(args.state) || 'open');
    }
    return `Неизвестный инструмент ${name}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ошибка GitHub';
    return redact(message, context.token);
  }
}

function asArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function allowed(allow: string[], repo: string): boolean {
  const parsed = parseRepo(repo);
  if (!parsed) return false;
  return allow.some(
    (item) => item.toLowerCase() === parsed.fullName.toLowerCase(),
  );
}

async function listRepos(context: GithubToolContext): Promise<string> {
  if (context.allow.length === 0)
    return 'К агенту не подключён ни один репозиторий.';
  const lines = ['Репозитории агента:'];
  for (const repo of context.allow) {
    lines.push(`- ${repo}`);
  }
  return lines.join('\n');
}

async function readFile(
  context: GithubToolContext,
  repo: string,
  filePath: string,
  ref: string,
): Promise<string> {
  if (!filePath || filePath.includes('..')) return 'Укажите путь к файлу.';
  const parsed = parseRepo(repo);
  if (!parsed) return 'Некорректное имя репозитория.';
  const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const payload = await githubJson<{
    type?: string;
    size?: number;
    content?: string;
    encoding?: string;
  }>(
    context.token,
    `/repos/${parsed.owner}/${parsed.repo}/contents/${filePath
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/')}${suffix}`,
    context.fetchImpl,
  );
  if (payload.type !== 'file') return 'Это не файл.';
  if ((payload.size ?? 0) > 100_000)
    return 'Файл больше 100 КБ, он не читается целиком.';
  if (payload.encoding !== 'base64' || !payload.content)
    return 'GitHub не отдал содержимое.';
  const text = Buffer.from(payload.content, 'base64').toString('utf8');
  return text.slice(0, 100_000);
}

async function searchCode(
  context: GithubToolContext,
  query: string,
  repo: string,
): Promise<string> {
  if (!query) return 'Укажите query.';
  const parsed = parseRepo(repo);
  if (!parsed) return 'Укажите repo.';
  const q = `${query} repo:${parsed.fullName}`;
  const payload = await githubJson<{
    items?: { path?: string; html_url?: string }[];
  }>(
    context.token,
    `/search/code?q=${encodeURIComponent(q)}&per_page=10`,
    context.fetchImpl,
  );
  const items = payload.items ?? [];
  if (items.length === 0) return 'Ничего не найдено.';
  return items
    .map(
      (item) =>
        `- ${item.path ?? 'файл'}${item.html_url ? ` ${item.html_url}` : ''}`,
    )
    .join('\n');
}

async function listIssues(
  context: GithubToolContext,
  repo: string,
  state: string,
): Promise<string> {
  const parsed = parseRepo(repo);
  if (!parsed) return 'Некорректное имя репозитория.';
  const rows = await githubJson<
    { number?: number; title?: string; pull_request?: unknown }[]
  >(
    context.token,
    `/repos/${parsed.owner}/${parsed.repo}/issues?state=${encodeURIComponent(state)}&per_page=20`,
    context.fetchImpl,
  );
  const issues = rows.filter((row) => !row.pull_request);
  if (issues.length === 0) return 'Задач нет.';
  return issues
    .map((row) => `#${row.number ?? '?'} ${row.title ?? ''}`)
    .join('\n');
}

async function listPulls(
  context: GithubToolContext,
  repo: string,
  state: string,
): Promise<string> {
  const parsed = parseRepo(repo);
  if (!parsed) return 'Некорректное имя репозитория.';
  const rows = await githubJson<{ number?: number; title?: string }[]>(
    context.token,
    `/repos/${parsed.owner}/${parsed.repo}/pulls?state=${encodeURIComponent(state)}&per_page=20`,
    context.fetchImpl,
  );
  if (rows.length === 0) return 'Запросов на слияние нет.';
  return rows
    .map((row) => `#${row.number ?? '?'} ${row.title ?? ''}`)
    .join('\n');
}
