import net from 'node:net';
import path from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig, repoRoot } from './config';
import { loadDotEnv } from './env';
import { notifyTelegram, startTelegram } from './telegram';
import { notifyUserTelegram, startTelegramBots } from './telegram-bots';
import { readSession } from './auth';
import { getRunnerServe, previewRunnerHost } from './preview-serve';

loadDotEnv(path.join(repoRoot, '.env'));

const config = loadConfig();
const handle = await createApp(config);

// МойСклад: echo <токен> | node apps/server/dist/index.js moysklad-token
// проверяет токен и сохраняет его зашифрованным (как кнопка в Настройках → Общие).
if (process.argv[2] === 'moysklad-token') {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const token = Buffer.concat(chunks).toString('utf8').trim();
  const { checkMoyskladToken } = await import('./moysklad');
  const { encryptSecret } = await import('./github/secret');
  try {
    const who = await checkMoyskladToken(token);
    await handle.runtime.store.setSetting(
      'moysklad_token',
      encryptSecret(token, config.jwtSecret),
    );
    console.log(`МойСклад подключён: ${who}`);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'МойСклад не ответил',
    );
    await handle.close();
    process.exit(1);
  }
  await handle.close();
  process.exit(0);
}

// Проверка умений моделей: node apps/server/dist/index.js check-models [имя или id провайдера]
// отвечает ли модель и умеет ли вызывать инструменты (MCP); результат виден в выборе модели.
if (process.argv[2] === 'check-models') {
  const needle = (process.argv[3] ?? '').trim().toLowerCase();
  const { checkProviderModels } = await import('./model-caps');
  const providers = (await handle.runtime.store.listProviders()).filter(
    (row) =>
      row.enabled &&
      row.kind !== 'mock' &&
      (!needle || row.id === needle || row.name.toLowerCase() === needle),
  );
  for (const provider of providers) {
    console.log(`\n${provider.name} (${provider.models.length})`);
    await checkProviderModels(handle.runtime.store, provider, {
      gapMs: 3000,
      onModel: (model, caps) =>
        console.log(
          `  ${caps.ok === true ? '✓' : caps.ok === false ? '✕' : '?'} ${caps.tools ? 'MCP ' : caps.tools === false ? 'без MCP' : '    '} ${model}${caps.error ? `  — ${caps.error.slice(0, 90)}` : ''}`,
        ),
    });
  }
  await handle.close();
  process.exit(0);
}

// Проверка моделей: node apps/server/dist/index.js refresh-models <имя или id провайдера>
// оставляет у провайдера только модели, которые отвечают на пробный запрос.
if (process.argv[2] === 'refresh-models') {
  const needle = (process.argv[3] ?? '').trim();
  const store = handle.runtime.store;
  const all = await store.listProviders();
  const provider = all.find((row) => row.id === needle || row.name === needle);
  if (!provider) {
    console.error(
      `Провайдер «${needle}» не найден. Есть: ${all.map((row) => row.name).join(', ')}`,
    );
    await handle.close();
    process.exit(1);
  }
  const { discoverProvider } = await import('./providers/discover');
  const result = await discoverProvider({
    currentId: provider.id,
    existing: all,
    models: provider.models,
  });
  const working = result.working ?? [];
  const kept = provider.models.filter((model) => working.includes(model));
  const next = kept.length ? kept : working.slice(0, 3);
  console.log(`Отклонены: ${(result.failed ?? []).join(', ') || '—'}`);
  console.log(`Рабочие: ${working.join(', ') || '—'}`);
  if (next.length) {
    await store.updateProvider(provider.id, {
      name: provider.name,
      kind: provider.kind,
      models: next,
    });
    console.log(`Модели провайдера «${provider.name}»: ${next.join(', ')}`);
  } else {
    console.log(
      result.error ?? 'Рабочих моделей не нашлось, список не менялся.',
    );
  }
  await handle.close();
  process.exit(0);
}

