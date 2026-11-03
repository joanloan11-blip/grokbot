import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig, repoRoot } from './config';
import { loadDotEnv } from './env';
import { notifyTelegram, startTelegram } from './telegram';

loadDotEnv(path.join(repoRoot, '.env'));

const config = loadConfig();
const handle = await createApp(config);

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

const server = serve(
  { fetch: handle.app.fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(`Маяк слушает http://${info.address}:${info.port}`);
  },
);

async function shutdown(): Promise<void> {
  stopScheduler();
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
