import type { Context, Hono } from 'hono';
import type { TelegramBotState } from '@mayak/shared';
import type { AppConfig } from './config';
import { isValidCron } from './cron';
import type { Store, UserRecord } from './db';
import { HttpError, badRequest } from './errors';
import { decryptSecret, encryptSecret } from './github/secret';
import {
  deleteMailAccount,
  mailDigestKey,
  normalizeMailInput,
  readStoredMailAccount,
  saveMailAccount,
  testMailConnection,
} from './mail-account';
import type { McpManager } from './mcp/manager';
import { runRoutineNow } from './scheduler';
import {
  ensureDigestRoutine,
  findStarterAgent,
  seedStarterAgents,
} from './seed-agents';
import type { SkillLibrary } from './skills';
import { checkTelegramToken, sendTelegramTest } from './telegram-bots';
import type { TurnDeps } from './turn';
import { asString, isRecord } from './util';

/** Маршруты личных каналов: почта (IMAP) и Telegram-бот «Джарвиса». */
export function registerChannelRoutes(
  app: Hono,
  deps: {
    store: Store;
    config: AppConfig;
    actor: (c: Context) => Promise<UserRecord>;
    readBody: (c: Context) => Promise<unknown>;
    mcp: McpManager;
    skills: SkillLibrary;
    runtime: TurnDeps;
  },
): void {
  const { store, config } = deps;

  app.get('/api/mail', async (c) => {
    const user = await deps.actor(c);
    return c.json(await mailStatus(store, user.id));
  });

  app.put('/api/mail', async (c) => {
    const user = await deps.actor(c);
    const input = normalizeMailInput(await deps.readBody(c));
    const stored = await readStoredMailAccount(store, user.id);
    const password =
      input.password?.trim() ||
      (await storedPassword(stored, config.jwtSecret));
    if (!password) throw badRequest('Укажите пароль приложения');
    const check = await testMailConnection(input, password);
    if (!check.ok) {
      throw badRequest(
        check.error
          ? `Не удалось подключиться: ${check.error}`
          : 'Не удалось подключиться к почтовому серверу',
      );
    }
    await saveMailAccount(
      store,
      user.id,
      { ...input, password },
      config.jwtSecret,
    );
    // Подключённый ящик включает ежедневную выжимку (если владелец её не отключал).
    const routine = await ensureDigestRoutineFor(store, user);
    if (routine && !routine.enabled) {
      await store.updateRoutine(routine.id, { enabled: true });
    }
    return c.json({ ok: true, messages: check.messages });
  });

  app.post('/api/mail/test', async (c) => {
    const user = await deps.actor(c);
    const input = normalizeMailInput(await deps.readBody(c));
    const stored = await readStoredMailAccount(store, user.id);
    const password =
      input.password?.trim() ||
      (await storedPassword(stored, config.jwtSecret));
    if (!password)
      return c.json({ ok: false, error: 'Укажите пароль приложения' });
    return c.json(await testMailConnection(input, password));
  });

  app.delete('/api/mail', async (c) => {
    const user = await deps.actor(c);
    await deleteMailAccount(store, user.id);
    return c.json({ ok: true });
  });

  app.put('/api/mail/digest', async (c) => {
    const user = await deps.actor(c);
    const body = await deps.readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const cronRaw = body.cron === undefined ? '' : asString(body.cron).trim();
    if (cronRaw && !isValidCron(cronRaw)) {
      throw badRequest(
        'Время выжимки задано некорректно (ожидается cron из 5 полей)',
      );
    }
    const routine = await ensureDigestRoutineFor(store, user);
    if (!routine) throw badRequest('Почтовый агент не найден');
    await store.updateRoutine(routine.id, {
      ...(cronRaw ? { cron: cronRaw } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    });
    return c.json(await mailStatus(store, user.id));
  });

  app.post('/api/mail/digest', async (c) => {
    const user = await deps.actor(c);
    if (!(await readStoredMailAccount(store, user.id))) {
      throw badRequest('Сначала подключите почтовый ящик');
    }
    const routine = await ensureDigestRoutineFor(store, user);
    if (!routine) throw badRequest('Почтовый агент не найден');
    try {
      await runRoutineNow(
        {
          store,
          mcp: deps.mcp,
          skills: deps.skills,
          jwtSecret: config.jwtSecret,
        },
        routine.id,
      );
    } catch (error) {
      throw new HttpError(
        502,
        error instanceof Error
          ? `Не удалось сделать выжимку: ${error.message}`
          : 'Не удалось сделать выжимку',
      );
    }
    return c.json({ ok: true });
  });

  app.get('/api/telegram', async (c) => {
    const user = await deps.actor(c);
    return c.json(await telegramStatus(store, user));
  });

  app.put('/api/telegram', async (c) => {
    const user = await deps.actor(c);
    const body = await deps.readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const current = await store.getTelegramBotForUser(user.id);
    const token = body.token === undefined ? '' : asString(body.token).trim();
    const rawId =
      body.tgUserId === undefined ? '' : asString(body.tgUserId).trim();
    if (rawId && !/^\d{5,15}$/.test(rawId)) {
      throw badRequest('Telegram ID — это число (например 123456789)');
    }
    if (!current && !token)
      throw badRequest('Вставьте токен бота из @BotFather');
    let username = current?.username ?? '';
    let tokenEnc = current?.tokenEnc ?? '';
    if (token) {
      if (token.length < 20 || !token.includes(':')) {
        throw badRequest(
          'Это не похоже на токен бота. Скопируйте его из @BotFather',
        );
      }
      const check = await checkTelegramToken(token);
      if (!check.ok) {
        throw badRequest(
          check.error
            ? `Telegram не принял токен: ${check.error}`
            : 'Telegram не принял токен',
        );
      }
      username = check.username ?? '';
      tokenEnc = encryptSecret(token, config.jwtSecret);
    }
    const tgUserId = rawId || (current?.tgUserId ?? '');
    if (!tgUserId) throw badRequest('Укажите ваш Telegram ID (число)');
    // Джарвис должен существовать: досоздаём стартовых агентов при необходимости.
    await seedStarterAgents(store, user).catch(() => undefined);
    const agent = await findStarterAgent(store, user, 'jarvis');
    if (!agent) throw badRequest('Агент «Джарвис» не найден');
    await store.upsertTelegramBot({
      userId: user.id,
      agentId: agent.id,
      tokenEnc,
      tgUserId,
      username,
    });
    return c.json(await telegramStatus(store, user));
  });

  app.post('/api/telegram/test', async (c) => {
    const user = await deps.actor(c);
    const bot = await store.getTelegramBotForUser(user.id);
    if (!bot) throw badRequest('Сначала подключите бота');
    if (!bot.tgUserId) throw badRequest('Укажите ваш Telegram ID');
    let token: string;
    try {
      token = decryptSecret(bot.tokenEnc, config.jwtSecret);
    } catch {
      throw badRequest('Не удалось прочитать токен. Вставьте его заново');
    }
    return c.json(await sendTelegramTest(token, bot.tgUserId));
  });

  app.delete('/api/telegram', async (c) => {
    const user = await deps.actor(c);
    await store.deleteTelegramBot(user.id);
    return c.json({ ok: true });
  });
}

async function storedPassword(
  stored: Awaited<ReturnType<typeof readStoredMailAccount>>,
  jwtSecret: string,
): Promise<string> {
  if (!stored) return '';
  try {
    return decryptSecret(stored.passwordEnc, jwtSecret);
  } catch {
    return '';
  }
}

async function mailStatus(store: Store, userId: string) {
  const stored = await readStoredMailAccount(store, userId);
  const routineId = await store.getSetting(mailDigestKey(userId));
  let digest: {
    routineId: string;
    cron: string;
    enabled: boolean;
    prompt: string;
  } | null = null;
  if (routineId) {
    const routine = await store.getRoutine(routineId);
    if (routine) {
      digest = {
        routineId: routine.id,
        cron: routine.cron,
        enabled: routine.enabled,
        prompt: routine.prompt,
      };
    }
  }
  return {
    connected: Boolean(stored),
    host: stored?.host ?? '',
    port: stored?.port ?? 993,
    secure: stored?.secure ?? true,
    user: stored?.user ?? '',
    mailbox: stored?.mailbox ?? 'INBOX',
    hasPassword: Boolean(stored?.passwordEnc),
    digest,
  };
}

async function telegramStatus(
  store: Store,
  user: UserRecord,
): Promise<TelegramBotState> {
  const bot = await store.getTelegramBotForUser(user.id);
  const agent = bot
    ? await store.getAgent(bot.agentId)
    : await findStarterAgent(store, user, 'jarvis');
  return {
    connected: Boolean(bot),
    username: bot?.username ?? '',
    tgUserId: bot?.tgUserId ?? '',
    agentId: agent?.id ?? bot?.agentId ?? null,
    agentName: agent?.name ?? '',
  };
}

/** Находит (или создаёт) рутину выжимки; заодно доводит до неё ссылку в settings. */
async function ensureDigestRoutineFor(store: Store, user: UserRecord) {
  let agent = await findStarterAgent(store, user, 'mail-digest');
  if (!agent) {
    await seedStarterAgents(store, user).catch(() => undefined);
    agent = await findStarterAgent(store, user, 'mail-digest');
  }
  if (!agent) return undefined;
  return ensureDigestRoutine(store, user, agent);
}
