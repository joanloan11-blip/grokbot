import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertCanSpend,
  billingState,
  chargeTokens,
  manualCredit,
  saveBillingSettings,
  startPayment,
  syncPayment,
} from '../src/billing';
import { Store } from '../src/db';

let store: Store;
let dir: string;
const SECRET = 'test-secret';
const openai = {
  kind: 'openai' as const,
  baseUrl: 'https://api.openai.com/v1',
};
const deepseek = {
  kind: 'deepseek' as const,
  baseUrl: 'https://api.deepseek.com',
};
const ovh = {
  kind: 'openai' as const,
  baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'billing-'));
  store = await Store.open({ dataDir: dir });
  await saveBillingSettings(store, SECRET, {
    enabled: true,
    shopId: '123',
    secretKey: 'live_x',
    usdRub: 100,
    markup: 2,
    trialUsd: 2,
  });
});
afterAll(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

const client = async (email: string) =>
  store.insertUser({
    email,
    name: email,
    passwordHash: '',
    role: 'manager',
    status: 'active',
    dailyRequestLimit: null,
    client: true,
  });

describe('оплата клиентов', () => {
  it('сотрудник (не клиент) не платит', async () => {
    const staff = await store.insertUser({
      email: 'staff@x.ru',
      name: 's',
      passwordHash: '',
      role: 'manager',
      status: 'active',
      dailyRequestLimit: null,
    });
    await expect(
      assertCanSpend(store, staff, deepseek, 'deepseek-chat'),
    ).resolves.toBeUndefined();
    expect((await billingState(store, staff)).applies).toBe(false);
  });

  it('пробные $2 — только на OpenAI, потом блок; бесплатные модели работают', async () => {
    const user = await client('trial@x.ru');
    await expect(
      assertCanSpend(store, user, openai, 'gpt-5.4-mini'),
    ).resolves.toBeUndefined();
    // DeepSeek в пробный период не входит.
    await expect(
      assertCanSpend(store, user, deepseek, 'deepseek-chat'),
    ).rejects.toThrow(/Пополните/);
    // gpt-5.4-mini: $0.75 / $4.5 за 1M — 1M входа + 300k выхода = $2.1 > $2.
    await chargeTokens(store, user.id, openai, 'gpt-5.4-mini', {
      inputTokens: 1_000_000,
      outputTokens: 300_000,
    });
    const state = await billingState(store, user);
    expect(state.trial.usedUsd).toBe(2);
    expect(state.balanceRub).toBeLessThan(0);
    expect(state.blocked).toBe(true);
    await expect(
      assertCanSpend(store, user, openai, 'gpt-5.4-mini'),
    ).rejects.toThrow(/Пробные/);
    // Бесплатная модель из каталога — без оплаты.
    await expect(
      assertCanSpend(store, user, ovh, 'gpt-oss-20b'),
    ).resolves.toBeUndefined();
  });

  it('пополнение через ЮKassa зачисляется один раз и только после проверки статуса', async () => {
    const user = await client('pay@x.ru');
    let status = 'pending';
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect((init.headers as Record<string, string>).authorization).toMatch(
          /^Basic /,
        );
        return new Response(
          JSON.stringify({
            id: 'pay-1',
            status: 'pending',
            amount: body.amount,
            confirmation: { confirmation_url: 'https://yoomoney.ru/pay' },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          id: 'pay-1',
          status,
          paid: status === 'succeeded',
          amount: { value: '500.00', currency: 'RUB' },
        }),
      );
    }) as unknown as typeof fetch;
    const started = await startPayment(
      store,
      SECRET,
      user,
      { kind: 'topup', amountRub: 500 },
      'https://app/?billing=return',
      fetchImpl,
    );
    expect(started.url).toContain('yoomoney');
    expect(await syncPayment(store, SECRET, 'pay-1', fetchImpl)).toBe(
      'pending',
    );
    expect((await billingState(store, user)).balanceRub).toBe(0);
    status = 'succeeded';
    await syncPayment(store, SECRET, 'pay-1', fetchImpl);
    await syncPayment(store, SECRET, 'pay-1', fetchImpl);
    expect((await billingState(store, user)).balanceRub).toBe(500);
    // Списание: $1 × 100 ₽ × наценка 2 = 200 ₽.
    await chargeTokens(store, user.id, deepseek, 'deepseek-chat', {
      inputTokens: 0,
      outputTokens: 833_334,
    });
    expect((await billingState(store, user)).balanceRub).toBeCloseTo(300, 0);
  });

  it('тариф: лимит тарифа тратится раньше баланса', async () => {
    const user = await client('plan@x.ru');
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      init.method === 'POST'
        ? new Response(
            JSON.stringify({
              id: 'plan-1',
              status: 'pending',
              confirmation: { confirmation_url: 'https://y/p' },
            }),
          )
        : new Response(
            JSON.stringify({
              id: 'plan-1',
              status: 'succeeded',
              paid: true,
              amount: { value: '990.00', currency: 'RUB' },
              payment_method: { id: 'pm-1', saved: true },
            }),
          )) as unknown as typeof fetch;
    await startPayment(
      store,
      SECRET,
      user,
      { kind: 'plan', planId: 'start' },
      'https://app',
      fetchImpl,
    );
    await syncPayment(store, SECRET, 'plan-1', fetchImpl);
    await manualCredit(store, user.id, 100, 'подарок');
    let state = await billingState(store, user);
    expect(state.plan?.leftRub).toBe(900);
    expect(state.balanceRub).toBe(100);
    await chargeTokens(store, user.id, deepseek, 'deepseek-chat', {
      inputTokens: 0,
      outputTokens: 4_166_667,
    });
    state = await billingState(store, user);
    expect(state.plan?.leftRub).toBe(0);
    expect(state.balanceRub).toBeCloseTo(0, 0);
  });
});
