import { checkProviderModels, isChecking, readCaps } from './model-caps';
import { isKeylessUrl } from './free-llm';
import { readFreeCatalog, refreshFreeCatalog } from './free-llm';
import { assertPublicUrl } from './webtools';
import { keyBalance } from './balance';
import { DEFAULT_PRICES, isPrice, readPriceOverrides } from './pricing';
import { buildSpendReport } from './spend';
import fs from 'node:fs';
import path from 'node:path';
import {
  SECRET_MASK,
  type Attachment,
  type ClientEvent,
  type Locale,
  type McpServerConfigEntry,
  type McpServerInput,
  type McpServerPublic,
  type McpServersFile,
  type AgentInput,
  type ProjectInput,
  type ProviderInput,
  type RoutineInput,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODELS,
  type ProviderKind,
} from '@mayak/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  LOCAL_USER_ID,
  hashInviteToken,
  hashPassword,
  isPublicApi,
  isSharedCatalogWrite,
  newInviteToken,
  setSessionCookie,
  signSession,
  toPublicUser,
  clearSessionCookie,
  userFromRequest,
  verifyPassword,
} from './auth';
import type { AppConfig } from './config';
import { isValidCron } from './cron';
import { type McpRow, Store, type UserRecord, toPublicProvider } from './db';
import { HttpError, badRequest } from './errors';
import { registerExtraRoutes } from './extra';
import { registerGithubRoutes } from './github/routes';
import { McpManager } from './mcp/manager';
import { createClient, providerNeedsKey } from './providers/index';
import { discoverProvider } from './providers/discover';
import { runRoutineNow, startScheduler, triggerWebhook } from './scheduler';
import { SkillLibrary, seedSkills } from './skills';
import { AGENT_TEMPLATES } from './templates';
import { assertQuota, runTurn } from './turn';
import { asString, isRecord } from './util';
import { mailConfigured, resetEmail, sendMail } from './mail';

export interface AppHandle {
  app: Hono;
  runtime: import('./turn').TurnDeps;
  close: () => Promise<void>;
  startScheduler: () => () => void;
}

const KINDS: readonly ProviderKind[] = [
  'openai',
  'deepseek',
  'anthropic',
  'gemini',
  'mock',
];

