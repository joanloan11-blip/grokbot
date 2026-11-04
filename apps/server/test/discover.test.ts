import http from 'node:http';
import type net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type DiscoverResult,
  type ProviderPublic,
  guessProviderFromModel,
  guessProvidersFromKey,
} from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';

let handle: AppHandle;
let dataDir: string;
let fake: http.Server;
let base = '';
let seenAuth: string[] = [];

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-discover-'));
  handle = await createApp(loadConfig({ dataDir, repoRoot }));
  fake = http.createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ''));
    if (req.headers.authorization !== 'Bearer sk-good-key') {
      res.statusCode = 401;
      res.end('{"error":"bad key"}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        data: [
          { id: 'llama3.1:8b' },
          { id: 'text-embedding-3-small' },
          { id: 'qwen2.5:14b' },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}/v1`;
});

afterAll(async () => {
  fake.close();
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

function post(pathname: string, body: unknown) {
  return handle.app.request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('guessing', () => {
  it('detects providers from key prefixes', () => {
    expect(guessProvidersFromKey('sk-ant-api03-x')[0]?.kind).toBe('anthropic');
    expect(guessProvidersFromKey('AIzaSyX')[0]?.kind).toBe('gemini');
    expect(guessProvidersFromKey('sk-proj-abc')[0]?.name).toBe('OpenAI');
    expect(guessProvidersFromKey('sk-or-v1-abc')[0]?.baseUrl).toContain(
      'openrouter',
    );
    expect(guessProvidersFromKey('xai-abc')[0]?.baseUrl).toContain('x.ai');
    expect(guessProvidersFromKey('nvapi-abc')[0]).toMatchObject({
      name: 'NVIDIA',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
    });
    expect(
      guessProvidersFromKey('sk-0123abcd').map((item) => item.kind),
    ).toEqual(['deepseek', 'openai']);
  });

  it('detects providers from model names', () => {
    expect(guessProviderFromModel('claude-sonnet-4-5')?.kind).toBe('anthropic');
    expect(guessProviderFromModel('gemini-2.5-flash')?.kind).toBe('gemini');
    expect(guessProviderFromModel('deepseek-chat')?.kind).toBe('deepseek');
    expect(guessProviderFromModel('gpt-4o-mini')?.name).toBe('OpenAI');
    expect(guessProviderFromModel('o3-mini')?.name).toBe('OpenAI');
    expect(guessProviderFromModel('grok-4')?.name).toBe('xAI Grok');
    expect(guessProviderFromModel('meta-llama/llama-3.1-70b')?.name).toBe(
      'OpenRouter',
    );
    expect(guessProviderFromModel('my-local-model')).toBeUndefined();
  });
});

describe('discover endpoint', () => {
  it('loads chat models from an OpenAI-compatible server with the typed key', async () => {
    const result = (await (
      await post('/api/providers/discover', {
        apiKey: 'sk-good-key',
        baseUrl: base,
      })
    ).json()) as DiscoverResult;
    expect(result.verified).toBe(true);
    expect(result.kind).toBe('openai');
    expect(result.models).toContain('llama3.1:8b');
    expect(result.models).not.toContain('text-embedding-3-small');
  });

  it('reports a wrong key', async () => {
    const result = (await (
      await post('/api/providers/discover', { apiKey: 'sk-bad', baseUrl: base })
    ).json()) as DiscoverResult;
    expect(result.verified).toBe(false);
    expect(result.error).toContain('Ключ');
  });

  it('reuses a saved key server-side for a new provider of the same kind', async () => {
    const created = await post('/api/providers', {
      name: 'Local',
      kind: 'openai',
      baseUrl: base,
      apiKey: 'sk-good-key',
      models: ['llama3.1:8b'],
    });
    const donor = (await created.json()) as ProviderPublic;
    seenAuth = [];
    const result = (await (
      await post('/api/providers/discover', { kind: 'openai', baseUrl: base })
    ).json()) as DiscoverResult;
    expect(result.verified).toBe(true);
    expect(result.keyFrom?.providerId).toBe(donor.id);
    expect(JSON.stringify(result)).not.toContain('sk-good-key');

    const second = (await (
      await post('/api/providers', {
        name: 'Local copy',
        kind: 'openai',
        baseUrl: base,
        models: ['qwen2.5:14b'],
        keyFromProviderId: donor.id,
      })
    ).json()) as ProviderPublic;
    expect(second.hasApiKey).toBe(true);
    // Сохранённого провайдера можно обновить без повторного ввода ключа.
    const refresh = (await (
      await post('/api/providers/discover', { providerId: second.id })
    ).json()) as DiscoverResult;
    expect(refresh.models).toContain('qwen2.5:14b');
  });
});
