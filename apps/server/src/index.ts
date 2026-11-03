import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig, repoRoot } from './config';
import { loadDotEnv } from './env';

loadDotEnv(path.join(repoRoot, '.env'));

const config = loadConfig();
const handle = await createApp(config);
const stopScheduler = handle.startScheduler();

const server = serve(
  { fetch: handle.app.fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(`Маяк слушает http://${info.address}:${info.port}`);
  },
);

async function shutdown(): Promise<void> {
  stopScheduler();
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
