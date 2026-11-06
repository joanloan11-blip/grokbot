import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shrinkToolResults } from '../src/agent/loop';
import { streamAnthropic } from '../src/providers/anthropic';
import {
  editWorkspaceFile,
  globWorkspace,
  readWorkspaceFile,
  runInRunner,
} from '../src/workspace';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'code-'));

describe('инструменты кода как у Claude Code', () => {
  it('читает с номерами строк и по частям', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\nfour\n');
    expect(readWorkspaceFile(root, 'a.ts', { numbered: true })).toBe(
      '     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour',
    );
    const part = readWorkspaceFile(root, 'a.ts', {
      numbered: true,
      offset: 2,
      limit: 2,
    });
    expect(part).toContain('     2\ttwo\n     3\tthree');
    expect(part).toContain('offset 4');
  });

  it('ищет файлы по маске', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'repos/x/src/lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'repos/x/node_modules/y'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, 'repos/x/src/lib/a.ts'), '');
    fs.writeFileSync(path.join(root, 'repos/x/src/b.ts'), '');
    fs.writeFileSync(path.join(root, 'repos/x/src/c.js'), '');
    fs.writeFileSync(path.join(root, 'repos/x/node_modules/y/d.ts'), '');
    const all = globWorkspace(root, '**/*.ts');
    expect(all).toContain('repos/x/src/lib/a.ts');
    expect(all).toContain('repos/x/src/b.ts');
    expect(all).not.toContain('d.ts');
    expect(all).not.toContain('c.js');
    const scoped = globWorkspace(root, 'src/*.ts', 'repos/x');
    expect(scoped).toBe('repos/x/src/b.ts');
  });

  it('правит все вхождения и подсказывает про номера строк', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.py'), 'x = 1\nprint(x)\n');
    expect(editWorkspaceFile(root, 'a.py', 'x', 'y')).toContain('2 раз');
    expect(editWorkspaceFile(root, 'a.py', 'x', 'y', true)).toContain('DIFF:');
    expect(fs.readFileSync(path.join(root, 'a.py'), 'utf8')).toBe(
      'y = 1\nprint(y)\n',
    );
    expect(editWorkspaceFile(root, 'a.py', '     1\ty = 1', 'z')).toContain(
      'номера строк',
    );
  });

  it('сокращает старые результаты инструментов в долгом цикле', () => {
    const history = [
      { role: 'user' as const, content: 'задача' },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: 'tool' as const,
        content: `${i}`.repeat(1000),
        toolCallId: `c${i}`,
      })),
    ];
    shrinkToolResults(history, 1, 7000);
    expect(history[1]!.content).toContain('сокращено');
    expect(history[10]!.content).toHaveLength(1000);
  });
});

describe('runner', () => {
  afterEach(() => {
    delete process.env.RUNNER_URL;
    delete process.env.RUNNER_TOKEN;
  });
  it('шлёт команду в песочницу с пользователем и папкой агента', async () => {
    process.env.RUNNER_URL = 'http://runner:8080';
    process.env.RUNNER_TOKEN = 'secret';
    let sent: any;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = {
        url,
        body: JSON.parse(String(init.body)),
        headers: init.headers,
      };
      return new Response(
        JSON.stringify({ output: 'ok\n', code: 0, ms: 1200 }),
      );
    }) as unknown as typeof fetch;
    const out = await runInRunner({
      root: '/app/data/workspaces/user_1/agent-2',
      command: 'npm test',
      fetchImpl,
    });
    expect(sent.url).toBe('http://runner:8080/run');
    expect(sent.body).toMatchObject({
      user: 'user_1',
      scope: 'agent-2',
      command: 'npm test',
    });
    expect((sent.headers as Record<string, string>)['x-runner-token']).toBe(
      'secret',
    );
    expect(out).toContain('код выхода 0');
  });
});

describe('Claude: кэш промпта', () => {
  it('ставит cache_control на системный промпт, инструменты и последнее сообщение', async () => {
    let body: any;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      );
    }) as unknown as typeof fetch;
    try {
      for await (const _ of streamAnthropic({
        baseUrl: 'https://example.test',
        apiKey: 'k',
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
        tools: [
          { name: 'a', description: 'a', inputSchema: { type: 'object' } },
          { name: 'b', description: 'b', inputSchema: { type: 'object' } },
        ],
      }));
    } finally {
      globalThis.fetch = original;
    }
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.messages.at(-1).content.at(-1).cache_control).toEqual({
      type: 'ephemeral',
    });
    expect(body.max_tokens).toBeGreaterThanOrEqual(16000);
  });
});
