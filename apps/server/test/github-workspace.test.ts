import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blobSha,
  cloneRepo,
  describeChanges,
  pushRepo,
} from '../src/github/workspace-repo';
import { searchWorkspace } from '../src/workspace';

function makeTarball(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgz-'));
  const top = path.join(dir, 'acme-shop-abc1234');
  fs.mkdirSync(path.join(top, 'src'), { recursive: true });
  fs.writeFileSync(path.join(top, 'README.md'), '# Shop\n');
  fs.writeFileSync(
    path.join(top, 'src', 'price.js'),
    'export const vat = 20;\n',
  );
  fs.writeFileSync(path.join(top, 'old.txt'), 'old\n');
  const file = path.join(dir, 'a.tgz');
  execFileSync('tar', ['-czf', file, '-C', dir, 'acme-shop-abc1234']);
  return fs.readFileSync(file);
}

function fakeGithub() {
  const calls: { method: string; url: string; body?: any; auth?: string }[] =
    [];
  const tarball = makeTarball();
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init.headers as Record<string, string>)?.Authorization;
    calls.push({ method, url, body, auth });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });
    if (url.includes('codeload') || url.includes('/tarball/'))
      return new Response(tarball);
    if (url.endsWith('/repos/acme/shop'))
      return json({ default_branch: 'main', size: 10 });
    if (url.includes('/commits/main')) return json({ sha: 'base000' });
    if (url.includes('/git/blobs'))
      return json({ sha: `blob-${calls.length}` }, 201);
    if (url.includes('/git/commits/base000'))
      return json({ tree: { sha: 'tree0' } });
    if (url.includes('/git/trees')) return json({ sha: 'tree1' }, 201);
    if (url.endsWith('/git/commits')) return json({ sha: 'commit1' }, 201);
    if (url.endsWith('/git/refs')) return json({}, 201);
    if (url.endsWith('/pulls'))
      return json({ html_url: 'https://github.com/acme/shop/pull/7' }, 201);
    return json({ message: 'Not Found' }, 404);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('репозиторий GitHub в рабочей папке', () => {
  it('скачивает публичный без токена, находит правки и открывает PR', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const gh = fakeGithub();
    const context = { root, allow: [] as string[], fetchImpl: gh.fetchImpl };
    const cloned = await cloneRepo(context, {
      repo: 'https://github.com/acme/shop',
    });
    expect(cloned).toContain('repos/shop');
    expect(
      fs.readFileSync(path.join(root, 'repos/shop/src/price.js'), 'utf8'),
    ).toContain('vat');
    expect(gh.calls.every((call) => !call.auth)).toBe(true);
    expect(searchWorkspace(root, 'vat')).toContain('repos/shop/src/price.js:1');

    fs.writeFileSync(
      path.join(root, 'repos/shop/src/price.js'),
      'export const vat = 22;\n',
    );
    fs.writeFileSync(path.join(root, 'repos/shop/new.js'), 'x\n');
    fs.rmSync(path.join(root, 'repos/shop/old.txt'));
    const changes = describeChanges(root, 'repos/shop');
    expect(changes).toContain('src/price.js');
    expect(changes).toContain('new.js');
    expect(changes).toContain('old.txt');

    // Без подключения к агенту отправить нельзя.
    expect(
      await pushRepo(context, { dir: 'repos/shop', title: 't' }),
    ).toContain('подключённые');
    const withToken = { ...context, token: 'tok', allow: ['acme/shop'] };
    expect(
      await pushRepo(withToken, {
        dir: 'repos/shop',
        branch: 'main',
        title: 't',
      }),
    ).toContain('напрямую');
    const pushed = await pushRepo(withToken, {
      dir: 'repos/shop',
      branch: 'fix/vat',
      title: 'НДС 22%',
    });
    expect(pushed).toContain('pull/7');
    const tree = gh.calls.find((call) => call.url.endsWith('/git/trees'));
    expect(tree?.body.base_tree).toBe('tree0');
    expect(tree?.body.tree).toHaveLength(3);
    expect(
      tree?.body.tree.find((item: any) => item.path === 'old.txt').sha,
    ).toBeNull();
    expect(describeChanges(root, 'repos/shop')).toContain('изменений нет');
  });

  it('blobSha совпадает с git', () => {
    expect(blobSha(Buffer.from('hello\n'))).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });
});

describe('приватные репозитории', () => {
  it('не скачивает приватный, если он не подключён к агенту, даже с токеном для чтения', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ default_branch: 'main', private: true }),
      )) as unknown as typeof fetch;
    const result = await cloneRepo(
      { root, allow: [], readToken: 'tok', fetchImpl },
      { repo: 'acme/secret' },
    );
    expect(result).toContain('приватный');
    expect(fs.existsSync(path.join(root, 'repos/secret'))).toBe(false);
  });
});
