import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Корень репозитория: apps/server/src → ../../.. ; после сборки apps/server/dist → ../../.. */
export const repoRoot = path.resolve(here, '../../..');

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  repoRoot: string;
  staticDir?: string;
  demoServerPath: string;
  examplesSkillsDir: string;
  databaseUrl?: string;
  authEnabled: boolean;
  jwtSecret: string;
  secureCookie: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.DATA_DIR ?? path.join(repoRoot, 'data'),
  );
  const port = overrides.port ?? Number(process.env.PORT ?? 8787);
  return {
    host: overrides.host ?? process.env.HOST ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 8787,
    dataDir,
    repoRoot: overrides.repoRoot ?? repoRoot,
    staticDir: overrides.staticDir ?? (process.env.STATIC_DIR || undefined),
    demoServerPath:
      overrides.demoServerPath ??
      process.env.MAYAK_DEMO_SERVER ??
      path.join(repoRoot, 'examples/demo-mcp-server/server.mjs'),
    examplesSkillsDir:
      overrides.examplesSkillsDir ?? path.join(repoRoot, 'examples/skills'),
    databaseUrl:
      overrides.databaseUrl ?? (process.env.DATABASE_URL || undefined),
    authEnabled:
      overrides.authEnabled ??
      (process.env.MAYAK_SINGLE_USER === '1'
        ? false
        : process.env.MAYAK_AUTH === '1'),
    jwtSecret:
      overrides.jwtSecret ??
      process.env.JWT_SECRET ??
      'mayak-dev-secret-change-me',
    secureCookie: overrides.secureCookie ?? process.env.COOKIE_SECURE === '1',
  };
}
