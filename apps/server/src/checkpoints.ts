import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CheckpointInfo, RestoreCheckpointResult } from '@mayak/shared';

/**
 * Точки отката рабочей папки агента.
 *
 * Перед каждым ходом чата снимаем архив рабочей папки (без тяжёлых служебных
 * каталогов) и кладём его в DATA_DIR/checkpoints/<чат>. Кнопка «Отменить
 * изменения» в ответе агента возвращает файлы к состоянию до хода: восстанавливает
 * изменённые и удалённые файлы и удаляет созданные за ход.
 */
const KEEP_PER_CHAT = 10;
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
/** Не попадают в архив и не удаляются при откате. */
const EXCLUDES = [
  'node_modules',
  '.git',
  '.qastom',
  '.venv',
  '__pycache__',
  '.cache',
  '.npm',
  '.home',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
];
const EXCLUDE_ARGS = EXCLUDES.map((name) => `--exclude=${name}`);
const ID_PATTERN = /^[0-9]{13}-[a-f0-9]{8}$/;

function safe(value: string): string {
  return value.replace(/[^\w-]+/g, '_').slice(0, 80);
}

export function checkpointsDir(dataDir: string, conversationId: string): string {
  return path.join(dataDir, 'checkpoints', safe(conversationId));
}

function archivePath(dir: string, id: string): string {
  return path.join(dir, `${id}.tar.gz`);
}

function metaPath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function run(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      options.timeoutMs ?? 120_000,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 4_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function readMeta(dir: string, id: string): CheckpointInfo | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(metaPath(dir, id), 'utf8'),
    ) as CheckpointInfo;
    if (!raw?.id || raw.id !== id) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Список точек отката чата, от свежих к старым. */
export function listCheckpoints(
  dataDir: string,
  conversationId: string,
): CheckpointInfo[] {
  const dir = checkpointsDir(dataDir, conversationId);
  if (!fs.existsSync(dir)) return [];
  const items: CheckpointInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const meta = readMeta(dir, name.slice(0, -5));
    if (meta) items.push(meta);
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function prune(dir: string): void {
  const keep = new Set(
    listMetaFiles(dir)
      .map((name) => name.slice(0, -5))
      .slice(0, KEEP_PER_CHAT),
  );
  for (const name of fs.readdirSync(dir)) {
    const id = name.endsWith('.json')
      ? name.slice(0, -5)
      : name.endsWith('.tar.gz')
        ? name.slice(0, -7)
        : '';
    if (!id || keep.has(id)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // не мешаем ходу из-за уборки
    }
  }
}

/** Метаданные, отсортированные от свежих к старым (id сортируется по времени). */
function listMetaFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a));
}

/**
 * Снять точку отката перед ходом. Возвращает null, если папки ещё нет,
 * она пустая или архив получился слишком большим.
 */
export async function createCheckpoint(input: {
  dataDir: string;
  conversationId: string;
  workspace: string;
  messageId?: string;
  label?: string;
}): Promise<CheckpointInfo | null> {
  const workspace = path.resolve(input.workspace);
  if (!fs.existsSync(workspace)) return null;
  const dir = checkpointsDir(input.dataDir, input.conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const file = archivePath(dir, id);
  const result = await run('tar', [
    '-czf',
    file,
    ...EXCLUDE_ARGS,
    '-C',
    workspace,
    '.',
  ]);
  if (result.code !== 0) {
    fs.rmSync(file, { force: true });
    return null;
  }
  const stat = fs.statSync(file);
  if (stat.size > MAX_ARCHIVE_BYTES) {
    fs.rmSync(file, { force: true });
    return null;
  }
  const list = await run('tar', ['-tzf', file]);
  const files = list.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== '.' && !line.endsWith('/')).length;
  // Пустая папка — тоже валидная точка: откат удалит файлы, созданные за ход.
  const info: CheckpointInfo = {
    id,
    createdAt: new Date().toISOString(),
    messageId: input.messageId,
    bytes: stat.size,
    files,
  };
  fs.writeFileSync(metaPath(dir, id), JSON.stringify(info, null, 2), 'utf8');
  prune(dir);
  cleanupOld(input.dataDir);
  return info;
}

/** Убираем точки старше недели во всех чатах, чтобы диск не рос бесконечно. */
function cleanupOld(dataDir: string): void {
  const base = path.join(dataDir, 'checkpoints');
  if (!fs.existsSync(base)) return;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch {
        // файл уже удалён
      }
    }
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // каталог занят
    }
  }
}

function archiveEntries(stdout: string): Set<string> {
  const entries = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim().replace(/^\.\//, '');
    if (!line || line === '.' || line.endsWith('/')) continue;
    entries.add(line);
  }
  return entries;
}

function collectWorkspaceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, relative: string, depth: number) => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDES.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel, depth + 1);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk(root, '', 0);
  return files;
}

/**
 * Откатить рабочую папку к точке. Возвращает, сколько файлов восстановлено
 * и сколько созданных за ход удалено.
 */
export async function restoreCheckpoint(input: {
  dataDir: string;
  conversationId: string;
  checkpointId: string;
  workspace: string;
}): Promise<RestoreCheckpointResult | null> {
  if (!ID_PATTERN.test(input.checkpointId)) return null;
  const dir = checkpointsDir(input.dataDir, input.conversationId);
  const file = archivePath(dir, input.checkpointId);
  const meta = readMeta(dir, input.checkpointId);
  if (!meta || !fs.existsSync(file)) return null;
  const workspace = path.resolve(input.workspace);
  fs.mkdirSync(workspace, { recursive: true });
  const list = await run('tar', ['-tzf', file]);
  if (list.code !== 0) return null;
  const entries = archiveEntries(list.stdout);
  let removed = 0;
  for (const relative of collectWorkspaceFiles(workspace)) {
    if (entries.has(relative.replace(/\\/g, '/'))) continue;
    try {
      fs.rmSync(path.join(workspace, relative), { force: true });
      removed += 1;
    } catch {
      // файл могли удалить параллельно — не мешаем откату
    }
  }
  const extract = await run('tar', ['-xzf', file, '-C', workspace]);
  if (extract.code !== 0) return null;
  return { restored: entries.size, removed };
}
