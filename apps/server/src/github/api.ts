import { redact } from './secret';

export type FetchLike = typeof fetch;

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'mayak',
  'X-GitHub-Api-Version': '2022-11-28',
};

export async function githubJson<T>(
  token: string,
  path: string,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      headers: { ...HEADERS, Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'сеть недоступна';
    throw new Error(redact(`GitHub: ${message}`, token));
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = `GitHub ${response.status}`;
    try {
      const body = JSON.parse(text) as { message?: string };
      if (body.message) detail = `GitHub ${response.status}: ${body.message}`;
    } catch {
      detail = `GitHub ${response.status}`;
    }
    throw new Error(redact(detail, token));
  }
  return JSON.parse(text) as T;
}

export interface RemoteRepo {
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
}

export async function githubUser(
  token: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  const user = await githubJson<{ login?: string }>('/user', token, fetchImpl);
  if (!user.login) throw new Error('GitHub не вернул логин');
  return user.login;
}

export async function githubRepos(
  token: string,
  fetchImpl?: FetchLike,
): Promise<RemoteRepo[]> {
  const rows = await githubJson<
    {
      full_name?: string;
      private?: boolean;
      description?: string | null;
      default_branch?: string;
    }[]
  >('/user/repos?per_page=100&sort=updated', token, fetchImpl);
  return rows
    .filter((row) => typeof row.full_name === 'string')
    .map((row) => ({
      fullName: row.full_name ?? '',
      private: Boolean(row.private),
      description: row.description ?? '',
      defaultBranch: row.default_branch ?? 'main',
    }));
}
