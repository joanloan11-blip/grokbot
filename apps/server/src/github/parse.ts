const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseRepo(
  input: string,
): { owner: string; repo: string; fullName: string } | undefined {
  const text = input
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const fromUrl = text.match(/github\.com[:/]([^/\s]+)\/([^/\s#?]+)/i);
  const short = text.match(/^([^/\s]+)\/([^/\s]+)$/);
  const owner = fromUrl?.[1] ?? short?.[1];
  const repo = fromUrl?.[2] ?? short?.[2];
  if (!owner || !repo) return undefined;
  const fullName = `${owner}/${repo}`;
  if (!REPO.test(fullName) || owner.includes('..') || repo.includes('..')) {
    return undefined;
  }
  return { owner, repo, fullName };
}

export function unsafeTarPath(entry: string): boolean {
  const name = entry.replace(/\\/g, '/');
  if (!name || name.startsWith('/') || name.includes('\0')) return true;
  return name.split('/').some((part) => part === '..');
}
