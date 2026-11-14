import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  streamWorkspaceShell,
  type ShellStreamEvent,
} from '../src/workspace';

const saved = { url: process.env.RUNNER_URL, token: process.env.RUNNER_TOKEN };

beforeEach(() => {
  process.env.RUNNER_URL = 'http://runner.test:8080';
  process.env.RUNNER_TOKEN = 'test-token';
});
afterEach(() => {
  if (saved.url === undefined) delete process.env.RUNNER_URL;
  else process.env.RUNNER_URL = saved.url;
  if (saved.token === undefined) delete process.env.RUNNER_TOKEN;
  else process.env.RUNNER_TOKEN = saved.token;
});

async function collect(input: {
  enabled?: boolean;
  command?: string;
  fetchImpl?: typeof fetch;
}): Promise<ShellStreamEvent[]> {
  const events: ShellStreamEvent[] = [];
  await streamWorkspaceShell({
    enabled: input.enabled ?? true,
    root: '/tmp/workspaces/user/agent',
    command: input.command ?? 'ls',
    fetchImpl: input.fetchImpl,
    onEvent: (event) => {
      events.push(event);
    },
  });
  return events;
}

describe('потоковый терминал', () => {
  it('разбирает NDJSON от runner и отдаёт чанки и код выхода', async () => {
    const events = await collect({
      fetchImpl: (async () =>
        new Response(
          [
            JSON.stringify({ type: 'chunk', stream: 'stdout', data: 'hello\n' }),
            JSON.stringify({ type: 'chunk', stream: 'stderr', data: 'oops\n' }),
            JSON.stringify({
              type: 'exit',
              code: 0,
              timedOut: false,
              ms: 12,
              bytes: 11,
            }),
            '',
          ].join('\n'),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect(events).toEqual([
      { type: 'chunk', stream: 'stdout', data: 'hello\n' },
      { type: 'chunk', stream: 'stderr', data: 'oops\n' },
      { type: 'exit', code: 0, timedOut: false, ms: 12, bytes: 11 },
    ]);
  });

  it('сообщает, что терминал выключен', async () => {
    const events = await collect({ enabled: false });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
  });

  it('не запускает пустую или слишком длинную команду', async () => {
    const empty = await collect({ command: '  ' });
    expect(empty[0]).toMatchObject({ type: 'error', message: 'Пустая команда.' });
    const long = await collect({ command: 'x'.repeat(4001) });
    expect(long[0]).toMatchObject({ type: 'error' });
  });

  it('возвращает понятную ошибку при отказе песочницы', async () => {
    const events = await collect({
      fetchImpl: (async () =>
        new Response('nope', { status: 503 })) as unknown as typeof fetch,
    });
    expect(events[0]).toMatchObject({ type: 'error' });
  });
});
