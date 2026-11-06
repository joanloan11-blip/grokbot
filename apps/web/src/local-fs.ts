/**
 * Папка на компьютере пользователя (File System Access API: Chrome, Edge, Яндекс Браузер).
 * Агент на сервере присылает запросы local_fs, браузер выполняет их только внутри выбранной папки.
 */

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (options: {
    mode: 'readwrite';
  }) => Promise<PermissionState>;
  requestPermission?: (options: {
    mode: 'readwrite';
  }) => Promise<PermissionState>;
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

const DB = 'qastom-local';
const STORE = 'handles';
const KEY = 'folder';
const SKIP = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '.venv',
  '__pycache__',
]);
const MAX_FILE = 1_000_000;

export function localFsSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

export async function savedFolder(): Promise<DirHandle | null> {
  try {
    const base = await db();
    return await new Promise((resolve) => {
      const request = base.transaction(STORE).objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve((request.result as DirHandle) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function remember(handle: DirHandle | null): Promise<void> {
  try {
    const base = await db();
    const store = base.transaction(STORE, 'readwrite').objectStore(STORE);
    if (handle) store.put(handle, KEY);
    else store.delete(KEY);
  } catch {
    // без IndexedDB папку придётся выбирать заново после перезагрузки
  }
}

export async function pickFolder(): Promise<DirHandle | null> {
  const picker = (
    window as unknown as {
      showDirectoryPicker: (options: {
        mode: 'readwrite';
      }) => Promise<DirHandle>;
    }
  ).showDirectoryPicker;
  try {
    const handle = await picker({ mode: 'readwrite' });
    await remember(handle);
    return handle;
  } catch {
    return null;
  }
}

export async function forgetFolder(): Promise<void> {
  await remember(null);
}

/** Разрешение на чтение и запись: спрашиваем по нажатию пользователя (отправка сообщения). */
export async function ensurePermission(handle: DirHandle): Promise<boolean> {
  const query = await handle.queryPermission?.({ mode: 'readwrite' });
  if (query === 'granted') return true;
  return (
    (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted'
  );
}

function parts(path: string): string[] {
  const list = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.');
  if (list.some((part) => part === '..'))
    throw new Error('Путь выходит за пределы папки');
  return list;
}

async function dirAt(
  root: DirHandle,
  list: string[],
  create = false,
): Promise<DirHandle> {
  let current = root;
  for (const name of list)
    current = (await current.getDirectoryHandle(name, { create })) as DirHandle;
  return current;
}

async function fileAt(root: DirHandle, path: string, create = false) {
  const list = parts(path);
  const name = list.pop();
  if (!name) throw new Error('Укажите файл');
  const dir = await dirAt(root, list, create);
  return dir.getFileHandle(name, { create });
}

async function readText(root: DirHandle, path: string): Promise<string | null> {
  try {
    const file = await (await fileAt(root, path)).getFile();
    if (file.size > MAX_FILE) throw new Error(`Файл «${path}» больше 1 МБ`);
    return await file.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError')
      return null;
    if (error instanceof TypeError) return null;
    throw error;
  }
}

async function* walk(
  dir: DirHandle,
  prefix: string,
  depth: number,
): AsyncGenerator<{
  path: string;
  kind: 'file' | 'directory';
  handle: FileSystemHandle;
}> {
  if (depth > 8 || !dir.entries) return;
  const items: [string, FileSystemHandle][] = [];
  for await (const entry of dir.entries()) items.push(entry);
  items.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, handle] of items) {
    if (SKIP.has(name)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    yield { path, kind: handle.kind, handle };
    if (handle.kind === 'directory')
      yield* walk(handle as DirHandle, path, depth + 1);
  }
}

function globToRegex(pattern: string): RegExp {
  let source = '';
  const text = pattern.trim().replace(/^\.\//, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '*') {
      if (text[i + 1] === '*') {
        source += text[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += text[i + 2] === '/' ? 2 : 1;
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

/** Выполнить запрос агента в папке. Ответ уходит на сервер. */
export async function runLocalOp(
  root: DirHandle,
  op: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const path = typeof args.path === 'string' ? args.path : '.';
  if (op === 'read') {
    const text = await readText(root, path);
    return text === null ? { missing: true } : { text };
  }
  if (op === 'write') {
    const content = typeof args.content === 'string' ? args.content : '';
    const before = await readText(root, path).catch(() => null);
    const handle = await fileAt(root, path, true);
    const writable = await (
      handle as FileSystemFileHandle & {
        createWritable: () => Promise<{
          write: (data: string) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }
    ).createWritable();
    await writable.write(content);
    await writable.close();
    return { before: before ?? '', created: before === null };
  }
  if (op === 'delete') {
    const list = parts(path);
    const name = list.pop();
    if (!name) throw new Error('Нельзя удалить корень папки');
    const before = await readText(root, path).catch(() => null);
    const dir = await dirAt(root, list);
    await dir.removeEntry(name, { recursive: true });
    return { before: before ?? '' };
  }
  const start = await dirAt(root, parts(path));
  if (op === 'list') {
    const lines: string[] = [];
    for await (const item of walk(start, '', 0)) {
      if (lines.length >= 500) break;
      if (item.kind === 'directory') lines.push(`${item.path}/`);
      else {
        const file = await (item.handle as FileSystemFileHandle).getFile();
        lines.push(`${item.path} (${file.size} Б)`);
      }
    }
    return lines.length ? lines.join('\n') : 'Папка пуста.';
  }
  if (op === 'glob') {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    if (!pattern) return 'Укажите pattern.';
    const matcher = globToRegex(pattern);
    const byName = !pattern.includes('/');
    const found: string[] = [];
    for await (const item of walk(start, '', 0)) {
      if (item.kind !== 'file') continue;
      const name = item.path.split('/').pop() ?? '';
      if (matcher.test(byName ? name : item.path)) found.push(item.path);
      if (found.length >= 200) break;
    }
    return found.length
      ? found.join('\n')
      : `По маске «${pattern}» файлов нет.`;
  }
  if (op === 'search') {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query) return 'Укажите query.';
    let pattern: RegExp;
    try {
      pattern = args.regex
        ? new RegExp(query, 'i')
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch {
      return 'Некорректное регулярное выражение.';
    }
    const suffix =
      typeof args.glob === 'string'
        ? args.glob.replace(/^\*+/, '').toLowerCase()
        : '';
    const hits: string[] = [];
    let files = 0;
    for await (const item of walk(start, '', 0)) {
      if (item.kind !== 'file' || hits.length >= 80 || files > 3000) continue;
      if (suffix && !item.path.toLowerCase().endsWith(suffix)) continue;
      const file = await (item.handle as FileSystemFileHandle).getFile();
      if (file.size > 500_000) continue;
      files += 1;
      const text = await file.text();
      if (text.includes('\0')) continue;
      text.split('\n').forEach((line, index) => {
        if (hits.length < 80 && pattern.test(line))
          hits.push(`${item.path}:${index + 1}: ${line.trim().slice(0, 200)}`);
      });
    }
    return hits.length ? hits.join('\n') : `«${query}» не найдено.`;
  }
  throw new Error(`Неизвестная операция ${op}`);
}
