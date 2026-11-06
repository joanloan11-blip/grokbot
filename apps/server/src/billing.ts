import { randomUUID } from 'node:crypto';
import type {
  BillingPlan,
  BillingSettings,
  BillingState,
  ModelPrice,
  ProviderKind,
} from '@mayak/shared';
import type { Store, UserRecord, Wallet } from './db';
import { HttpError, badRequest } from './errors';
import { decryptSecret, encryptSecret } from './github/secret';
import { priceForModel } from './spend';

/**
 * Оплата для клиентов (тех, кто зарегистрировался сам): пробные $2 на модели OpenAI,
 * потом тариф с включённым лимитом и пополнение баланса через ЮKassa.
 * Сотрудники (приглашённые менеджеры) и администратор не платят.
 */

const SETTINGS_KEY = 'billing_settings';
const SECRET_KEY = 'yookassa_secret';
const API = 'https://api.yookassa.ru/v3';

export const DEFAULT_PLANS: BillingPlan[] = [
  { id: 'start', name: 'Старт', priceRub: 990, includedRub: 900, days: 30 },
  { id: 'pro', name: 'Про', priceRub: 2990, includedRub: 2800, days: 30 },
];

type StoredSettings = Omit<BillingSettings, 'hasSecret' | 'webhookUrl'>;

const DEFAULTS: StoredSettings = {
  enabled: false,
  shopId: '',
  usdRub: 95,
  markup: 2,
  trialUsd: 2,
  trialHosts: ['api.openai.com'],
  plans: DEFAULT_PLANS,
  topups: [300, 500, 1000, 3000],
  receipts: false,
  vatCode: 1,
  recurring: false,
};

export async function readBillingSettings(
  store: Store,
): Promise<StoredSettings> {
  try {
    const raw = JSON.parse(
      (await store.getSetting(SETTINGS_KEY)) ?? '{}',
    ) as Partial<StoredSettings>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function publicBillingSettings(
  store: Store,
  webhookUrl: string,
): Promise<BillingSettings> {
  return {
    ...(await readBillingSettings(store)),
    hasSecret: Boolean(await store.getSetting(SECRET_KEY)),
    webhookUrl,
  };
}

const num = (value: unknown, fallback: number, min = 0, max = 1e9) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
};

export async function saveBillingSettings(
  store: Store,
  secret: string,
  input: Record<string, unknown>,
): Promise<void> {
  const current = await readBillingSettings(store);
  const plans = Array.isArray(input.plans)
    ? input.plans
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === 'object',
        )
        .map((item, index) => ({
          id:
            typeof item.id === 'string' && /^[\w-]{1,40}$/.test(item.id)
              ? item.id
              : `plan-${index + 1}`,
          name: String(item.name ?? '').trim() || `Тариф ${index + 1}`,
          priceRub: num(item.priceRub, 990, 1, 1_000_000),
          includedRub: num(item.includedRub, 900, 0, 10_000_000),
          days: Math.round(num(item.days, 30, 1, 366)),
          description:
            typeof item.description === 'string'
              ? item.description.slice(0, 300)
              : undefined,
        }))
        .slice(0, 6)
    : current.plans;
  const next: StoredSettings = {
    enabled:
      input.enabled === undefined ? current.enabled : input.enabled === true,
    shopId:
      typeof input.shopId === 'string' ? input.shopId.trim() : current.shopId,
    usdRub: num(input.usdRub, current.usdRub, 1, 1000),
    markup: num(input.markup, current.markup, 1, 20),
    trialUsd: num(input.trialUsd, current.trialUsd, 0, 1000),
    trialHosts: Array.isArray(input.trialHosts)
      ? input.trialHosts
          .map((host) => String(host).trim().toLowerCase())
          .filter(Boolean)
      : current.trialHosts,
    plans,
    topups: Array.isArray(input.topups)
      ? input.topups
          .map((value) => Math.round(num(value, 0, 0, 1_000_000)))
          .filter((value) => value >= 10)
          .slice(0, 6)
      : current.topups,
    receipts:
      input.receipts === undefined ? current.receipts : input.receipts === true,
    vatCode: Math.round(num(input.vatCode, current.vatCode, 1, 12)),
    recurring:
      input.recurring === undefined
        ? current.recurring
        : input.recurring === true,
  };
  await store.setSetting(SETTINGS_KEY, JSON.stringify(next));
  if (typeof input.secretKey === 'string' && input.secretKey.trim())
    await store.setSetting(
      SECRET_KEY,
      encryptSecret(input.secretKey.trim(), secret),
    );
}

