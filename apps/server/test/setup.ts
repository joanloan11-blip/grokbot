import path from 'node:path';
import { repoRoot } from '../src/config';
import { loadDotEnv } from '../src/env';

// Load .env first so a live test can still see the key, then hide provider
// secrets from every other test. createApp must not turn the demo agent into
// DeepSeek just because the developer exported DEEPSEEK_API_KEY.
loadDotEnv(path.join(repoRoot, '.env'));

const secretNames = [
  'DEEPSEEK_API_KEY',
  'MAYAK_OPENAI_API_KEY',
  'MAYAK_OPENAI_BASE_URL',
  'MAYAK_OPENAI_MODEL',
  'MAYAK_OPENAI_NAME',
] as const;

for (const name of secretNames) {
  const value = process.env[name];
  if (value) process.env[`MAYAK_TEST_STASH_${name}`] = value;
  delete process.env[name];
}
