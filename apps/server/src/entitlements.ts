import type { PlanLimits } from '@mayak/shared';
import type { Store, UserRecord, Wallet } from './db';

/**
 * Квоты тарифа: сколько агентов, коннекторов и рутин можно создать.
 * Пока оплата выключена (billing.enabled = false) или пользователь —
 * администратор, ограничений нет: прод не должен упереться в лимиты.
 */

export const TRIAL_LIMITS: PlanLimits = {
  agents: 1,
  connectors: 2,
  routines: 1,
};

/** Если у тарифа в настройках не указаны квоты. */
export const FALLBACK_LIMITS: PlanLimits = {
  agents: 3,
  connectors: 3,
  routines: 3,
};

export const NO_LIMITS: PlanLimits = {
  agents: 1_000_000,
  connectors: 1_000_000,
  routines: 1_000_000,
};

export type LimitSource = 'admin' | 'plan' | 'trial' | 'none';

export interface EffectiveLimits {
  limits: PlanLimits;
  source: LimitSource;
}

/** Действующие квоты: тариф → пробный период → ничего. */
export function limitsForUser(
  user: UserRecord,
  settings: {
    enabled: boolean;
    trialUsd: number;
    plans: { id: string; limits?: PlanLimits }[];
  },
  wallet: Wallet,
): EffectiveLimits {
  if (user.role === 'admin' || !settings.enabled)
    return { limits: NO_LIMITS, source: 'admin' };
  const plan = settings.plans.find((item) => item.id === wallet.planId);
  const active =
    Boolean(plan) &&
    Boolean(wallet.planUntil) &&
    new Date(wallet.planUntil as string).getTime() > Date.now();
  if (active && plan)
    return { limits: plan.limits ?? FALLBACK_LIMITS, source: 'plan' };
  const trialLeft = Math.max(0, settings.trialUsd - wallet.trialUsedUsd);
  if (trialLeft > 0 || wallet.balanceKop > 0)
    return { limits: TRIAL_LIMITS, source: 'trial' };
  return { limits: { agents: 0, connectors: 0, routines: 0 }, source: 'none' };
}

/** Сколько пользователь уже создал своими руками. */
export async function usageOf(
  store: Store,
  user: UserRecord,
): Promise<{ agents: number; connectors: number; routines: number }> {
  const [agents, connectors, routines] = await Promise.all([
    store.listAgents(),
    store.listMcp(),
    store.listRoutines(user.id),
  ]);
  return {
    agents: agents.filter((row) => row.ownerId === user.id).length,
    connectors: connectors.filter((row) => row.ownerUserId === user.id).length,
    routines: routines.length,
  };
}
