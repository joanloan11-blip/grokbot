import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig, repoRoot } from './config';
import { loadDotEnv } from './env';
import { notifyTelegram, startTelegram } from './telegram';

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
handle.runtime.onRoutineFinished = (userId, name, text) =>
  notifyTelegram(handle.runtime, userId, name, text);
const stopTelegram = startTelegram(handle.runtime);
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

const server = serve(
  { fetch: handle.app.fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(`QASTOM AGENT слушает http://${info.address}:${info.port}`);
  },
);

async function shutdown(): Promise<void> {
  stopScheduler();
  stopModelChecks();
  clearInterval(renewTimer);
  stopTelegram();
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