export function billingApplies(
  user: Pick<UserRecord, 'role' | 'client'> | undefined,
  settings: StoredSettings,
): boolean {
  return Boolean(
    settings.enabled && user && user.client && user.role !== 'admin',
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const isFree = (price: ModelPrice | null) =>
  Boolean(price && price.input === 0 && price.output === 0);

const planActive = (wallet: Wallet) =>
  Boolean(
    wallet.planId &&
      wallet.planUntil &&
      new Date(wallet.planUntil).getTime() > Date.now(),
  );

const trialFor = (settings: StoredSettings, wallet: Wallet, baseUrl: string) =>
  settings.trialHosts.includes(hostOf(baseUrl))
    ? Math.max(0, settings.trialUsd - wallet.trialUsedUsd)
    : 0;

export const BLOCKED_MESSAGE =
  'Пробные $2 на модели OpenAI закончились. Пополните баланс или выберите тариф в разделе «Оплата» — бесплатные модели работают без оплаты.';

/** Можно ли клиенту запустить эту модель сейчас. Бросает 402, если нужна оплата. */
export async function assertCanSpend(
  store: Store,
  user: UserRecord | undefined,
  provider: { kind: ProviderKind; baseUrl: string },
  model: string,
): Promise<void> {
  const settings = await readBillingSettings(store);
  if (!user || !billingApplies(user, settings) || provider.kind === 'mock')
    return;
  const price = await priceForModel(store, provider.baseUrl, model);
  if (isFree(price)) return;
  if (!price)
    throw new HttpError(
      402,
      `У модели «${model}» нет цены — выберите другую модель. Администратору: укажите цену в разделе расходов.`,
    );
  const wallet = await store.getWallet(user.id);
  if (trialFor(settings, wallet, provider.baseUrl) > 0) return;
  if (planActive(wallet) && wallet.planLeftKop > 0) return;
  if (wallet.balanceKop > 0) return;
  throw new HttpError(402, BLOCKED_MESSAGE);
}

/** Списать стоимость обращения к модели: пробные → тариф → баланс. */
export async function chargeUsage(
  store: Store,
  userId: string,
  provider: { kind: ProviderKind; baseUrl: string },
  costUsd: number | null,
): Promise<void> {
  if (!costUsd || costUsd <= 0 || provider.kind === 'mock') return;
  const settings = await readBillingSettings(store);
  const user = await store.getUser(userId);
  if (!billingApplies(user, settings)) return;
  const wallet = await store.getWallet(userId);
  let left = costUsd;
  const trial = trialFor(settings, wallet, provider.baseUrl);
  if (trial > 0) {
    const used = Math.min(trial, left);
    wallet.trialUsedUsd = Math.round((wallet.trialUsedUsd + used) * 1e6) / 1e6;
    left -= used;
  }
  if (left > 0) {
    let kop = Math.ceil(left * settings.usdRub * settings.markup * 100);
    wallet.spentKop += kop;
    if (planActive(wallet) && wallet.planLeftKop > 0) {
      const fromPlan = Math.min(wallet.planLeftKop, kop);
      wallet.planLeftKop -= fromPlan;
      kop -= fromPlan;
    }
    // Остаток — с баланса; последний запрос может увести его чуть в минус.
    wallet.balanceKop -= kop;
  }
  await store.saveWallet(wallet);
}

/** Стоимость хода по токенам — для списания из turn/context/images. */
export async function chargeTokens(
  store: Store,
  userId: string,
  provider: { kind: ProviderKind; baseUrl: string },
  model: string,
  tokens: { inputTokens: number; outputTokens: number; cachedTokens?: number },
): Promise<void> {
  const settings = await readBillingSettings(store);
  if (!settings.enabled) return;
  const price = await priceForModel(store, provider.baseUrl, model);
  if (!price || isFree(price)) return;
  const cached = Math.min(tokens.cachedTokens ?? 0, tokens.inputTokens);
  const cost =
    ((tokens.inputTokens - cached) * price.input +
      cached * price.cached +
      tokens.outputTokens * price.output) /
    1_000_000;
  await chargeUsage(store, userId, provider, cost);
}

export async function billingState(
  store: Store,
  user: UserRecord,
): Promise<BillingState> {
  const settings = await readBillingSettings(store);
  const wallet = await store.getWallet(user.id);
  const plan = settings.plans.find((item) => item.id === wallet.planId);
  const active = planActive(wallet);
  const payments = await store.listPayments(user.id, 20);
  const applies = billingApplies(user, settings);
  const trialLeft = Math.max(0, settings.trialUsd - wallet.trialUsedUsd);
  return {
    applies,
    enabled: settings.enabled,
    trial: {
      limitUsd: settings.trialUsd,
      usedUsd: Math.min(settings.trialUsd, wallet.trialUsedUsd),
      providers: settings.trialHosts.join(', '),
    },
    balanceRub: Math.round(wallet.balanceKop) / 100,
    plan:
      active && wallet.planId && wallet.planUntil
        ? {
            id: wallet.planId,
            name: plan?.name ?? wallet.planId,
            until: wallet.planUntil,
            leftRub: Math.max(0, wallet.planLeftKop) / 100,
          }
        : null,
    autorenew: wallet.autorenew,
    canAutorenew: settings.recurring && Boolean(wallet.paymentMethodId),
    plans: settings.plans,
    topups: settings.topups,
    payments: payments.map((item) => ({
      id: item.id,
      kind: item.kind,
      amountRub: item.amountKop / 100,
      status: item.status,
      description: item.description,
      createdAt: item.createdAt,
    })),
    rubPerUsd: Math.round(settings.usdRub * settings.markup * 100) / 100,
    blocked:
      applies &&
      trialLeft <= 0 &&
      !(active && wallet.planLeftKop > 0) &&
      wallet.balanceKop <= 0,
  };
}

// ---------------------------------------------------------------- ЮKassa

interface YooPayment {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  paid?: boolean;
  amount?: { value: string; currency: string };
  confirmation?: { confirmation_url?: string };
  payment_method?: { id?: string; saved?: boolean };
  metadata?: Record<string, string>;
}

async function credentials(store: Store, secret: string) {
  const settings = await readBillingSettings(store);
  const stored = await store.getSetting(SECRET_KEY);
  if (!settings.shopId || !stored)
    throw new HttpError(
      503,
      'Оплата ещё не настроена: администратор должен указать магазин ЮKassa.',
    );
  return {
    settings,
    auth: `Basic ${Buffer.from(`${settings.shopId}:${decryptSecret(stored, secret)}`).toString('base64')}`,
  };
}

async function yoo<T>(
  auth: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      authorization: auth,
      'content-type': 'application/json',
      ...(method === 'POST' ? { 'idempotence-key': randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    description?: string;
  };
  if (!response.ok)
    throw new HttpError(
      502,
      `ЮKassa ${response.status}: ${(data as { description?: string }).description ?? 'ошибка'}`,
    );
  return data;
}

const money = (kop: number) => ({
  value: (kop / 100).toFixed(2),
  currency: 'RUB',
});

/** Создать платёж и вернуть ссылку на оплату. */
export async function startPayment(
  store: Store,
  secret: string,
  user: UserRecord,
  input:
    | { kind: 'topup'; amountRub: number }
    | { kind: 'plan'; planId: string },
  returnUrl: string,
  fetchImpl?: typeof fetch,
): Promise<{ id: string; url: string }> {
  const { settings, auth } = await credentials(store, secret);
  let amountKop: number;
  let description: string;
  let planId: string | null = null;
  if (input.kind === 'topup') {
    const rub = Math.round(Number(input.amountRub));
    if (!Number.isFinite(rub) || rub < 10 || rub > 100_000)
      throw badRequest('Сумма пополнения — от 10 до 100 000 ₽');
    amountKop = rub * 100;
    description = `Пополнение баланса QASTOM AGENT на ${rub} ₽`;
  } else {
    const plan = settings.plans.find((item) => item.id === input.planId);
    if (!plan) throw badRequest('Тариф не найден');
    amountKop = Math.round(plan.priceRub * 100);
    description = `Тариф «${plan.name}» QASTOM AGENT на ${plan.days} дн.`;
    planId = plan.id;
  }
  const payment = await yoo<YooPayment>(
    auth,
    'POST',
    '/payments',
    {
      amount: money(amountKop),
      capture: true,
      description,
      confirmation: { type: 'redirect', return_url: returnUrl },
      metadata: { userId: user.id, kind: input.kind, planId: planId ?? '' },
      ...(input.kind === 'plan' && settings.recurring
        ? { save_payment_method: true }
        : {}),
      ...(settings.receipts
        ? {
            receipt: {
              customer: { email: user.email },
              items: [
                {
                  description: description.slice(0, 128),
                  quantity: '1.00',
                  amount: money(amountKop),
                  vat_code: settings.vatCode,
                  payment_mode: 'full_payment',
                  payment_subject: 'service',
                },
              ],
            },
          }
        : {}),
    },
    fetchImpl,
  );
  await store.insertPayment({
    id: payment.id,
    userId: user.id,
    kind: input.kind,
    planId,
    amountKop,
    status: payment.status,
    description,
  });
  const url = payment.confirmation?.confirmation_url;
  if (!url) throw new HttpError(502, 'ЮKassa не вернула ссылку на оплату');
  return { id: payment.id, url };
}

/** Зачислить оплаченный платёж (один раз). */
async function credit(
  store: Store,
  record: {
    id: string;
    userId: string;
    kind: string;
    planId: string | null;
    amountKop: number;
  },
  payment: YooPayment,
): Promise<void> {
  if (!(await store.claimPayment(record.id))) return;
  const settings = await readBillingSettings(store);
  const wallet = await store.getWallet(record.userId);
  if (record.kind === 'topup' || record.kind === 'manual') {
    wallet.balanceKop += record.amountKop;
  } else {
    const plan = settings.plans.find((item) => item.id === record.planId);
    const days = plan?.days ?? 30;
    // Продление того же тарифа — от конца текущего периода, иначе — с сегодняшнего дня.
    const from =
      wallet.planId === record.planId &&
      wallet.planUntil &&
      new Date(wallet.planUntil).getTime() > Date.now()
        ? new Date(wallet.planUntil).getTime()
        : Date.now();
    wallet.planId = record.planId;
    wallet.planUntil = new Date(from + days * 86_400_000).toISOString();
    wallet.planLeftKop = Math.round((plan?.includedRub ?? 0) * 100);
    if (payment.payment_method?.saved && payment.payment_method.id) {
      wallet.paymentMethodId = payment.payment_method.id;
      if (record.kind === 'plan') wallet.autorenew = true;
    }
  }
  await store.saveWallet(wallet);
}

/** Сверить платёж с ЮKassa (вебхук или возврат пользователя) и зачислить, если оплачен. */
export async function syncPayment(
  store: Store,
  secret: string,
  id: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const record = await store.getPayment(id);
  if (!record) return 'unknown';
  if (record.credited) return 'succeeded';
  const { auth } = await credentials(store, secret);
  // Статус берём только из API ЮKassa — тело уведомления не доверяем.
  const payment = await yoo<YooPayment>(
    auth,
    'GET',
    `/payments/${encodeURIComponent(id)}`,
    undefined,
    fetchImpl,
  );
  if (payment.status !== record.status)
    await store.setPaymentStatus(id, payment.status);
  if (
    payment.status === 'succeeded' &&
    payment.paid !== false &&
    Math.round(Number(payment.amount?.value ?? 0) * 100) === record.amountKop
  )
    await credit(store, record, payment);
  return payment.status;
}

/** Ручное зачисление администратором (наличные, перевод, подарок). */
export async function manualCredit(
  store: Store,
  userId: string,
  amountRub: number,
  note: string,
): Promise<void> {
  const kop = Math.round(amountRub * 100);
  if (!Number.isFinite(kop) || kop === 0) throw badRequest('Укажите сумму');
  const id = `manual-${randomUUID()}`;
  await store.insertPayment({
    id,
    userId,
    kind: 'manual',
    amountKop: kop,
    status: 'succeeded',
    description: note || 'Зачисление администратором',
  });
  await credit(
    store,
    { id, userId, kind: 'manual', planId: null, amountKop: kop },
    { id, status: 'succeeded' },
  );
}

/** Автопродление тарифов по сохранённой карте (если включено и ЮKassa разрешила автоплатежи). */
export async function renewDuePlans(
  store: Store,
  secret: string,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const settings = await readBillingSettings(store);
  if (!settings.enabled || !settings.recurring) return 0;
  const stored = await store.getSetting(SECRET_KEY);
  if (!settings.shopId || !stored) return 0;
  let renewed = 0;
  for (const wallet of await store.listWallets()) {
    if (!wallet.autorenew || !wallet.paymentMethodId || !wallet.planId)
      continue;
    const until = wallet.planUntil ? new Date(wallet.planUntil).getTime() : 0;
    if (until - Date.now() > 3_600_000) continue;
    const plan = settings.plans.find((item) => item.id === wallet.planId);
    const user = await store.getUser(wallet.userId);
    if (!plan || !user) continue;
    // Не чаще раза в сутки на пользователя.
    const recent = (await store.listPayments(user.id, 5)).find(
      (item) =>
        item.kind === 'renew' &&
        Date.now() - new Date(item.createdAt).getTime() < 86_400_000,
    );
    if (recent) continue;
    try {
      const { auth } = await credentials(store, secret);
      const amountKop = Math.round(plan.priceRub * 100);
      const description = `Продление тарифа «${plan.name}» QASTOM AGENT`;
      const payment = await yoo<YooPayment>(
        auth,
        'POST',
        '/payments',
        {
          amount: money(amountKop),
          capture: true,
          payment_method_id: wallet.paymentMethodId,
          description,
          metadata: { userId: user.id, kind: 'renew', planId: plan.id },
        },
        fetchImpl,
      );
      await store.insertPayment({
        id: payment.id,
        userId: user.id,
        kind: 'renew',
        planId: plan.id,
        amountKop,
        status: payment.status,
        description,
      });
      if (payment.status === 'succeeded') {
        await syncPayment(store, secret, payment.id, fetchImpl);
        renewed += 1;
      }
      if (payment.status === 'canceled') {
        wallet.autorenew = false;
        await store.saveWallet(wallet);
      }
    } catch {
      // попробуем завтра
    }
  }
  return renewed;
}