export async function createApp(config: AppConfig): Promise<AppHandle> {
  const store = await Store.open({
    dataDir: config.dataDir,
    databaseUrl: config.databaseUrl,
  });
  const skills = new SkillLibrary(path.join(config.dataDir, 'skills'));
  const mcp = new McpManager();
  await seed(store, skills, config);
  await ensureDeepSeek(store);
  if (!config.authEnabled) await ensureLocalUser(store);

  for (const row of await store.listMcp()) {
    if (row.enabled) await mcp.connect(row);
  }

  const auth = {
    enabled: config.authEnabled,
    jwtSecret: config.jwtSecret,
    secureCookie: config.secureCookie,
  };
  if (auth.enabled && auth.jwtSecret === 'mayak-dev-secret-change-me') {
    console.warn(
      'MAYAK_AUTH включён с секретом по умолчанию. Задайте JWT_SECRET.',
    );
  }

  const app = new Hono();
  const actor = (c: Context) => userFromRequest(c, store, auth, LOCAL_USER_ID);
  const canUseAgent = async (user: UserRecord, agentId: string) => {
    if (user.role === 'admin') return true;
    const agent = await store.getAgent(agentId);
    if (!agent) return false;
    if (agent.ownerId) return agent.ownerId === user.id;
    const ids = await store.listUserAgentIds(user.id);
    return ids.includes(agentId);
  };
  /** Менять агента может админ или владелец личного агента. */
  const canEditAgent = (user: UserRecord, agent: { ownerId?: string | null }) =>
    user.role === 'admin' ||
    (Boolean(agent.ownerId) && agent.ownerId === user.id);
  /** Менеджер не подключает MCP и GitHub: это решает админ для общих агентов. */
  const limitForManager = (
    user: UserRecord,
    input: AgentInput & { name?: string },
  ) => {
    if (user.role === 'admin') return input;
    const { mcpServerIds: _mcp, githubRepos: _gh, ...rest } = input;
    return rest;
  };

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(
        { error: error.message },
        error.status as 400 | 401 | 403 | 404 | 429 | 500,
      );
    }
    console.error(error);
    return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
  });

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      name: 'mayak',
      version: '0.1.0',
      auth: config.authEnabled,
    }),
  );

  app.get('/api/auth/config', (c) => c.json({ required: config.authEnabled }));

  app.post('/api/auth/register', async (c) => {
    const body = await readBody(c);
    const parsed = parseCredentials(body, true);
    if (await store.getUserByEmail(parsed.email)) {
      throw badRequest('Пользователь с такой почтой уже есть');
    }
    const humans = (await store.listUsers()).filter(
      (item) => item.id !== LOCAL_USER_ID,
    );
    const first = humans.length === 0;
    const user = await store.insertUser({
      email: parsed.email,
      name: parsed.name,
      passwordHash: await hashPassword(parsed.password),
      role: first ? 'admin' : 'manager',
      status: first ? 'active' : 'pending',
      dailyRequestLimit: null,
    });
    if (first) await store.claimOrphans(user.id);
    if (user.status === 'active') {
      setSessionCookie(
        c,
        signSession(user.id, auth.jwtSecret),
        auth.secureCookie,
      );
    }
    return c.json(
      { user: toPublicUser(user, []), pending: user.status === 'pending' },
      201,
    );
  });

  app.post('/api/auth/login', async (c) => {
    const body = await readBody(c);
    const parsed = parseCredentials(body, false);
    const user = await store.getUserByEmail(parsed.email);
    const valid = user?.passwordHash
      ? await verifyPassword(parsed.password, user.passwordHash)
      : false;
    if (!user || !valid) throw new HttpError(401, 'Неверная почта или пароль');
    if (user.status === 'pending')
      throw new HttpError(403, 'Учётная запись ждёт подтверждения');
    if (user.status !== 'active')
      throw new HttpError(403, 'Учётная запись отключена');
    setSessionCookie(
      c,
      signSession(user.id, auth.jwtSecret),
      auth.secureCookie,
    );
    const agentIds = await store.listUserAgentIds(user.id);
    return c.json({ user: toPublicUser(user, agentIds) });
  });

  app.post('/api/auth/accept', async (c) => {
    const body = await readBody(c);
    if (!isRecord(body) || typeof body.token !== 'string')
      throw badRequest('Нужен токен приглашения');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) throw badRequest('Пароль не короче 8 символов');
    const user = await store.getUserByInviteToken(
      hashInviteToken(body.token.trim()),
    );
    if (!user || user.status === 'disabled')
      throw new HttpError(400, 'Приглашение недействительно');
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : user.name;
    const updated = await store.updateUser(user.id, {
      name,
      passwordHash: await hashPassword(password),
      status: 'active',
    });
    if (!updated) throw new HttpError(400, 'Приглашение недействительно');
    await store.setInviteToken(updated.id, null);
    setSessionCookie(
      c,
      signSession(updated.id, auth.jwtSecret),
      auth.secureCookie,
    );
    const agentIds = await store.listUserAgentIds(updated.id);
    return c.json({ user: toPublicUser(updated, agentIds) });
  });

  // --- Восстановление пароля ---
  const resetHits = new Map<string, number[]>();
  const tooMany = (key: string, limit: number) => {
    const now = Date.now();
    const hits = (resetHits.get(key) ?? []).filter(
      (at) => at > now - 3_600_000,
    );
    hits.push(now);
    resetHits.set(key, hits);
    if (resetHits.size > 5000) resetHits.clear();
    return hits.length > limit;
  };
  const siteUrl = (c: Context) => {
    if (config.publicUrl) return config.publicUrl.replace(/\/$/, '');
    const url = new URL(c.req.url);
    const proto =
      c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const host =
      c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
    return `${proto}://${host}`;
  };
  const issueResetLink = async (c: Context, userId: string) => {
    const token = newInviteToken();
    const expiresAt = await store.createPasswordReset(
      userId,
      hashInviteToken(token),
    );
    return { link: `${siteUrl(c)}/?reset=${token}`, expiresAt };
  };

  app.post('/api/auth/forgot', async (c) => {
    const body = await readBody(c);
    const email =
      isRecord(body) && typeof body.email === 'string'
        ? body.email.trim().toLowerCase()
        : '';
    const locale = isRecord(body) && body.locale === 'en' ? 'en' : 'ru';
    const ip =
      c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for') ?? 'local';
    if (tooMany(`ip:${ip}`, 10) || (email && tooMany(`email:${email}`, 3))) {
      throw new HttpError(429, 'Слишком много запросов. Попробуйте через час');
    }
    // Ответ одинаковый, есть такой пользователь или нет.
    const answer = { ok: true, mail: mailConfigured() };
    if (!email || !mailConfigured()) return c.json(answer);
    const user = await store.getUserByEmail(email);
    if (!user || user.status === 'disabled' || user.id === LOCAL_USER_ID)
      return c.json(answer);
    const { link } = await issueResetLink(c, user.id);
    try {
      await sendMail({ to: user.email, ...resetEmail(link, locale) });
    } catch (error) {
      console.error(
        'Письмо со сбросом пароля не отправлено:',
        error instanceof Error ? error.message : error,
      );
    }
    return c.json(answer);
  });

  app.post('/api/auth/reset', async (c) => {
    const body = await readBody(c);
    if (!isRecord(body) || typeof body.token !== 'string')
      throw badRequest('Нужна ссылка для сброса');
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) throw badRequest('Пароль не короче 8 символов');
    if (password.length > 200) throw badRequest('Пароль слишком длинный');
    const userId = await store.consumePasswordReset(
      hashInviteToken(body.token.trim()),
    );
    if (!userId)
      throw new HttpError(400, 'Ссылка недействительна или устарела');
    const user = await store.getUser(userId);
    if (!user || user.status === 'disabled')
      throw new HttpError(400, 'Ссылка недействительна или устарела');
    const updated = await store.updateUser(user.id, {
      passwordHash: await hashPassword(password),
      status:
        user.status === 'pending' && !user.passwordHash
          ? 'active'
          : user.status,
    });
    if (!updated)
      throw new HttpError(400, 'Ссылка недействительна или устарела');
    await store.setPasswordChanged(updated.id);
    await store.setInviteToken(updated.id, null);
    if (updated.status !== 'active') return c.json({ ok: true, pending: true });
    setSessionCookie(
      c,
      signSession(updated.id, auth.jwtSecret),
      auth.secureCookie,
    );
    const agentIds = await store.listUserAgentIds(updated.id);
    return c.json({ ok: true, user: toPublicUser(updated, agentIds) });
  });

  app.post('/api/admin/users/:id/reset-link', async (c) => {
    const admin = await actor(c);
    if (admin.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    const target = await store.getUser(c.req.param('id'));
    if (!target || target.id === LOCAL_USER_ID)
      return c.json({ error: 'Пользователь не найден' }, 404);
    return c.json(await issueResetLink(c, target.id));
  });

  app.post('/api/auth/logout', (c) => {
    clearSessionCookie(c, auth.secureCookie);
    return c.json({ ok: true });
  });

  app.use('/api/*', async (c, next) => {
    if (isPublicApi(c.req.path)) {
      await next();
      return;
    }
    const user = await actor(c);
    if (
      isSharedCatalogWrite(c.req.method, c.req.path) &&
      user.role !== 'admin'
    ) {
      throw new HttpError(403, 'Только для администратора');
    }
    await next();
  });

  const publishUser = async (user: UserRecord) =>
    toPublicUser(
      user,
      await store.listUserAgentIds(user.id),
      await store.listModelAccess(user.id),
    );

  const requireAllowedModel = async (
    user: UserRecord,
    providerId: string | null | undefined,
    model: string | null | undefined,
    explicitModel: boolean,
  ) => {
    const provider = providerId
      ? await store.getProvider(providerId)
      : undefined;
    if (!provider?.enabled) throw badRequest('Выберите включённую модель');
    if (explicitModel && model && !provider.models.includes(model)) {
      throw badRequest('У провайдера нет такой модели');
    }
    const resolved =
      model && provider.models.includes(model) ? model : provider.models[0];
    if (!resolved) throw badRequest('У провайдера не задана модель');
    const target = explicitModel && model ? model : resolved;
    if (!(await store.isModelAllowed(user, provider.id, target))) {
      throw new HttpError(403, 'Эта модель недоступна');
    }
    return { providerId: provider.id, model: resolved };
  };

  /** Чужой личный ключ нельзя выбрать никому, даже администратору. */
  const denyForeignProvider = async (
    user: UserRecord,
    providerId: string | null | undefined,
  ) => {
    if (!providerId) return;
    const provider = await store.getProvider(providerId);
    if (provider?.ownerUserId && provider.ownerUserId !== user.id)
      throw new HttpError(403, 'Эта модель недоступна');
  };

  app.get('/api/auth/me', async (c) => {
    const user = await actor(c);
    return c.json({ user: await publishUser(user) });
  });

  app.get('/api/admin/users', async (c) => {
    const user = await actor(c);
    if (user.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    const users = await store.listUsers();
    const result = [];
    for (const item of users) {
      result.push(await publishUser(item));
    }
    return c.json(result);
  });

  app.post('/api/admin/users/invite', async (c) => {
    const admin = await actor(c);
    if (admin.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const email = normalizeEmail(body.email);
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim()
        : (email.split('@')[0] ?? email);
    if (await store.getUserByEmail(email))
      throw badRequest('Пользователь с такой почтой уже есть');
    const agentIds = Array.isArray(body.agentIds)
      ? body.agentIds.filter((item): item is string => typeof item === 'string')
      : [];
    const limit = parseLimit(body.dailyRequestLimit);
    const created = await store.insertUser({
      email,
      name,
      passwordHash: '',
      role: 'manager',
      status: 'pending',
      dailyRequestLimit: limit,
    });
    await store.setUserAgents(created.id, agentIds);
    const token = newInviteToken();
    await store.setInviteToken(created.id, hashInviteToken(token));
    return c.json(
      { user: toPublicUser(created, agentIds), inviteToken: token },
      201,
    );
  });

  app.patch('/api/admin/users/:id', async (c) => {
    const admin = await actor(c);
    if (admin.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    const current = await store.getUser(c.req.param('id'));
    if (!current) return c.json({ error: 'Пользователь не найден' }, 404);
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const patch: Partial<
      Pick<
        UserRecord,
        'name' | 'status' | 'dailyRequestLimit' | 'modelsRestricted'
      >
    > = {};
    if (typeof body.name === 'string' && body.name.trim())
      patch.name = body.name.trim();
    if (
      body.status === 'active' ||
      body.status === 'pending' ||
      body.status === 'disabled'
    ) {
      if (current.id === admin.id && body.status !== 'active') {
        throw badRequest('Нельзя отключить свою учётную запись');
      }
      patch.status = body.status;
    }
    if ('dailyRequestLimit' in body)
      patch.dailyRequestLimit = parseLimit(body.dailyRequestLimit);
    if ('modelsRestricted' in body)
      patch.modelsRestricted = body.modelsRestricted === true;
    const updated = await store.updateUser(current.id, patch);
    if (!updated) return c.json({ error: 'Пользователь не найден' }, 404);
    if (Array.isArray(body.agentIds)) {
      const agentIds = body.agentIds.filter(
        (item): item is string => typeof item === 'string',
      );
      await store.setUserAgents(updated.id, agentIds);
    }
    if (Array.isArray(body.models)) {
      await store.setModelAccess(updated.id, parseModelRefs(body.models));
    }
    return c.json(await publishUser(updated));
  });

  app.get('/api/admin/usage', async (c) => {
    const admin = await actor(c);
    if (admin.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const summary = await store.usageSummary(since.toISOString());
    const byModel = await store.usageByModel(since.toISOString());
    const byUser = new Map(summary.map((row) => [row.userId, row.calls]));
    const users = await store.listUsers();
    const spend = await buildSpendReport(store, { period: 'day' });
    const usageRows = [];
    for (const item of users) {
      const tokens = await store.tokenSumSince(item.id, since.toISOString());
      usageRows.push({
        userId: item.id,
        email: item.email,
        name: item.name,
        calls: byUser.get(item.id) ?? 0,
        limit: item.dailyRequestLimit,
        tokens,
        costUsd:
          spend.users.find((row) => row.userId === item.id)?.costUsd ?? 0,
        models: byModel
          .filter((row) => row.userId === item.id)
          .map((row) => ({ model: row.model, calls: row.calls })),
      });
    }
    return c.json(usageRows);
  });

  // Расходы: админ видит всех, остальные — только себя.
  app.get('/api/usage/report', async (c) => {
    const user = await actor(c);
    const raw = c.req.query('period');
    const period = raw === 'week' || raw === 'month' ? raw : 'day';
    const all = user.role === 'admin' && c.req.query('scope') !== 'mine';
    return c.json(
      await buildSpendReport(store, {
        period,
        userId: all ? undefined : user.id,
      }),
    );
  });

  // Каталог бесплатных LLM API (awesome-free-llm-apis): видят все, обновляет админ.
  app.get('/api/free-providers', async (c) => {
    await actor(c);
    return c.json(await readFreeCatalog(store));
  });

  app.post('/api/admin/free-providers/refresh', async (c) => {
    const admin = await actor(c);
    if (admin.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    try {
      return c.json(await refreshFreeCatalog(store));
    } catch (error) {
      throw badRequest(
        error instanceof Error ? error.message : 'Не удалось обновить каталог',
      );
    }
  });

  app.get('/api/admin/usage/balances', async (c) => {
    const admin = await actor(c);
    if (admin.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    const providers = (await store.listProviders()).filter(
      (item) => item.kind !== 'mock' && !item.ownerUserId,
    );
    return c.json(await Promise.all(providers.map((item) => keyBalance(item))));
  });

  app.get('/api/admin/prices', async (c) => {
    const admin = await actor(c);
    if (admin.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    return c.json({
      defaults: DEFAULT_PRICES,
      overrides: await readPriceOverrides(store),
    });
  });

  app.put('/api/admin/prices', async (c) => {
    const admin = await actor(c);
    if (admin.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    const body = (await c.req.json().catch(() => ({}))) as {
      overrides?: unknown;
    };
    const next: Record<string, unknown> = {};
    if (body.overrides && typeof body.overrides === 'object')
      for (const [model, price] of Object.entries(body.overrides)) {
        const key = model.trim().toLowerCase().slice(0, 120);
        if (key && isPrice(price)) next[key] = price;
      }
    await store.setSetting('model_prices', JSON.stringify(next));
    return c.json({ defaults: DEFAULT_PRICES, overrides: next });
  });

  app.put('/api/admin/models/shared', async (c) => {
    const admin = await actor(c);
    if (admin.role !== 'admin')
      throw new HttpError(403, 'Только для администратора');
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const models = parseModelRefs(body.models).filter(
      (item) => item.providerId && item.model,
    );
    const known = await store.listProviders();
    const kept = models.filter((item) =>
      known.some(
        (provider) =>
          !provider.ownerUserId &&
          provider.id === item.providerId &&
          provider.models.includes(item.model),
      ),
    );
    await store.setModelAccess('', kept);
    return c.json({ models: kept });
  });

  /** Провайдеры, которые видит пользователь: общие + свои личные. Чужие личные скрыты. */
  const visibleProviders = async (user: UserRecord) =>
    (await store.listProviders()).filter(
      (row) => !row.ownerUserId || row.ownerUserId === user.id,
    );

  /** Провайдер, который пользователь может менять: админ — общие и свои, менеджер — только свои. */
  const editableProvider = async (user: UserRecord, id: string) => {
    const row = await store.getProvider(id);
    if (!row) throw new HttpError(404, 'Провайдер не найден');
    const mine = row.ownerUserId === user.id;
    if (row.ownerUserId ? !mine : user.role !== 'admin')
      throw new HttpError(403, 'Можно менять только свои модели');
    return row;
  };

  /** Свой адрес у менеджера — только публичный https (защита внутренней сети сервера). */
  const checkPersonalBaseUrl = async (user: UserRecord, baseUrl?: string) => {
    if (user.role === 'admin' || !baseUrl?.trim()) return;
    let url: URL;
    try {
      url = await assertPublicUrl(baseUrl.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw badRequest(
        /ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message)
          ? 'Не удалось найти адрес провайдера — проверьте базовый URL'
          : message || 'Некорректный адрес',
      );
    }
    if (url.protocol !== 'https:')
      throw badRequest('Адрес провайдера должен начинаться с https://');
  };

  app.get('/api/providers', async (c) => {
    const user = await actor(c);
    const rows = await visibleProviders(user);
    const capsMap = await readCaps(store);
    const shared = await store.listModelAccess('');
    const allowed =
      user.role === 'manager' ? await store.allowedModels(user) : null;
    const visible = rows
      .map((row) => {
        const owned = row.ownerUserId === user.id;
        const managerModels = row.ownerUserId
          ? []
          : shared
              .filter(
                (item) =>
                  item.providerId === row.id && row.models.includes(item.model),
              )
              .map((item) => item.model);
        const models =
          allowed && !owned
            ? row.models.filter((model) =>
                allowed.some(
                  (item) => item.providerId === row.id && item.model === model,
                ),
              )
            : row.models;
        return {
          ...toPublicProvider(row),
          // Менеджер не видит адрес общих провайдеров администратора.
          baseUrl: user.role === 'manager' && !owned ? '' : row.baseUrl,
          models,
          managerModels,
          owned,
          keyless: isKeylessUrl(row.baseUrl),
          caps: capsMap[row.id] ?? {},
          checking: isChecking(row.id),
        };
      })
      .filter(
        (row) =>
          row.owned ||
          user.role !== 'manager' ||
          (row.enabled && row.models.length > 0),
      );
    return c.json(visible);
  });

  // Определить провайдера по ключу или моделям и загрузить список моделей.
  app.post('/api/providers/discover', async (c) => {
    const user = await actor(c);
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const apiKey =
      typeof body.apiKey === 'string' && body.apiKey !== SECRET_MASK
        ? body.apiKey
        : undefined;
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : undefined;
    await checkPersonalBaseUrl(user, baseUrl);
    // Менеджер может подставить ключ только из своих провайдеров.
    const existing = (await visibleProviders(user)).filter(
      (row) => user.role === 'admin' || row.ownerUserId === user.id,
    );
    return c.json(
      await discoverProvider({
        apiKey,
        baseUrl,
        kind: isKind(body.kind) ? body.kind : undefined,
        models: Array.isArray(body.models)
          ? body.models.filter(
              (item): item is string => typeof item === 'string',
            )
          : undefined,
        currentId:
          typeof body.providerId === 'string' &&
          existing.some((row) => row.id === body.providerId)
            ? body.providerId
            : undefined,
        existing,
      }),
    );
  });

  /** Ключ, скопированный на сервере из другого провайдера (в браузер не попадает). */
  const borrowedKey = async (
    user: UserRecord,
    body: unknown,
  ): Promise<string | undefined> => {
    if (!isRecord(body) || typeof body.keyFromProviderId !== 'string')
      return undefined;
    const donor = await store.getProvider(body.keyFromProviderId);
    if (!donor) return undefined;
    const mayUse = donor.ownerUserId
      ? donor.ownerUserId === user.id
      : user.role === 'admin';
    return mayUse ? donor.apiKey || undefined : undefined;
  };

  app.post('/api/providers', async (c) => {
    const user = await actor(c);
    const raw = await readBody(c);
    const input = parseProviderInput(raw);
    if (user.role === 'manager' && input.kind === 'mock')
      throw badRequest('Демо-провайдер добавляет только администратор');
    await checkPersonalBaseUrl(user, input.baseUrl);
    if (input.apiKey === SECRET_MASK) input.apiKey = undefined;
    if (!input.apiKey) input.apiKey = await borrowedKey(user, raw);
    const row = await store.insertProvider({
      ...input,
      ownerUserId: user.role === 'admin' ? null : user.id,
    });
    if (!process.env.VITEST)
      void checkProviderModels(store, row, { gapMs: 3000 }).catch(
        () => undefined,
      );
    return c.json(
      { ...toPublicProvider(row), owned: Boolean(row.ownerUserId) },
      201,
    );
  });

  app.patch('/api/providers/:id', async (c) => {
    const user = await actor(c);
    const current = await editableProvider(user, c.req.param('id'));
    const body = await readBody(c);
    const record = isRecord(body) ? body : {};
    const input = parseProviderInput(
      {
        ...record,
        name: record.name ?? current.name,
        kind: record.kind ?? current.kind,
      },
      true,
    );
    if (current.ownerUserId) await checkPersonalBaseUrl(user, input.baseUrl);
    if (!input.apiKey || input.apiKey === SECRET_MASK) input.apiKey = undefined;
    if (!input.apiKey) input.apiKey = await borrowedKey(user, body);
    const row = await store.updateProvider(current.id, input);
    if (!row) return c.json({ error: 'Провайдер не найден' }, 404);
    if (!process.env.VITEST)
      void checkProviderModels(store, row, { gapMs: 3000 }).catch(
        () => undefined,
      );
    return c.json({
      ...toPublicProvider(row),
      owned: Boolean(row.ownerUserId),
    });
  });

  app.delete('/api/providers/:id', async (c) => {
    const user = await actor(c);
    const current = await editableProvider(user, c.req.param('id'));
    const ok = await store.deleteProvider(current.id);
    if (!ok) return c.json({ error: 'Провайдер не найден' }, 404);
    return c.json({ ok: true });
  });

  // Проверить все модели провайдера: отвечает ли, умеет ли инструменты (MCP).
  app.post('/api/providers/:id/check', async (c) => {
    const user = await actor(c);
    const provider = await editableProvider(user, c.req.param('id'));
    void checkProviderModels(store, provider, { gapMs: 3000 }).catch(
      () => undefined,
    );
    return c.json({ started: true }, 202);
  });

  app.post('/api/providers/:id/test', async (c) => {
    const user = await actor(c);
    const provider = await editableProvider(user, c.req.param('id'));
    if (providerNeedsKey(provider.kind, provider.baseUrl) && !provider.apiKey)
      return c.json({ error: 'Сначала сохраните API-ключ' }, 400);
    const model = provider.models[0];
    if (!model) return c.json({ error: 'Добавьте хотя бы одну модель' }, 400);
    let preview = '';
    try {
      for await (const event of createClient(provider).stream({
        model,
        messages: [
          { role: 'user', content: 'Reply with the single word: pong' },
        ],
        tools: [],
        signal: AbortSignal.timeout(30_000),
      })) {
        if (event.type === 'error')
          return c.json({ ok: false, error: event.message }, 502);
        if (event.type === 'text') preview += event.delta;
        if (preview.length > 180) break;
      }
    } catch (error) {
      return c.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : 'Ошибка запроса',
        },
        502,
      );
    }
    return c.json({ ok: true, preview: preview.slice(0, 180) });
  });

  app.get('/api/mcp', async (c) =>
    c.json((await store.listMcp()).map((row) => presentMcp(row, mcp))),
  );

  app.get('/api/mcp/config', async (c) =>
    c.json(toMcpFile(await store.listMcp())),
  );

  app.post('/api/mcp/import', async (c) => {
    const file = parseMcpFile(await readBody(c));
    for (const [name, entry] of Object.entries(file.mcpServers)) {
      const input = entryToInput(name, entry, await store.getMcpByName(name));
      const saved = await store.upsertMcp(input);
      if (saved.enabled) await mcp.connect(saved);
      else await mcp.disconnect(saved.id);
    }
    return c.json((await store.listMcp()).map((row) => presentMcp(row, mcp)));
  });

  app.post('/api/mcp', async (c) => {
    const input = parseMcpInput(await readBody(c));
    const saved = await store.upsertMcp(input);
    if (saved.enabled) await mcp.connect(saved);
    return c.json(presentMcp(saved, mcp), 201);
  });

  app.patch('/api/mcp/:id', async (c) => {
    const current = await store.getMcp(c.req.param('id'));
    if (!current) return c.json({ error: 'MCP-сервер не найден' }, 404);
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    if (typeof body.name === 'string' && body.name.trim() !== current.name) {
      throw badRequest(
        'Переименование MCP-сервера не поддерживается — удалите его и создайте заново.',
      );
    }
    const saved = await store.upsertMcp(mergeMcp(current, body));
    if (saved.enabled) await mcp.connect(saved);
    else await mcp.disconnect(saved.id);
    return c.json(presentMcp(saved, mcp));
  });

  app.delete('/api/mcp/:id', async (c) => {
    const current = await store.getMcp(c.req.param('id'));
    if (!current) return c.json({ error: 'MCP-сервер не найден' }, 404);
    await mcp.disconnect(current.id);
    await store.deleteMcp(current.id);
    return c.json({ ok: true });
  });

  app.get('/api/skills', (c) =>
    c.json({ directory: skills.directory, skills: skills.list() }),
  );

  app.get('/api/skills/:name', (c) => {
    const skill = skills.get(c.req.param('name'));
    if (!skill) return c.json({ error: 'Навык не найден' }, 404);
    return c.json(skill);
  });

  app.put('/api/skills/:name', async (c) => {
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const saved = skills.save({
      name: c.req.param('name'),
      description: asString(body.description),
      enabled: body.enabled !== false,
      body: asString(body.body),
    });
    return c.json(saved);
  });

  app.delete('/api/skills/:name', (c) => {
    const ok = skills.remove(c.req.param('name'));
    if (!ok) return c.json({ error: 'Навык не найден' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/agent-templates', (c) => c.json(AGENT_TEMPLATES));

  app.get('/api/agents', async (c) => {
    const user = await actor(c);
    return c.json(await store.listAgentsFor(user));
  });

  app.post('/api/agents', async (c) => {
    const user = await actor(c);
    const input = limitForManager(
      user,
      parseAgentInput(await readBody(c), false),
    );
    if (await store.findAgentByName(input.name ?? '')) {
      throw badRequest('Агент с таким именем уже есть');
    }
    if (user.role !== 'admin') {
      const own = (await store.listAgents()).filter(
        (agent) => agent.ownerId === user.id,
      );
      if (own.length >= 20) throw badRequest('Не больше 20 личных агентов');
    }
    let defaults = await defaultSelection(store);
    if (user.role !== 'admin' && input.model === undefined) {
      // Менеджеру — первая из моделей, которые ему открыл админ.
      const first = (await store.allowedModels(user))[0];
      if (!first)
        throw new HttpError(
          403,
          'Администратор ещё не открыл вам ни одной модели',
        );
      defaults = { providerId: first.providerId, model: first.model };
    }
    const providerId =
      input.providerId === undefined ? defaults.providerId : input.providerId;
    const model = input.model === undefined ? defaults.model : input.model;
    await denyForeignProvider(user, providerId);
    if (user.role !== 'admin' && providerId && model) {
      await requireAllowedModel(
        user,
        providerId,
        model,
        input.model !== undefined,
      );
    }
    return c.json(
      await store.insertAgent({
        ...input,
        name: input.name ?? 'Агент',
        providerId,
        model,
        // Агент админа — общий; агент менеджера — личный.
        ownerId: user.role === 'admin' ? null : user.id,
      }),
      201,
    );
  });

  app.get('/api/agents/:id', async (c) => {
    const user = await actor(c);
    const agent = await store.getAgent(c.req.param('id'));
    if (!agent || !(await canUseAgent(user, agent.id))) {
      return c.json({ error: 'Агент не найден' }, 404);
    }
    return c.json(agent);
  });

  app.patch('/api/agents/:id', async (c) => {
    const user = await actor(c);
    const current = await store.getAgent(c.req.param('id'));
    if (!current || !(await canUseAgent(user, current.id)))
      return c.json({ error: 'Агент не найден' }, 404);
    if (!canEditAgent(user, current))
      throw new HttpError(403, 'Общего агента настраивает администратор');
    const raw = await readBody(c);
    const input = limitForManager(user, parseAgentInput(raw, true));
    await denyForeignProvider(user, input.providerId);
    if (user.role !== 'admin' && (input.providerId || input.model)) {
      await requireAllowedModel(
        user,
        input.providerId ?? current.providerId,
        input.model ?? current.model,
        input.model !== undefined && input.model !== null,
      );
    }
    // Админ может сделать личного агента менеджера общим для команды.
    if (
      user.role === 'admin' &&
      isRecord(raw) &&
      raw.shared === true &&
      current.ownerId
    ) {
      const agentProvider = current.providerId
        ? await store.getProvider(current.providerId)
        : undefined;
      if (agentProvider?.ownerUserId)
        throw badRequest(
          'Агент работает на личном ключе менеджера — выберите ему общую модель, потом делайте общим',
        );
      const owner = current.ownerId;
      await store.setAgentOwner(current.id, null);
      const ids = await store.listUserAgentIds(owner);
      if (!ids.includes(current.id))
        await store.setUserAgents(owner, [...ids, current.id]);
    }
    if (input.name && input.name.toLowerCase() !== current.name.toLowerCase()) {
      const taken = await store.findAgentByName(input.name);
      if (taken && taken.id !== current.id)
        throw badRequest('Агент с таким именем уже есть');
    }
    const updated = await store.updateAgent(current.id, input);
    return c.json(updated);
  });

  app.delete('/api/agents/:id', async (c) => {
    const user = await actor(c);
    const target = await store.getAgent(c.req.param('id'));
    if (!target || !(await canUseAgent(user, target.id)))
      return c.json({ error: 'Агент не найден' }, 404);
    if (!canEditAgent(user, target))
      throw new HttpError(403, 'Общего агента удаляет администратор');
    if ((await store.listAgents()).length <= 1) {
      return c.json({ error: 'Нельзя удалить последнего агента' }, 400);
    }
    const ok = await store.deleteAgent(c.req.param('id'));
    if (!ok) return c.json({ error: 'Агент не найден' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/agents/:id/memory', async (c) => {
    const user = await actor(c);
    if (!(await canUseAgent(user, c.req.param('id')))) {
      return c.json({ error: 'Агент не найден' }, 404);
    }
    return c.json(await store.listMemory(user.id, c.req.param('id')));
  });

  app.put('/api/agents/:id/memory/:key', async (c) => {
    const user = await actor(c);
    if (!(await canUseAgent(user, c.req.param('id')))) {
      return c.json({ error: 'Агент не найден' }, 404);
    }
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    return c.json(
      await store.writeMemory(
        user.id,
        c.req.param('id'),
        decodeURIComponent(c.req.param('key')),
        asString(body.content),
      ),
    );
  });

  app.delete('/api/agents/:id/memory/:key', async (c) => {
    const user = await actor(c);
    const ok = await store.deleteMemory(
      user.id,
      c.req.param('id'),
      decodeURIComponent(c.req.param('key')),
    );
    if (!ok) return c.json({ error: 'Заметка не найдена' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/hooks/:token', async (c) => {
    const extra = await c.req.text().catch(() => '');
    const ok = await triggerWebhook(
      { store, mcp, skills, jwtSecret: config.jwtSecret },
      c.req.param('token'),
      extra,
    );
    if (!ok) return c.json({ error: 'Вебхук не найден' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/agents/:id/routines/:routineId/runs', async (c) => {
    const user = await actor(c);
    const routine = await store.getRoutine(c.req.param('routineId'));
    if (
      !routine ||
      routine.userId !== user.id ||
      routine.agentId !== c.req.param('id')
    ) {
      return c.json({ error: 'Расписание не найдено' }, 404);
    }
    return c.json(await store.listRoutineRuns(routine.id));
  });

  app.get('/api/agents/:id/routines', async (c) => {
    const user = await actor(c);
    if (!(await canUseAgent(user, c.req.param('id')))) {
      return c.json({ error: 'Агент не найден' }, 404);
    }
    return c.json(await store.listRoutines(user.id, c.req.param('id')));
  });

  app.post('/api/agents/:id/routines', async (c) => {
    const user = await actor(c);
    if (!(await canUseAgent(user, c.req.param('id')))) {
      return c.json({ error: 'Агент не найден' }, 404);
    }
    const input = parseRoutineInput(await readBody(c), false);
    if (!input.name || !input.prompt) {
      throw badRequest('Укажите название и промпт');
    }
    return c.json(
      await store.insertRoutine(user.id, c.req.param('id'), {
        name: input.name,
        cron: input.cron ?? '',
        prompt: input.prompt,
        enabled: input.enabled,
      }),
      201,
    );
  });

  app.patch('/api/agents/:id/routines/:routineId', async (c) => {
    const user = await actor(c);
    const current = await store.getRoutine(c.req.param('routineId'));
    if (
      !current ||
      current.agentId !== c.req.param('id') ||
      current.userId !== user.id
    ) {
      return c.json({ error: 'Расписание не найдено' }, 404);
    }
    const input = parseRoutineInput(await readBody(c), true);
    return c.json(await store.updateRoutine(current.id, input));
  });

  app.delete('/api/agents/:id/routines/:routineId', async (c) => {
    const user = await actor(c);
    const current = await store.getRoutine(c.req.param('routineId'));
    if (
      !current ||
      current.agentId !== c.req.param('id') ||
      current.userId !== user.id
    ) {
      return c.json({ error: 'Расписание не найдено' }, 404);
    }
    await store.deleteRoutine(current.id);
    return c.json({ ok: true });
  });

  app.post('/api/agents/:id/routines/:routineId/run', async (c) => {
    const user = await actor(c);
    const current = await store.getRoutine(c.req.param('routineId'));
    if (
      !current ||
      current.agentId !== c.req.param('id') ||
      current.userId !== user.id
    ) {
      return c.json({ error: 'Расписание не найдено' }, 404);
    }
    await runRoutineNow({ store, mcp, skills }, current.id);
    return c.json({ ok: true });
  });

  app.get('/api/conversations', async (c) => {
    const user = await actor(c);
    const agentId = c.req.query('agentId') || undefined;
    const projectId = c.req.query('projectId') || undefined;
    if (projectId) {
      if (!(await store.getProject(projectId, user.id))) return c.json([]);
      return c.json(
        await store.listConversations(user.id, undefined, projectId),
      );
    }
    if (agentId && !(await canUseAgent(user, agentId))) return c.json([]);
    return c.json(await store.listConversations(user.id, agentId));
  });

  app.post('/api/conversations', async (c) => {
    const body = await readBody(c).catch(() => ({}));
    const record = isRecord(body) ? body : {};
    const locale: Locale = record.locale === 'en' ? 'en' : 'ru';
    const requestedAgent =
      typeof record.agentId === 'string'
        ? record.agentId
        : (await store.listAgents())[0]?.id;
    const user = await actor(c);
    const agent = requestedAgent
      ? await store.getAgent(requestedAgent)
      : undefined;
    if (!agent || !(await canUseAgent(user, agent.id)))
      throw badRequest('Агент не найден');
    const defaults = await defaultSelection(store);
    const providerId =
      typeof record.providerId === 'string'
        ? record.providerId
        : (agent.providerId ?? defaults.providerId);
    const model =
      typeof record.model === 'string'
        ? record.model
        : (agent.model ?? defaults.model);
    await denyForeignProvider(user, providerId);
    if (user.role === 'manager' && providerId && model) {
      await requireAllowedModel(
        user,
        providerId,
        model,
        typeof record.model === 'string',
      );
    }
    let projectId: string | null = null;
    if (typeof record.projectId === 'string' && record.projectId) {
      if (!(await store.getProject(record.projectId, user.id)))
        throw badRequest('Проект не найден');
      projectId = record.projectId;
    }
    const created = await store.insertConversation({
      title: locale === 'en' ? 'New chat' : 'Новый чат',
      agentId: agent.id,
      userId: user.id,
      providerId,
      model,
      projectId,
    });
    return c.json(created, 201);
  });

  app.get('/api/conversations/:id', async (c) => {
    const user = await actor(c);
    const conversation = await store.getConversation(
      c.req.param('id'),
      user.id,
    );
    if (!conversation) return c.json({ error: 'Чат не найден' }, 404);
    return c.json({
      conversation,
      messages: await store.listMessages(conversation.id),
    });
  });

  app.patch('/api/conversations/:id', async (c) => {
    const user = await actor(c);
    const current = await store.getConversation(c.req.param('id'), user.id);
    if (!current) return c.json({ error: 'Чат не найден' }, 404);
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const title =
      typeof body.title === 'string'
        ? body.title.trim().slice(0, 120)
        : undefined;
    const providerId =
      typeof body.providerId === 'string' ? body.providerId : undefined;
    const model = typeof body.model === 'string' ? body.model : undefined;
    await denyForeignProvider(user, providerId);
    if (
      user.role === 'manager' &&
      (providerId !== undefined || model !== undefined)
    ) {
      await requireAllowedModel(
        user,
        providerId ?? current.providerId,
        model ?? current.model,
        model !== undefined,
      );
    }
    let projectId: string | null | undefined;
    if (body.projectId === null) projectId = null;
    else if (typeof body.projectId === 'string') {
      if (!(await store.getProject(body.projectId, user.id)))
        throw badRequest('Проект не найден');
      projectId = body.projectId;
    }
    const updated = await store.updateConversation(current.id, {
      title: title || undefined,
      providerId,
      model,
      projectId,
    });
    return c.json(updated);
  });

  // ---------- Проекты (клиент, сделка, задача) ----------
  const parseProject = (body: unknown): ProjectInput => {
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    return {
      name: typeof body.name === 'string' ? body.name : undefined,
      client: typeof body.client === 'string' ? body.client : undefined,
      instructions:
        typeof body.instructions === 'string' ? body.instructions : undefined,
      archived: typeof body.archived === 'boolean' ? body.archived : undefined,
    };
  };

  app.get('/api/projects', async (c) => {
    const user = await actor(c);
    return c.json(await store.listProjects(user.id));
  });

  app.post('/api/projects', async (c) => {
    const user = await actor(c);
    const input = parseProject(await readBody(c));
    if (!input.name?.trim()) throw badRequest('Укажите название проекта');
    if ((await store.listProjects(user.id)).length >= 200)
      throw badRequest('Слишком много проектов');
    return c.json(
      await store.insertProject(user.id, { ...input, name: input.name }),
      201,
    );
  });

  app.patch('/api/projects/:id', async (c) => {
    const user = await actor(c);
    if (!(await store.getProject(c.req.param('id'), user.id)))
      return c.json({ error: 'Проект не найден' }, 404);
    return c.json(
      await store.updateProject(
        c.req.param('id'),
        parseProject(await readBody(c)),
      ),
    );
  });

  app.delete('/api/projects/:id', async (c) => {
    const user = await actor(c);
    if (!(await store.getProject(c.req.param('id'), user.id)))
      return c.json({ error: 'Проект не найден' }, 404);
    await store.deleteProject(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.delete('/api/conversations/:id', async (c) => {
    const user = await actor(c);
    const current = await store.getConversation(c.req.param('id'), user.id);
    const ok = current ? await store.deleteConversation(current.id) : false;
    if (!ok) return c.json({ error: 'Чат не найден' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/conversations/:id/messages', async (c) => {
    const user = await actor(c);
    const conversation = await store.getConversation(
      c.req.param('id'),
      user.id,
    );
    if (!conversation) {
      return c.json({ error: 'Чат не найден' }, 404);
    }
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Пустое сообщение');
    const attachments: Attachment[] = [];
    if (Array.isArray(body.attachments)) {
      for (const raw of body.attachments.slice(0, 10)) {
        const id =
          typeof raw === 'string' ? raw : isRecord(raw) ? raw.id : undefined;
        if (typeof id !== 'string') continue;
        const file = await store.getUpload(id, user.id);
        if (!file) throw badRequest('Вложение не найдено');
        attachments.push({ id: file.id, name: file.name, mime: file.mime });
      }
    }
    const typed = typeof body.content === 'string' ? body.content.trim() : '';
    if (!typed && attachments.length === 0)
      throw badRequest('Пустое сообщение');
    const content =
      typed ||
      (body.locale === 'en' ? 'See the attached files.' : 'Посмотри вложения.');
    if (content.length > 32_000) throw badRequest('Сообщение слишком длинное');
    await assertQuota(store, user);
    const agent = conversation.agentId
      ? await store.getAgent(conversation.agentId)
      : undefined;
    const explicitModel = typeof body.model === 'string';
    const selection = await requireAllowedModel(
      user,
      typeof body.providerId === 'string'
        ? body.providerId
        : (conversation.providerId ?? agent?.providerId),
      explicitModel && typeof body.model === 'string'
        ? body.model
        : (conversation.model ?? agent?.model),
      explicitModel,
    );
    const locale: Locale = body.locale === 'en' ? 'en' : 'ru';
    return streamSSE(c, async (stream) => {
      const write = async (event: ClientEvent) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };
      try {
        await runTurn(
          { store, mcp, skills, jwtSecret: config.jwtSecret },
          {
            conversationId: c.req.param('id'),
            content,
            attachments,
            locale,
            userId: user.id,
            providerId: selection.providerId,
            model: selection.model,
            signal: c.req.raw.signal,
            onEvent: write,
          },
        );
        await write({ type: 'done' });
      } catch (error) {
        if (isAbort(error)) return;
        const message =
          error instanceof Error ? error.message : 'Ошибка агента';
        await write({ type: 'error', message }).catch(() => undefined);
      }
    });
  });

  const runtime = { store, mcp, skills, jwtSecret: config.jwtSecret };
  registerGithubRoutes(app, {
    store,
    mcp,
    skills,
    config,
    actor,
    readBody,
    present: (row) => presentMcp(row, mcp),
  });
  registerExtraRoutes(app, {
    store,
    mcp,
    config,
    actor,
    readBody,
    runtime,
  });

  if (config.staticDir) {
    const root = path.resolve(config.staticDir);
    app.get('*', (c) => serveSpa(c, root));
  }

  app.notFound((c) => c.json({ error: 'Не найдено' }, 404));

  return {
    app,
    runtime,
    startScheduler: () => startScheduler(runtime),
    close: async () => {
      await mcp.disconnectAll();
      await store.close();
    },
  };
}

async function seed(
  store: Store,
  skills: SkillLibrary,
  config: AppConfig,
): Promise<void> {
  if (!(await store.getSetting('seeded'))) {
    if ((await store.listProviders()).length === 0) {
      await store.insertProvider({
        name: 'Демо',
        kind: 'mock',
        models: ['mock'],
        enabled: true,
        baseUrl: '',
      });
      const baseUrl = process.env.MAYAK_OPENAI_BASE_URL;
      const apiKey = process.env.MAYAK_OPENAI_API_KEY;
      const model = process.env.MAYAK_OPENAI_MODEL;
      if (baseUrl && apiKey && model) {
        await store.insertProvider({
          name: process.env.MAYAK_OPENAI_NAME || 'OpenAI-compatible',
          kind: 'openai',
          baseUrl,
          apiKey,
          models: [model],
          enabled: true,
        });
      }
    }
    if (
      (await store.listMcp()).length === 0 &&
      fs.existsSync(config.demoServerPath)
    ) {
      await store.upsertMcp({
        name: 'demo',
        transport: 'stdio',
        command: process.execPath,
        args: [config.demoServerPath],
        enabled: false,
      });
    }
    await store.setSetting('seeded', '1');
  }
  seedSkills(skills.directory, config.examplesSkillsDir);
  await ensureDefaultAgent(store, skills);
}

async function ensureLocalUser(store: Store): Promise<void> {
  if (!(await store.getUser(LOCAL_USER_ID))) {
    await store.insertUser({
      id: LOCAL_USER_ID,
      email: 'local@localhost',
      name: 'Локальный',
      passwordHash: '',
      role: 'admin',
      status: 'active',
      dailyRequestLimit: null,
    });
  }
  await store.claimOrphans(LOCAL_USER_ID);
}

async function ensureDefaultAgent(
  store: Store,
  skills: SkillLibrary,
): Promise<void> {
  if ((await store.listAgents()).length === 0) {
    const defaults = await defaultSelection(store);
    await store.insertAgent({
      name: 'QASTOM AGENT',
      emoji: '🤖',
      description: 'Основной ассистент команды',
      systemPrompt:
        'Ты — QASTOM AGENT, ИИ-ассистент команды QASTOM. Отвечай на языке пользователя, коротко и по делу.',
      providerId: defaults.providerId,
      model: defaults.model,
      mcpServerIds: (await store.listMcp()).map((item) => item.id),
      skillNames: skills.listEnabled().map((item) => item.name),
    });
  }
  const first = (await store.listAgents())[0];
  if (first) await store.assignOrphanConversations(first.id);
}

async function ensureDeepSeek(store: Store): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return;
  const existing = (await store.listProviders()).find(
    (item) => item.kind === 'deepseek',
  );
  if (existing) {
    if (!existing.apiKey) await store.updateProvider(existing.id, { apiKey });
    return;
  }
  const created = await store.insertProvider({
    name: 'DeepSeek',
    kind: 'deepseek',
    baseUrl: DEEPSEEK_BASE_URL,
    apiKey,
    models: [...DEEPSEEK_MODELS],
    enabled: true,
  });
  const agent = (await store.listAgents())[0];
  if (agent) {
    await store.updateAgent(agent.id, {
      providerId: created.id,
      model: 'deepseek-chat',
    });
  }
}

async function defaultSelection(store: Store): Promise<{
  providerId: string | null;
  model: string | null;
}> {
  const enabled = (await store.listProviders()).filter(
    (item) => item.enabled && item.models.length > 0,
  );
  const provider =
    enabled.find((item) => item.kind === 'deepseek') ?? enabled[0];
  if (!provider) return { providerId: null, model: null };
  const model = provider.models.includes('deepseek-chat')
    ? 'deepseek-chat'
    : provider.models[0];
  return { providerId: provider.id, model: model ?? null };
}

function presentMcp(row: McpRow, mcp: McpManager): McpServerPublic {
  const live = row.enabled
    ? mcp.snapshot(row.id)
    : { status: 'disconnected' as const, tools: [], error: undefined };
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    enabled: row.enabled,
    hasEnv: Object.keys(row.env).length > 0,
    hasHeaders: Object.keys(row.headers).length > 0,
    status: live.status,
    error: live.error,
    tools: live.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  };
}

function toMcpFile(rows: McpRow[]): McpServersFile {
  const mcpServers: McpServersFile['mcpServers'] = {};
  for (const row of rows) {
    const entry: McpServerConfigEntry = { enabled: row.enabled };
    if (row.transport === 'http') {
      entry.url = row.url;
      if (Object.keys(row.headers).length > 0) {
        entry.headers = Object.fromEntries(
          Object.keys(row.headers).map((key) => [key, SECRET_MASK]),
        );
      }
    } else {
      entry.command = row.command;
      entry.args = row.args;
      if (Object.keys(row.env).length > 0) {
        entry.env = Object.fromEntries(
          Object.keys(row.env).map((key) => [key, SECRET_MASK]),
        );
      }
    }
    mcpServers[row.name] = entry;
  }
  return { mcpServers };
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw badRequest('Укажите почту');
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw badRequest('Некорректная почта');
  return email;
}

function parseModelRefs(
  value: unknown,
): { providerId: string; model: string }[] {
  if (!Array.isArray(value)) return [];
  const refs: { providerId: string; model: string }[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.providerId !== 'string' || typeof item.model !== 'string')
      continue;
    const providerId = item.providerId.trim();
    const model = item.model.trim();
    if (providerId && model) refs.push({ providerId, model });
  }
  return refs;
}

function parseLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const limit = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(limit) || limit < 0)
    throw badRequest('Лимит — целое число или пусто');
  return limit;
}

function parseCredentials(
  body: unknown,
  named: boolean,
): { email: string; password: string; name: string } {
  if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 8) throw badRequest('Пароль не короче 8 символов');
  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : named
        ? (email.split('@')[0] ?? email)
        : '';
  return { email, password, name };
}

async function readBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest('Некорректный JSON');
  }
}

function parseAgentInput(
  body: unknown,
  partial: boolean,
): AgentInput & { name?: string } {
  if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
  const name = body.name === undefined ? undefined : asString(body.name).trim();
  if (!partial && !name) throw badRequest('Укажите имя агента');
  if (name !== undefined && !name) throw badRequest('Укажите имя агента');
  if (name && name.length > 80) throw badRequest('Имя агента слишком длинное');
  const emoji =
    body.emoji === undefined
      ? undefined
      : asString(body.emoji).trim().slice(0, 8);
  const description =
    body.description === undefined
      ? undefined
      : asString(body.description).trim();
  const systemPrompt =
    body.systemPrompt === undefined ? undefined : asString(body.systemPrompt);
  if (systemPrompt && systemPrompt.length > 20_000)
    throw badRequest('Системный промпт слишком длинный');
  const mcpServerIds =
    body.mcpServerIds === undefined ? undefined : stringList(body.mcpServerIds);
  const skillNames =
    body.skillNames === undefined ? undefined : stringList(body.skillNames);
  const githubRepos =
    body.githubRepos === undefined
      ? undefined
      : stringList(body.githubRepos)
          .map((item) => item.trim())
          .filter((item) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item))
          .slice(0, 30);
  return {
    name,
    emoji,
    description,
    systemPrompt,
    providerId:
      body.providerId === null
        ? null
        : typeof body.providerId === 'string'
          ? body.providerId
          : undefined,
    model:
      body.model === null
        ? null
        : typeof body.model === 'string'
          ? body.model
          : undefined,
    mcpServerIds,
    skillNames,
    githubRepos,
  };
}

function parseRoutineInput(body: unknown, partial: boolean): RoutineInput {
  if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
  const name = body.name === undefined ? undefined : asString(body.name).trim();
  const cron = body.cron === undefined ? undefined : asString(body.cron).trim();
  const prompt = body.prompt === undefined ? undefined : asString(body.prompt);
  if (!partial || body.name !== undefined) {
    if (!name) throw badRequest('Укажите название расписания');
  }
  if (cron && !isValidCron(cron)) {
    throw badRequest(
      'Нужно пять полей cron: минута час день месяц день-недели. Пустой cron — только вебхук.',
    );
  }
  if (!partial || body.prompt !== undefined) {
    if (!prompt?.trim()) throw badRequest('Укажите промпт расписания');
  }
  if (prompt && prompt.length > 8_000)
    throw badRequest('Промпт расписания слишком длинный');
  return {
    name,
    cron,
    prompt,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) throw badRequest('Ожидался список строк');
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseProviderInput(body: unknown, partial = false): ProviderInput {
  if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
  const kind = body.kind;
  if (!partial || kind !== undefined) {
    if (!isKind(kind))
      throw badRequest(
        'Тип провайдера: openai, deepseek, anthropic, gemini или mock',
      );
  }
  const name = asString(body.name).trim();
  if ((!partial || body.name !== undefined) && !name)
    throw badRequest('Укажите название провайдера');
  let models: string[] | undefined;
  if (Array.isArray(body.models))
    models = body.models.filter(
      (item): item is string => typeof item === 'string',
    );
  else if (typeof body.models === 'string') models = body.models.split(/[\n,]/);
  return {
    name: name || 'Провайдер',
    kind: isKind(kind) ? kind : 'openai',
    baseUrl: body.baseUrl === undefined ? undefined : asString(body.baseUrl),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    models,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  };
}

function isKind(value: unknown): value is ProviderKind {
  return (
    typeof value === 'string' && (KINDS as readonly string[]).includes(value)
  );
}

function parseMcpInput(body: unknown): McpServerInput {
  if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
  return entryToInput(asString(body.name), {
    command: asString(body.command) || undefined,
    args: Array.isArray(body.args)
      ? body.args.filter((item): item is string => typeof item === 'string')
      : undefined,
    env: isStringRecord(body.env) ? body.env : undefined,
    url: asString(body.url) || undefined,
    headers: isStringRecord(body.headers) ? body.headers : undefined,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  });
}

function parseMcpFile(body: unknown): McpServersFile {
  if (!isRecord(body) || !isRecord(body.mcpServers))
    throw badRequest('Ожидался объект { "mcpServers": { ... } }');
  const mcpServers: McpServersFile['mcpServers'] = {};
  for (const [name, entry] of Object.entries(body.mcpServers)) {
    if (!isRecord(entry)) throw badRequest(`Сервер «${name}»: ожидался объект`);
    mcpServers[name] = {
      command: typeof entry.command === 'string' ? entry.command : undefined,
      args: Array.isArray(entry.args)
        ? entry.args.filter((item): item is string => typeof item === 'string')
        : undefined,
      env: isStringRecord(entry.env) ? entry.env : undefined,
      url: typeof entry.url === 'string' ? entry.url : undefined,
      headers: isStringRecord(entry.headers) ? entry.headers : undefined,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
    };
  }
  return { mcpServers };
}

function entryToInput(
  name: string,
  entry: McpServerConfigEntry,
  existing?: McpRow,
): McpServerInput {
  const cleanName = name.trim();
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(cleanName)) {
    throw badRequest(
      `Имя MCP-сервера «${cleanName}» должно содержать латиницу, цифры, точку, «-» или «_».`,
    );
  }
  const transport = entry.url ? 'http' : 'stdio';
  if (transport === 'http') {
    try {
      const url = new URL(entry.url ?? '');
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('protocol');
    } catch {
      throw badRequest(`Сервер «${cleanName}»: нужен http(s) URL`);
    }
  } else if (!entry.command?.trim()) {
    throw badRequest(`Сервер «${cleanName}»: укажите command или url`);
  }
  return {
    name: cleanName,
    transport,
    command: entry.command?.trim() ?? '',
    args: entry.args ?? [],
    env: entry.env
      ? resolveSecrets(entry.env, existing?.env ?? {})
      : (existing?.env ?? {}),
    url: entry.url?.trim() ?? '',
    headers: entry.headers
      ? resolveSecrets(entry.headers, existing?.headers ?? {})
      : (existing?.headers ?? {}),
    enabled: entry.enabled ?? existing?.enabled ?? true,
  };
}

function mergeMcp(
  current: McpRow,
  body: Record<string, unknown>,
): McpServerInput {
  const entry: McpServerConfigEntry = {
    command: typeof body.command === 'string' ? body.command : current.command,
    args: Array.isArray(body.args)
      ? body.args.filter((item): item is string => typeof item === 'string')
      : current.args,
    url: typeof body.url === 'string' ? body.url : current.url,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    env: isStringRecord(body.env) ? body.env : undefined,
    headers: isStringRecord(body.headers) ? body.headers : undefined,
  };
  if (typeof body.transport === 'string') {
    if (body.transport === 'http' && !entry.url)
      throw badRequest('Для HTTP-транспорта нужен url');
    if (body.transport === 'stdio') entry.url = undefined;
  }
  const name = typeof body.name === 'string' ? body.name : current.name;
  return entryToInput(name, entry, current);
}

function resolveSecrets(
  incoming: Record<string, string>,
  previous: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === SECRET_MASK && previous[key]) out[key] = previous[key];
    else if (value !== SECRET_MASK) out[key] = value;
  }
  return out;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'Запрос отменён')
  );
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serveSpa(c: Context, root: string) {
  const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(
    /^\/+/,
    '',
  );
  if (rel.includes('\0')) return c.notFound();
  const target = path.resolve(root, rel);
  const inside = target === root || target.startsWith(`${root}${path.sep}`);
  const file =
    inside && rel && fs.existsSync(target) && fs.statSync(target).isFile()
      ? target
      : path.join(root, 'index.html');
  if (!file.startsWith(root) || !fs.existsSync(file)) return c.notFound();
  const type =
    MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  return c.body(new Uint8Array(fs.readFileSync(file)), 200, {
    'Content-Type': type,
  });
}
