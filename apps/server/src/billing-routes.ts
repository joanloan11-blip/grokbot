import type { Context, Hono } from 'hono';
import type { AppConfig } from './config';
import type { Store, UserRecord } from './db';
import {
  billingState,
  manualCredit,
  publicBillingSettings,
  readBillingSettings,
  saveBillingSettings,
  startPayment,
  syncPayment,
} from './billing';
import { HttpError, badRequest } from './errors';
import { isRecord } from './util';

export function registerBillingRoutes(
  app: Hono,
  deps: {
    store: Store;
    config: AppConfig;
    actor: (c: Context) => Promise<UserRecord>;
    readBody: (c: Context) => Promise<unknown>;
    siteUrl: (c: Context) => string;
    fetchImpl?: typeof fetch;
  },
): void {
  const { store } = deps;
  const secret = deps.config.jwtSecret;
  const admin = async (c: Context) => {
    const user = await deps.actor(c);
    if (user.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    return user;
  };
  const webhookUrl = (c: Context) => `${deps.siteUrl(c)}/api/public/yookassa`;

  // Для главной страницы: пробный период и тарифы (без входа).
  app.get('/api/public/plans', async (c) => {
    const settings = await readBillingSettings(store);
    return c.json({
      enabled: settings.enabled,
      trialUsd: settings.trialUsd,
      plans: settings.plans,
    });
  });

  app.get('/api/billing', async (c) => {
    const user = await deps.actor(c);
    return c.json(await billingState(store, user));
  });

  app.post('/api/billing/pay', async (c) => {
    const user = await deps.actor(c);
    const body = await deps.readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const returnUrl = `${deps.siteUrl(c)}/?billing=return`;
    const result =
      body.kind === 'plan'
        ? await startPayment(
            store,
            secret,
            user,
            { kind: 'plan', planId: String(body.planId ?? '') },
            returnUrl,
            deps.fetchImpl,
          )
        : await startPayment(
            store,
            secret,
            user,
            { kind: 'topup', amountRub: Number(body.amountRub) },
            returnUrl,
            deps.fetchImpl,
          );
    return c.json(result);
  });

  // После возврата с ЮKassa: проверить свои незавершённые платежи, не дожидаясь уведомления.
  app.post('/api/billing/refresh', async (c) => {
    const user = await deps.actor(c);
    const pending = (await store.listPayments(user.id, 10)).filter(
      (item) =>
        !item.credited &&
        item.kind !== 'manual' &&
        (item.status === 'pending' || item.status === 'waiting_for_capture'),
    );
    for (const item of pending)
      await syncPayment(store, secret, item.id, deps.fetchImpl).catch(
        () => undefined,
      );
    return c.json(await billingState(store, user));
  });

  app.post('/api/billing/autorenew', async (c) => {
    const user = await deps.actor(c);
    const body = await deps.readBody(c);
    const wallet = await store.getWallet(user.id);
    wallet.autorenew =
      isRecord(body) && body.on === true && Boolean(wallet.paymentMethodId);
    await store.saveWallet(wallet);
    return c.json(await billingState(store, user));
  });

  // Уведомление ЮKassa. Телу не верим: статус перепроверяем запросом к API.
  app.post('/api/public/yookassa', async (c) => {
    const body = await deps.readBody(c).catch(() => undefined);
    const object =
      isRecord(body) && isRecord(body.object) ? body.object : undefined;
    const id = typeof object?.id === 'string' ? object.id : '';
    if (!id || id.length > 80) return c.json({ ok: true });
    await syncPayment(store, secret, id, deps.fetchImpl).catch(() => undefined);
    return c.json({ ok: true });
  });

  app.get('/api/admin/billing', async (c) => {
    await admin(c);
    return c.json(await publicBillingSettings(store, webhookUrl(c)));
  });

  app.put('/api/admin/billing', async (c) => {
    await admin(c);
    const body = await deps.readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    await saveBillingSettings(store, secret, body);
    return c.json(await publicBillingSettings(store, webhookUrl(c)));
  });

  app.get('/api/admin/billing/users/:id', async (c) => {
    await admin(c);
    const user = await store.getUser(c.req.param('id'));
    if (!user) return c.json({ error: 'Пользователь не найден' }, 404);
    return c.json(await billingState(store, user));
  });

  app.post('/api/admin/billing/users/:id/credit', async (c) => {
    await admin(c);
    const user = await store.getUser(c.req.param('id'));
    if (!user) return c.json({ error: 'Пользователь не найден' }, 404);
    const body = await deps.readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    if (body.resetTrial === true) {
      const wallet = await store.getWallet(user.id);
      wallet.trialUsedUsd = 0;
      await store.saveWallet(wallet);
    }
    if (body.amountRub !== undefined && Number(body.amountRub) !== 0)
      await manualCredit(
        store,
        user.id,
        Number(body.amountRub),
        typeof body.note === 'string' ? body.note.slice(0, 200) : '',
      );
    return c.json(await billingState(store, user));
  });
}
