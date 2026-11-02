import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const handle = await createApp(config);

const server = serve(
  { fetch: handle.app.fetch, hostname: config.host, port: config.port },
  (info) => {
    console.log(`Маяк слушает http://${info.address}:${info.port}`);
  },
);

async function shutdown(): Promise<void> {
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
