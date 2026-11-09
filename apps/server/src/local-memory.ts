import type { LocalFs } from './local-fs';

/**
 * Память агента в папке на компьютере пользователя. Когда чат работает в режиме
 * «папка на компьютере», заметки (memory_read/write, remember/recall) читаются и
 * пишутся в JSON-файл внутри выбранной папки, а не в базу на сервере: память не
 * уходит в облако и не занимает место на сервере.
 *
 * Формат: `.qastom/memory/<agentId>.json`
 * { version: 1, notes: { key: { content, updatedAt } }, entries: [...] }
 */
const MEMORY_DIR = '.qastom/memory';
/** Общие для всех агентов пользователя заметки (kind=shared) лежат отдельно. */
const SHARED_AGENT = 'shared';
const MAX_NOTES = 200;
const MAX_CONTENT = 20_000;
const MAX_ENTRIES = 300;
const RECALL_LIMIT = 20;

export interface LocalMemoryNote {
  content: string;
  updatedAt: string;
}

export interface LocalMemoryEntry {
  kind: 'profile' | 'journal' | 'shared';
  key: string;
  content: string;
  createdAt: string;
}

export interface LocalMemoryFile {
  version: 1;
  notes: Record<string, LocalMemoryNote>;
  entries: LocalMemoryEntry[];
}

export function localMemoryPath(agentId: string): string {
  return `${MEMORY_DIR}/${agentId}.json`;
}

function emptyMemory(): LocalMemoryFile {
  return { version: 1, notes: {}, entries: [] };
}

function normalizeNote(value: unknown): LocalMemoryNote | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { content?: unknown; updatedAt?: unknown };
  if (typeof record.content !== 'string') return undefined;
  return {
    content: record.content.slice(0, MAX_CONTENT),
    updatedAt:
      typeof record.updatedAt === 'string'
        ? record.updatedAt
        : new Date(0).toISOString(),
  };
}

function normalizeEntry(value: unknown): LocalMemoryEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as {
    kind?: unknown;
    key?: unknown;
    content?: unknown;
    createdAt?: unknown;
  };
  if (typeof record.key !== 'string' || typeof record.content !== 'string') {
    return undefined;
  }
  const kind =
    record.kind === 'profile' || record.kind === 'shared'
      ? record.kind
      : 'journal';
  return {
    kind,
    key: record.key.slice(0, 120),
    content: record.content.slice(0, MAX_CONTENT),
    createdAt:
      typeof record.createdAt === 'string'
        ? record.createdAt
        : new Date(0).toISOString(),
  };
}

/** Разбирает файл памяти; битый JSON не роняет чат, а начинает память заново. */
export function parseLocalMemory(text: string | undefined): LocalMemoryFile {
  if (!text?.trim()) return emptyMemory();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyMemory();
  }
  if (!parsed || typeof parsed !== 'object') return emptyMemory();
  const record = parsed as {
    notes?: unknown;
    entries?: unknown;
  };
  const notes: Record<string, LocalMemoryNote> = {};
  if (record.notes && typeof record.notes === 'object') {
    for (const [key, value] of Object.entries(
      record.notes as Record<string, unknown>,
    )) {
      const note = normalizeNote(value);
      if (note && key.trim()) notes[key.slice(0, 120)] = note;
    }
  }
  const entries: LocalMemoryEntry[] = [];
  if (Array.isArray(record.entries)) {
    for (const value of record.entries) {
      const entry = normalizeEntry(value);
      if (entry) entries.push(entry);
    }
  }
  return { version: 1, notes, entries };
}

function trimMemory(file: LocalMemoryFile): LocalMemoryFile {
  const notes = Object.entries(file.notes);
  if (notes.length > MAX_NOTES) {
    notes.sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt));
    const kept = notes.slice(notes.length - MAX_NOTES);
    return {
      version: 1,
      notes: Object.fromEntries(kept),
      entries: file.entries.slice(-MAX_ENTRIES),
    };
  }
  return {
    version: 1,
    notes: file.notes,
    entries: file.entries.slice(-MAX_ENTRIES),
  };
}

function formatNotes(file: LocalMemoryFile): string {
  const notes = Object.entries(file.notes);
  if (notes.length === 0) return 'Память на компьютере пока пуста.';
  return notes
    .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
    .map(([key, note]) => `## ${key}\n${note.content}`)
    .join('\n\n');
}

function safeAgentId(agentId: string): string {
  const clean = agentId.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clean)) {
    throw new Error('Некорректный идентификатор агента для памяти');
  }
  return clean;
}

