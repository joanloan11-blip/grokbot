import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Conversation,
  KeyBalance,
  ProviderPublic,
  SpendReport,
} from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { keyBalance } from '../src/balance';
import { loadConfig, repoRoot } from '../src/config';
import { costUsd, DEFAULT_PRICES, priceFor } from '../src/pricing';
import { readOpenAiUsage } from '../src/providers/openai';

let handle: AppHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-spend-'));
  handle = await createApp(loadConfig({ dataDir, repoRoot }));
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

function send(method: string, pathname: string, body?: unknown) {
  return handle.app.request(pathname, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('pricing', () => {
  it('matches dated names but not newer versions', () => {
    expect(priceFor('gpt-5-mini-2025-08-07', DEFAULT_PRICES)).toEqual(
      DEFAULT_PRICES['gpt-5-mini'],
    );
    expect(priceFor('openai/gpt-5.4-mini', DEFAULT_PRICES)).toEqual(
      DEFAULT_PRICES['gpt-5.4-mini'],
    );
    expect(priceFor('gpt-image-2', DEFAULT_PRICES)).toEqual(
      DEFAULT_PRICES['gpt-image'],
    );
    expect(priceFor('gpt-5.9', DEFAULT_PRICES)).toBeNull();
  });

  it('charges cached input at the cached rate', () => {
    const cost = costUsd(
      { input: 1, cached: 0.1, output: 2 },
      {
        inputTokens: 1_000_000,
        cachedTokens: 500_000,
        outputTokens: 1_000_000,
      },
    );
    expect(cost).toBeCloseTo(0.5 + 0.05 + 2);
  });

  it('reads OpenAI and DeepSeek usage chunks', () => {
    expect(
      readOpenAiUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedTokens: 40 });
    expect(
      readOpenAiUsage({
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_cache_hit_tokens: 6,
      }),
    ).toMatchObject({ cachedTokens: 6 });
  });
});

describe('key balance', () => {
  it('reads the DeepSeek balance', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: 'USD', total_balance: '4.20' }],
        }),
      )) as never;
    const result = await keyBalance(
      {
        id: 'p',
        name: 'DeepSeek',
        kind: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'k',
        models: [],
        enabled: true,
        createdAt: '',
      },
      fake,
    );
    expect(result).toMatchObject({
      supported: true,
      balance: 4.2,
      currency: 'USD',
    });
  });

  it('explains when a key has no balance API', async () => {
    const result = await keyBalance({
      id: 'p',
      name: 'OpenAI',
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      models: [],
      enabled: true,
      createdAt: '',
    });
    expect(result.supported).toBe(false);
    expect(result.note).toMatch(/platform\.openai\.com/);
  });
});

describe('spend report', () => {
  it('records real tokens per agent and user', async () => {
    const providers = (await (
      await send('GET', '/api/providers')
    ).json()) as ProviderPublic[];
    const mock = providers.find((item) => item.kind === 'mock');
    const chat = (await (
      await send('POST', '/api/conversations', {
        locale: 'ru',
        providerId: mock?.id,
        model: 'mock',
      })
    ).json()) as Conversation;
    await (
      await send('POST', `/api/conversations/${chat.id}/messages`, {
        content: 'tool add {"a":2,"b":3}',
        locale: 'ru',
      })
    ).text();

    const report = (await (
      await send('GET', '/api/usage/report?period=week')
    ).json()) as SpendReport;
    expect(report.scope).toBe('all');
    expect(report.total.calls).toBeGreaterThanOrEqual(1);
    const agent = report.agents.find((row) => row.agentId === chat.agentId);
    expect(agent).toBeTruthy();
    expect(agent!.exactShare).toBe(1);
    expect(agent!.inputTokens).toBeGreaterThan(0);
    expect(agent!.outputTokens).toBeGreaterThan(0);
    expect(agent!.users).toHaveLength(1);
    expect(agent!.models[0]).toMatchObject({ model: 'mock', costUsd: 0 });
    expect(report.keys[0]!.models[0]!.price).toEqual(DEFAULT_PRICES.mock);
  });

  it('lets the admin override prices', async () => {
    const response = await send('PUT', '/api/admin/prices', {
      overrides: { mock: { input: 1000, cached: 0, output: 1000 }, bad: 1 },
    });
    expect(response.status).toBe(200);
    const report = (await (
      await send('GET', '/api/usage/report?period=day')
    ).json()) as SpendReport;
    expect(report.total.costUsd).toBeGreaterThan(0);
    const balances = (await (
      await send('GET', '/api/admin/usage/balances')
    ).json()) as KeyBalance[];
    expect(Array.isArray(balances)).toBe(true);
  });
});
