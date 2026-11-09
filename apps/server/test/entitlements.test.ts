import { describe, expect, it } from 'vitest';
import {
  FALLBACK_LIMITS,
  NO_LIMITS,
  TRIAL_LIMITS,
  limitsForUser,
  usageOf,
} from '../src/entitlements';

const user = (role: 'admin' | 'manager') =>
  ({
    id: 'u1',
    email: 'a@b.ru',
    name: 'A',
    role,
    status: 'active',
  }) as never;

const wallet = (patch: Record<string, unknown> = {}) =>
  ({
    userId: 'u1',
    trialUsedUsd: 0,
    balanceKop: 0,
    planId: null,
    planUntil: null,
    planLeftKop: 0,
    paymentMethodId: null,
    autorenew: false,
    spentKop: 0,
    ...patch,
  }) as never;

const settings = (patch: Record<string, unknown> = {}) =>
  ({
    enabled: true,
    trialUsd: 2,
    plans: [
      { id: 'start', limits: { agents: 3, connectors: 3, routines: 3 } },
    ],
    ...patch,
  }) as never;

describe('квоты тарифа', () => {
  it('администратор без ограничений', () => {
    expect(limitsForUser(user('admin'), settings(), wallet())).toEqual({
      limits: NO_LIMITS,
      source: 'admin',
    });
  });

  it('пока оплата выключена — без ограничений', () => {
    expect(
      limitsForUser(user('manager'), settings({ enabled: false }), wallet())
        .source,
    ).toBe('admin');
  });

  it('активный тариф даёт свои квоты', () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const result = limitsForUser(
      user('manager'),
      settings(),
      wallet({ planId: 'start', planUntil: until }),
    );
    expect(result.source).toBe('plan');
    expect(result.limits).toEqual({ agents: 3, connectors: 3, routines: 3 });
  });

  it('пробный период даёт пробные квоты', () => {
    const result = limitsForUser(user('manager'), settings(), wallet());
    expect(result.source).toBe('trial');
    expect(result.limits).toEqual(TRIAL_LIMITS);
  });

  it('без тарифа и пробных — нули', () => {
    const result = limitsForUser(
      user('manager'),
      settings(),
      wallet({ trialUsedUsd: 2 }),
    );
    expect(result.source).toBe('none');
    expect(result.limits.agents).toBe(0);
  });

  it('если у тарифа нет квот — берём запасные', () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const result = limitsForUser(
      user('manager'),
      settings({ plans: [{ id: 'start' }] }),
      wallet({ planId: 'start', planUntil: until }),
    );
    expect(result.limits).toEqual(FALLBACK_LIMITS);
  });
});

describe('расход квот', () => {
  it('считает только своё', async () => {
    const store = {
      listAgents: async () => [
        { id: 'a1', ownerId: 'u1' },
        { id: 'a2', ownerId: 'other' },
        { id: 'a3', ownerId: null },
      ],
      listMcp: async () => [{ ownerUserId: 'u1' }, { ownerUserId: null }],
      listRoutines: async () => [{ id: 'r1' }],
    };
    const usage = await usageOf(store as never, { id: 'u1' } as never);
    expect(usage).toEqual({ agents: 1, connectors: 1, routines: 1 });
  });
});
