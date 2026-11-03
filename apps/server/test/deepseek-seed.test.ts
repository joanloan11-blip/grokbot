import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODELS,
  type ProviderPublic,
} from '@mayak/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';
import { loadDotEnv } from '../src/env';

const original = process.env.DEEPSEEK_API_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = original;
});

describe('DeepSeek preset', () => {
  it('creates a provider from DEEPSEEK_API_KEY and does not return the key', async () => {
    process.env.DEEPSEEK_API_KEY = 'unit-deepseek-key';
    const dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-deepseek-'));
    let handle: AppHandle | undefined;
    try {
      handle = await createApp(loadConfig({ dataDir, repoRoot }));
      const listed = (await (
        await handle.app.request('/api/providers')
      ).json()) as ProviderPublic[];
      const deepseek = listed.find((item) => item.kind === 'deepseek');
      expect(deepseek).toMatchObject({
        name: 'DeepSeek',
        kind: 'deepseek',
        baseUrl: DEEPSEEK_BASE_URL,
        models: [...DEEPSEEK_MODELS],
        enabled: true,
        hasApiKey: true,
      });
      expect(JSON.stringify(listed)).not.toContain('unit-deepseek-key');

      const created = (await (
        await handle.app.request('/api/conversations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ locale: 'ru' }),
        })
      ).json()) as { providerId: string; model: string };
      expect(created.providerId).toBe(deepseek?.id);
      expect(created.model).toBe('deepseek-chat');
    } finally {
      await handle?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('reads DEEPSEEK_API_KEY from a dotenv file without overriding the environment', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mayak-env-'));
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      'DEEPSEEK_API_KEY="from-file"\nPORT=9999\n# comment\n',
    );
    const previousPort = process.env.PORT;
    process.env.PORT = '8787';
    delete process.env.DEEPSEEK_API_KEY;
    try {
      loadDotEnv(file);
      expect(process.env.DEEPSEEK_API_KEY).toBe('from-file');
      expect(process.env.PORT).toBe('8787');
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
