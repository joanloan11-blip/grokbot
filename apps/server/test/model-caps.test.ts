import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRow } from '../src/db';
import { probeCaps } from '../src/model-caps';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sse(chunks: unknown[]): Response {
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const provider = (baseUrl: string): ProviderRow => ({
  id: 'p',
  name: 'P',
  kind: 'openai',
  baseUrl,
  apiKey: 'k',
  models: ['m'],
  enabled: true,
  createdAt: '',
  ownerUserId: null,
});

describe('model capability probe', () => {
  it('detects tool calling', async () => {
    globalThis.fetch = vi.fn(async () =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'c1',
                    function: {
                      name: 'stock_lookup',
                      arguments: '{"query":"4G0"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
    ) as typeof fetch;
    expect(await probeCaps(provider('https://a.test/v1'), 'm')).toMatchObject({
      ok: true,
      tools: true,
    });
  });

  it('marks a text-only model', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.tools)
        return new Response(
          '{"message":"feature \'tool calls\' is not currently supported"}',
          {
            status: 400,
          },
        );
      return sse([
        { choices: [{ delta: { content: 'pong' }, finish_reason: 'stop' }] },
      ]);
    }) as typeof fetch;
    expect(await probeCaps(provider('https://b.test/v1'), 'm')).toMatchObject({
      ok: true,
      tools: false,
    });
  });

  it('does not fail a model on rate limits, fails it on 404', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('slow down', { status: 429 }),
    ) as typeof fetch;
    expect((await probeCaps(provider('https://c.test/v1'), 'm')).ok).toBeNull();
    globalThis.fetch = vi.fn(
      async () =>
        new Response('{"error":{"message":"model_not_found"}}', {
          status: 404,
        }),
    ) as typeof fetch;
    expect((await probeCaps(provider('https://d.test/v1'), 'm')).ok).toBe(
      false,
    );
  });
});

describe('background model checks', () => {
  it('picks unchecked, old and timed-out models', async () => {
    const { staleModels } = await import('../src/model-caps');
    const now = Date.parse('2026-11-06T12:00:00Z');
    const p = {
      ...provider('https://s.test/v1'),
      models: ['new', 'fresh', 'old', 'slow'],
    };
    const caps = {
      fresh: { ok: true, tools: true, checkedAt: '2026-11-06T10:00:00Z' },
      old: { ok: true, tools: true, checkedAt: '2026-11-04T10:00:00Z' },
      slow: { ok: null, tools: null, checkedAt: '2026-11-06T10:00:00Z' },
    };
    expect(staleModels(p, caps, now)).toEqual(['new', 'old', 'slow']);
  });

  it('keeps earlier results when only some models are rechecked', async () => {
    const { checkProviderModels } = await import('../src/model-caps');
    const settings = new Map<string, string>();
    const store = {
      getSetting: async (key: string) => settings.get(key),
      setSetting: async (key: string, value: string) =>
        void settings.set(key, value),
    } as never;
    settings.set(
      'model_caps',
      JSON.stringify({ p: { a: { ok: true, tools: true, checkedAt: 'x' } } }),
    );
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 404 }),
    ) as typeof fetch;
    const result = await checkProviderModels(
      store,
      { ...provider('https://k.test/v1'), models: ['a', 'b'] },
      { only: ['b'] },
    );
    expect(result.a?.ok).toBe(true);
    expect(result.b?.ok).toBe(false);
  });
});
