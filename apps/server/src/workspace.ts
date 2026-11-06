import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Рабочая папка агента: файлы, которые агент читает и правит.
 * Все пути ограничены корнем папки, выйти за него нельзя.
 */
export const WORKSPACE_LIMITS = {
  fileBytes: 1_000_000,
  listEntries: 500,
  readChars: 60_000,
};

export function workspaceRoot(
  dataDir: string,
  userId: string,
  agentId: string,
): string {
  const safe = (value: string) => value.replace(/[^\w-]+/g, '_').slice(0, 80);
  const root = path.join(dataDir, 'workspaces', safe(userId), safe(agentId));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Абсолютный путь внутри корня или ошибка. */
export function resolveInside(root: string, relative: string): string {
  const cleaned = (relative || '.').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, cleaned);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('Путь выходит за пределы рабочей папки');
  }
  // Симлинки не должны уводить наружу.
  if (fs.existsSync(full)) {
    const real = fs.realpathSync(full);
    const realBase = fs.realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) {
      throw new Error('Путь выходит за пределы рабочей папки');
    }
  }
  return full;
}

export function listWorkspace(root: string, relative = '.'): string {
  const start = resolveInside(root, relative);
  if (!fs.existsSync(start)) return `Папки «${relative}» нет.`;
  const lines: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (lines.length >= WORKSPACE_LIMITS.listEntries || depth > 6) return;
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.name !== '.git' &&
          entry.name !== 'node_modules' &&
          entry.name !== '.qastom',
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= WORKSPACE_LIMITS.listEntries) break;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        lines.push(`${rel}/`);
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        lines.push(`${rel} (${fs.statSync(full).size} Б)`);
      }
    }
  };
  walk(start, 0);
  return lines.length ? lines.join('\n') : 'Рабочая папка пуста.';
}

export function readWorkspaceFile(root: string, relative: string): string {
  const full = resolveInside(root, relative);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile())
    return `Файла «${relative}» нет.`;
  const text = fs.readFileSync(full, 'utf8');
  if (text.length > WORKSPACE_LIMITS.readChars) {
    return `${text.slice(0, WORKSPACE_LIMITS.readChars)}\n… (обрезано, всего ${text.length} символов)`;
  }
  return text;
}

/** Поиск текста или регулярного выражения по файлам рабочей папки (как grep -n). */
export function searchWorkspace(
  root: string,
  query: string,
  relative = '.',
  options: { regex?: boolean; glob?: string } = {},
): string {
  if (!query) return 'Укажите query.';
  let pattern: RegExp;
  try {
    pattern = options.regex
      ? new RegExp(query, 'i')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch {
    return 'Некорректное регулярное выражение.';
  }
  const ext = options.glob?.trim().replace(/^\*+/, '').toLowerCase();
  const start = resolveInside(root, relative);
  if (!fs.existsSync(start)) return `Папки «${relative}» нет.`;
  const hits: string[] = [];
  let files = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (hits.length >= 80 || files > 5000) return;
      if (
        ['.git', 'node_modules', '.qastom', 'dist', 'build'].includes(
          entry.name,
        )
      )
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        if (ext && !entry.name.toLowerCase().endsWith(ext)) continue;
        const size = fs.statSync(full).size;
        if (size > 500_000) continue;
        files += 1;
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes('\0')) continue;
        const rel = path.relative(root, full).replace(/\\/g, '/');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < 80; i++)
          if (pattern.test(lines[i]!))
            hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
      }
    }
  };
  if (fs.statSync(start).isFile()) {
    const text = fs.readFileSync(start, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (hits.length < 80 && pattern.test(line))
        hits.push(`${relative}:${i + 1}: ${line.trim().slice(0, 200)}`);
    });
  } else walk(start);
  if (!hits.length) return `«${query}» не найдено.`;
  return (
    hits.join('\n') + (hits.length >= 80 ? '\n… (показаны первые 80)' : '')
  );
}

/** Пишет файл целиком и возвращает дифф. */
export function writeWorkspaceFile(
  root: string,
  relative: string,
  content: string,
): string {
  if (Buffer.byteLength(content) > WORKSPACE_LIMITS.fileBytes)
    return 'Файл больше 1 МБ.';
  const full = resolveInside(root, relative);
  const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return formatDiff(relative, before, content, !before);
}