/**
 * Те же четыре инструмента памяти, но поверх файла в папке на компьютере.
 * Возвращает map «имя инструмента → обработчик» для подмены в turn.ts.
 */
export function localMemoryRuns(
  bridge: LocalFs,
  agentId: string,
): Record<string, (args: Record<string, unknown>) => Promise<string>> {
  const path = localMemoryPath(safeAgentId(agentId));
  const sharedPath = localMemoryPath(SHARED_AGENT);
  const guard = async (run: () => Promise<string>) => {
    try {
      return await run();
    } catch (error) {
      return error instanceof Error
        ? `Файл памяти на компьютере: ${error.message}`
        : 'Файл памяти на компьютере недоступен';
    }
  };
  const loadFile = async (filePath: string): Promise<LocalMemoryFile> => {
    const result = (await bridge.call('read', { path: filePath })) as {
      text?: string;
      missing?: boolean;
    };
    if (result.missing) return emptyMemory();
    return parseLocalMemory(result.text);
  };
  const saveFile = async (
    filePath: string,
    file: LocalMemoryFile,
  ): Promise<void> => {
    const next = trimMemory(file);
    await bridge.call('write', {
      path: filePath,
      content: JSON.stringify(next, null, 2),
    });
  };
  const load = (): Promise<LocalMemoryFile> => loadFile(path);
  const save = (file: LocalMemoryFile): Promise<void> => saveFile(path, file);
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : '';

  return {
    memory_read: (args) =>
      guard(async () => {
        const key = text(args.key).trim();
        const file = await load();
        if (!key) return formatNotes(file);
        const note = file.notes[key];
        return note ? note.content : `Заметки «${key}» нет.`;
      }),
    memory_write: (args) =>
      guard(async () => {
        const key = text(args.key).trim();
        const content = text(args.content);
        if (!key || key.length > 80) return 'Ключ заметки: 1–80 символов.';
        if (content.length > MAX_CONTENT) return 'Заметка слишком длинная.';
        const file = await load();
        file.notes[key] = { content, updatedAt: new Date().toISOString() };
        await save(file);
        return `Запомнил «${key}» (в папке на компьютере).`;
      }),
    remember: (args) =>
      guard(async () => {
        const content = text(args.content).trim();
        if (!content) return 'Пусто.';
        const requested = text(args.kind).trim();
        const kind =
          requested === 'profile' || requested === 'shared'
            ? requested
            : 'journal';
        const key = text(args.key).trim() || new Date().toISOString();
        const file = await load();
        const entry: LocalMemoryEntry = {
          kind,
          key,
          content: content.slice(0, MAX_CONTENT),
          createdAt: new Date().toISOString(),
        };
        if (kind === 'shared') {
          // Общие заметки видны всем агентам, поэтому лежат в одном файле.
          const shared = await loadFile(sharedPath);
          shared.entries = shared.entries.filter(
            (item) => !(item.kind === kind && item.key === key),
          );
          shared.entries.push(entry);
          await saveFile(sharedPath, shared);
          return `Запомнил (${kind}/${key}) в папке на компьютере (общая память).`;
        }
        if (kind === 'journal') {
          file.entries.push(entry);
        } else {
          file.entries = file.entries.filter(
            (item) => !(item.kind === kind && item.key === key),
          );
          file.entries.push(entry);
        }
        await save(file);
        return `Запомнил (${kind}/${key}) в папке на компьютере.`;
      }),
    recall: (args) =>
      guard(async () => {
        const needle = text(args.query).trim().toLowerCase();
        const file = await load();
        const shared = await loadFile(sharedPath);
        const entries = [...shared.entries, ...file.entries];
        const entryHits = entries
          .filter(
            (entry) =>
              !needle ||
              entry.content.toLowerCase().includes(needle) ||
              entry.key.toLowerCase().includes(needle),
          )
          .slice(-RECALL_LIMIT)
          .reverse()
          .map((entry) => `[${entry.kind}] ${entry.key}: ${entry.content}`);
        const noteHits = Object.entries(file.notes)
          .filter(
            ([key, note]) =>
              !needle ||
              note.content.toLowerCase().includes(needle) ||
              key.toLowerCase().includes(needle),
          )
          .slice(-RECALL_LIMIT)
          .map(([key, note]) => `[notes] ${key}: ${note.content}`);
        const lines = [...entryHits, ...noteHits].slice(0, RECALL_LIMIT);
        return lines.length ? lines.join('\n') : 'Ничего не найдено.';
      }),
  };
}
