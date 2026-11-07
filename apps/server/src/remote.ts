import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from './github/secret';
import type { Store } from './db';

/**
 * Работа на удалённом сервере по SSH. Доступ только у администратора:
 * подключения лежат в настройках, приватный ключ шифруется JWT_SECRET.
 *
 * Используется системный ssh-клиент (есть в образе), а не библиотека:
 * так не нужны новые зависимости и lockfile, а поведение совпадает с ручным ssh.
 */
export interface SshHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  privateKey: string;
}

interface StoredHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  key: string;
  createdAt: string;
}

const SETTING = 'ssh_hosts';
const TMP = '/tmp/mayak-ssh';
const MAX_OUTPUT = 12_000;

const dirname = (value: string) => {
  const at = value.lastIndexOf('/');
  return at <= 0 ? '.' : value.slice(0, at);
};

/** Экранирование для удалённой команды: пути и аргументы в одинарных кавычках. */
export function quoteRemote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function listHosts(
  store: Store,
  jwtSecret: string | undefined,
): Promise<SshHost[]> {
  if (!jwtSecret) return [];
  const raw = await store.getSetting(SETTING);
  if (!raw) return [];
  let rows: StoredHost[];
  try {
    rows = JSON.parse(raw) as StoredHost[];
  } catch {
    return [];
  }
  const result: SshHost[] = [];
  for (const row of rows) {
    try {
      result.push({ ...row, privateKey: decryptSecret(row.key, jwtSecret) });
    } catch {
      // ключ не расшифровывается — пропускаем, остальные остаются рабочими
    }
  }
  return result;
}

export async function hostSummaries(
  store: Store,
  jwtSecret: string | undefined,
): Promise<Omit<SshHost, 'privateKey'>[]> {
  const hosts = await listHosts(store, jwtSecret);
  return hosts.map(({ privateKey: _key, ...rest }) => rest);
}

export async function addHost(
  store: Store,
  jwtSecret: string,
  input: { name: string; host: string; port: number; user: string; privateKey: string },
): Promise<Omit<SshHost, 'privateKey'>> {
  const id = randomBytes(6).toString('hex');
  const clean: SshHost = {
    id,
    name: input.name.trim() || `${input.user}@${input.host}`,
    host: input.host.trim(),
    port: Number.isFinite(input.port) ? input.port : 22,
    user: input.user.trim(),
    privateKey: input.privateKey.trim(),
  };
  const stored = await readStored(store);
  stored.push({
    id: clean.id,
    name: clean.name,
    host: clean.host,
    port: clean.port,
    user: clean.user,
    key: encryptSecret(clean.privateKey, jwtSecret),
    createdAt: new Date().toISOString(),
  });
  await store.setSetting(SETTING, JSON.stringify(stored));
  return {
    id: clean.id,
    name: clean.name,
    host: clean.host,
    port: clean.port,
    user: clean.user,
  };
}

export async function removeHost(store: Store, id: string): Promise<boolean> {
  const stored = await readStored(store);
  const next = stored.filter((row) => row.id !== id);
  if (next.length === stored.length) return false;
  await store.setSetting(SETTING, JSON.stringify(next));
  return true;
}

async function readStored(store: Store): Promise<StoredHost[]> {
  const raw = await store.getSetting(SETTING);
  if (!raw) return [];
  try {
    const rows = JSON.parse(raw) as StoredHost[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

const clip = (value: string) =>
  value.length > MAX_OUTPUT
    ? `${value.slice(0, MAX_OUTPUT)}\n…[обрезано, всего ${value.length} символов]`
    : value;

async function withKey<T>(
  host: SshHost,
  run: (keyPath: string, knownHosts: string) => Promise<T>,
): Promise<T> {
  await fs.mkdir(TMP, { recursive: true, mode: 0o700 });
  const keyPath = path.join(TMP, `${host.id}-${randomBytes(4).toString('hex')}.key`);
  const knownHosts = path.join(TMP, 'known_hosts');
  await fs.writeFile(keyPath, `${host.privateKey.trim()}\n`, { mode: 0o600 });
  try {
    return await run(keyPath, knownHosts);
  } finally {
    await fs.rm(keyPath, { force: true }).catch(() => undefined);
  }
}

/** Выполнить команду на сервере. Команда уходит одним аргументом ssh. */
export async function runOnHost(
  host: SshHost,
  command: string,
  options: { timeoutMs?: number; input?: string } = {},
): Promise<CommandResult> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 60_000, 5_000), 300_000);
  const started = Date.now();
  return withKey(host, (keyPath, knownHosts) =>
    new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(
        'ssh',
        [
          '-i',
          keyPath,
          '-p',
          String(host.port),
          '-o',
          'BatchMode=yes',
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-o',
          `UserKnownHostsFile=${knownHosts}`,
          '-o',
          'ConnectTimeout=12',
          '-o',
          'LogLevel=ERROR',
          `${host.user}@${host.host}`,
          command,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({
          code: null,
          stdout: clip(stdout),
          stderr: `${clip(stderr)}\n[прервано по таймауту ${Math.round(timeoutMs / 1000)} с]`,
          ms: Date.now() - started,
        });
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_OUTPUT * 3) stdout = stdout.slice(0, MAX_OUTPUT * 3);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new Error(
            `Не удалось запустить ssh: ${error.message}. Проверьте, что в образе есть openssh-client.`,
          ),
        );
      });
      child.on('close', (code) => {
        finish({ code, stdout: clip(stdout), stderr: clip(stderr), ms: Date.now() - started });
      });
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    }),
  );
}

/** Проверка связи: имя сервера, версия ядра, кто мы. */
export async function probeHost(host: SshHost): Promise<string> {
  const result = await runOnHost(
    host,
    'printf "host=%s\\nwho=%s\\nkernel=%s\\n" "$(hostname)" "$(whoami)" "$(uname -sr)"',
    { timeoutMs: 20_000 },
  );
  if (result.code !== 0)
    return `Не удалось подключиться: ${(result.stderr || result.stdout).trim().slice(0, 400)}`;
  return result.stdout.trim();
}

export async function readRemote(
  host: SshHost,
  filePath: string,
  maxBytes = 60_000,
): Promise<string> {
  const result = await runOnHost(
    host,
    `head -c ${Math.min(Math.max(maxBytes, 1), 200_000)} -- ${quoteRemote(filePath)}`,
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0)
    throw new Error(`Не удалось прочитать ${filePath}: ${result.stderr.trim() || `код ${result.code}`}`);
  return result.stdout;
}

export async function writeRemote(
  host: SshHost,
  filePath: string,
  content: string,
): Promise<number> {
  const dir = dirname(filePath);
  const command = `mkdir -p -- ${quoteRemote(dir)} && cat > ${quoteRemote(filePath)}`;
  const result = await runOnHost(host, command, {
    timeoutMs: 60_000,
    input: content,
  });
  if (result.code !== 0)
    throw new Error(`Не удалось записать ${filePath}: ${result.stderr.trim() || `код ${result.code}`}`);
  return Buffer.byteLength(content, 'utf8');
}

export async function listRemote(host: SshHost, dirPath: string): Promise<string> {
  const result = await runOnHost(
    host,
    `ls -la -- ${quoteRemote(dirPath)}`,
    { timeoutMs: 30_000 },
  );
  if (result.code !== 0)
    throw new Error(`Не удалось прочитать каталог ${dirPath}: ${result.stderr.trim() || `код ${result.code}`}`);
  return result.stdout;
}