// Аварийный вход: node apps/server/dist/index.js reset-link <почта>
// печатает одноразовую ссылку для смены пароля (на час) и завершается.
if (process.argv[2] === 'reset-link') {
  const email = (process.argv[3] ?? '').trim().toLowerCase();
  const user = email
    ? await handle.runtime.store.getUserByEmail(email)
    : undefined;
  if (!user) {
    console.error(`Пользователь ${email || '(почта не указана)'} не найден`);
    await handle.close();
    process.exit(1);
  }
  const { hashInviteToken, newInviteToken } = await import('./auth');
  const token = newInviteToken();
  await handle.runtime.store.createPasswordReset(
    user.id,
    hashInviteToken(token),
  );
  const base = (config.publicUrl || `http://127.0.0.1:${config.port}`).replace(
    /\/$/,
    '',
  );
  console.log(
    `Ссылка для смены пароля ${user.email} (действует 1 час, одноразовая):`,
  );
  console.log(`${base}/?reset=${token}`);
  await handle.close();
  process.exit(0);
}
// Результат рутины сначала уходит в личный бот пользователя («Джарвис»),
// если он подключён; иначе — в старый общий бот команды.
handle.runtime.onRoutineFinished = async (userId, name, text) => {
  const personal = await notifyUserTelegram(
    handle.runtime,
    userId,
    name,
    text,
  ).catch(() => false);
  if (!personal) await notifyTelegram(handle.runtime, userId, name, text);
};
const stopTelegram = startTelegram(handle.runtime);
const stopTelegramBots = startTelegramBots(handle.runtime);
const stopScheduler = handle.startScheduler();
// Модели проверяются сами: в выборе в чате — только те, что отвечают.
const { startModelChecks } = await import('./model-caps');
const stopModelChecks = startModelChecks(handle.runtime.store);
// Автопродление тарифов по сохранённой карте — раз в час.
const { renewDuePlans } = await import('./billing');
const renewTimer = setInterval(
  () =>
    void renewDuePlans(handle.runtime.store, config.jwtSecret).catch(
      () => undefined,
    ),
  3_600_000,
);
renewTimer.unref();

const server = createAdaptorServer({
  fetch: handle.app.fetch,
}) as import('node:http').Server;

/**
 * WebSocket-прокси для HMR живого превью: `/api/preview/live/<id>/...`.
 * Обычный HTTP уже проксируется через Hono; здесь — upgrade-запросы Vite и др.
 * Авторизация по cookie сессии, cookie в dev-сервер не передаём.
 */
async function handlePreviewUpgrade(
  req: import('node:http').IncomingMessage,
  socket: import('node:net').Socket,
  head: Buffer,
): Promise<void> {
  const destroy = (): void => {
    socket.destroy();
  };
  try {
    const url = req.url ?? '';
    const match = url.match(/^\/api\/preview\/live\/([a-z0-9]+)(\/.*)?$/);
    if (!match) return destroy();
    const id = match[1] as string;
    const cookie = req.headers.cookie ?? '';
    const token = cookie
      .split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith('mayak_session='))
      ?.slice('mayak_session='.length);
    const userId = token ? readSession(token, config.jwtSecret) : undefined;
    if (!userId) return destroy();
    const user = await handle.runtime.store.getUser(userId);
    if (!user || user.status === 'disabled') return destroy();
    const row = await handle.runtime.store.getPreviewServe(id);
    if (!row || row.userId !== user.id) return destroy();
    const live = await getRunnerServe(id);
    if (!live || live.status !== 'running') return destroy();

    const upstream = net.connect(live.port, previewRunnerHost());
    upstream.on('connect', () => {
      const headers = { ...req.headers };
      delete headers.cookie;
      delete headers.authorization;
      upstream.write(
        `${req.method ?? 'GET'} ${url} HTTP/${req.httpVersion}\r\n`,
      );
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value))
          for (const item of value) upstream.write(`${name}: ${item}\r\n`);
        else upstream.write(`${name}: ${value}\r\n`);
      }
      upstream.write('\r\n');
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', destroy);
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  } catch {
    destroy();
  }
}

server.on('upgrade', (req, socket, head) => {
  void handlePreviewUpgrade(req, socket as import('node:net').Socket, head);
});
server.listen(config.port, config.host, () => {
  console.log(
    `QASTOM AGENT слушает http://${config.host === '0.0.0.0' ? '0.0.0.0' : config.host}:${config.port}`,
  );
});

async function shutdown(): Promise<void> {
  stopScheduler();
  stopModelChecks();
  clearInterval(renewTimer);
  stopTelegram();
  stopTelegramBots();
  server.close();
  await handle.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