/** Точечная правка: заменяет один фрагмент old на new. */
export function editWorkspaceFile(
  root: string,
  relative: string,
  oldText: string,
  newText: string,
): string {
  const full = resolveInside(root, relative);
  if (!fs.existsSync(full)) return `Файла «${relative}» нет.`;
  const before = fs.readFileSync(full, 'utf8');
  if (!oldText) return 'Укажите old — фрагмент, который нужно заменить.';
  const count = before.split(oldText).length - 1;
  if (count === 0) return 'Фрагмент old в файле не найден.';
  if (count > 1)
    return `Фрагмент old встречается ${count} раз — расширьте его, чтобы он был уникальным.`;
  const after = before.replace(oldText, () => newText);
  if (Buffer.byteLength(after) > WORKSPACE_LIMITS.fileBytes)
    return 'Файл больше 1 МБ.';
  fs.writeFileSync(full, after, 'utf8');
  return formatDiff(relative, before, after, false);
}

export function deleteWorkspaceFile(root: string, relative: string): string {
  const full = resolveInside(root, relative);
  if (full === path.resolve(root))
    return 'Нельзя удалить корень рабочей папки.';
  if (!fs.existsSync(full)) return `«${relative}» нет.`;
  const before = fs.statSync(full).isFile()
    ? fs.readFileSync(full, 'utf8')
    : '';
  fs.rmSync(full, { recursive: true, force: true });
  return before
    ? formatDiff(relative, before, '', false)
    : `Удалено: ${relative}`;
}

/** Дифф в формате DIFF:<json>, который интерфейс рисует цветом. */
export function formatDiff(
  file: string,
  before: string,
  after: string,
  created: boolean,
): string {
  const hunks = unifiedDiff(before, after);
  const added = hunks.filter((line) => line.startsWith('+')).length;
  const removed = hunks.filter((line) => line.startsWith('-')).length;
  return `DIFF:${JSON.stringify({ file, created, added, removed, lines: hunks.slice(0, 400) })}`;
}

/** Построчный дифф (LCS) с контекстом в 2 строки. */
export function unifiedDiff(before: string, after: string): string[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Для очень больших файлов — грубое сравнение без LCS.
  if (a.length * b.length > 4_000_000) {
    return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)];
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push(` ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push(`-${a[i]}`);
      i++;
    } else {
      ops.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) ops.push(`-${a[i++]}`);
  while (j < m) ops.push(`+${b[j++]}`);
  // Оставляем только изменения и 2 строки контекста вокруг них.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op[0] !== ' ') {
      for (
        let k = Math.max(0, index - 2);
        k <= Math.min(ops.length - 1, index + 2);
        k++
      )
        keep[k] = true;
    }
  });
  const out: string[] = [];
  let gap = false;
  ops.forEach((op, index) => {
    if (keep[index]) {
      if (gap && out.length) out.push('@@');
      out.push(op);
      gap = false;
    } else gap = true;
  });
  return out;
}

/**
 * Команда терминала в Docker-песочнице с рабочей папкой в /work.
 * Без сети, с лимитами по памяти, CPU и времени.
 */
export async function runWorkspaceShell(input: {
  enabled: boolean;
  root: string;
  command: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}): Promise<string> {
  if (!input.enabled)
    return 'Терминал выключен. Его включает администратор (песочница кода в настройках).';
  const command = input.command.trim();
  if (!command) return 'Пустая команда.';
  if (command.length > 4000) return 'Команда слишком длинная.';
  const spawnImpl = input.spawnImpl ?? spawn;
  const hostRoot = process.env.MAYAK_WORKSPACE_HOST_DIR
    ? path.join(
        process.env.MAYAK_WORKSPACE_HOST_DIR,
        path.relative(path.resolve(input.root, '..', '..'), input.root),
      )
    : input.root;
  const args = [
    'run',
    '--rm',
    '-i',
    '--network',
    'none',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--pids-limit',
    '128',
    '-v',
    `${hostRoot}:/work`,
    '-w',
    '/work',
    process.env.MAYAK_SHELL_IMAGE || 'python:3.12-alpine',
    'sh',
    '-c',
    command,
  ];
  return new Promise((resolve) => {
    let out = '';
    const child = spawnImpl('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      input.timeoutMs ?? 60_000,
    );
    const collect = (chunk: Buffer) => {
      if (out.length < 40_000) out += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(`Не удалось запустить терминал: ${error.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(
        `$ ${command}\n${out.slice(0, 40_000)}${out ? '' : '(нет вывода)'}\n[код выхода ${code ?? 'killed'}]`,
      );
    });
  });
}
