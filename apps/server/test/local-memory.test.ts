import { describe, expect, it } from 'vitest';
import type { LocalFs } from '../src/local-fs';
import { localMemoryPath, localMemoryRuns } from '../src/local-memory';

/** Фейковая папка на компьютере: держит файлы в Map. */
function fakeFolder(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const bridge = {
    folder: 'Тестовая папка',
    async call(op: string, args: Record<string, unknown>) {
      const path = typeof args.path === 'string' ? args.path : '';
      if (op === 'read') {
        return files.has(path) ? { text: files.get(path) } : { missing: true };
      }
      if (op === 'write') {
        const before = files.get(path);
        files.set(path, String(args.content ?? ''));
        return { before: before ?? '', created: before === undefined };
      }
      throw new Error(`Неизвестная операция ${op}`);
    },
  } as LocalFs;
  return { bridge, files };
}

const agent = 'agent-1';

describe('память в папке на компьютере', () => {
  it('пишет и читает заметки в файле .qastom/memory', async () => {
    const { bridge, files } = fakeFolder();
    const runs = localMemoryRuns(bridge, agent);

    expect(
      await runs.memory_write({ key: 'клиент', content: 'Иван, ООО Ромашка' }),
    ).toContain('Запомнил');
    expect(files.has(localMemoryPath(agent))).toBe(true);
    const saved = JSON.parse(files.get(localMemoryPath(agent)) ?? '{}') as {
      notes: Record<string, { content: string }>;
    };
    expect(saved.notes['клиент']?.content).toBe('Иван, ООО Ромашка');

    expect(await runs.memory_read({ key: 'клиент' })).toBe('Иван, ООО Ромашка');
    expect(await runs.memory_read({})).toContain('## клиент');
    expect(await runs.memory_read({ key: 'нет-такой' })).toContain('нет');
  });

  it('помнит профиль и журнал, ищет через recall', async () => {
    const { bridge } = fakeFolder();
    const runs = localMemoryRuns(bridge, agent);
    await runs.remember({
      kind: 'profile',
      key: 'стиль',
      content: 'Короткие ответы',
    });
    await runs.remember({
      kind: 'journal',
      key: '2026-11-08',
      content: 'Созвонились с Иваном',
    });
    const found = await runs.recall({ query: 'иван' });
    expect(found).toContain('[journal] 2026-11-08');
    expect(found.toLowerCase()).toContain('созвонились');
    expect(await runs.recall({ query: 'короткие' })).toContain(
      '[profile] стиль',
    );
    expect(await runs.recall({ query: 'абракадабра' })).toBe(
      'Ничего не найдено.',
    );
  });

  it('сохраняет память между сессиями и разбирает битый файл', async () => {
    const { bridge, files } = fakeFolder();
    await localMemoryRuns(bridge, agent).memory_write({
      key: 'a',
      content: 'b',
    });
    const again = localMemoryRuns(bridge, agent);
    expect(await again.memory_read({ key: 'a' })).toBe('b');

    files.set(localMemoryPath(agent), '{не json');
    const broken = localMemoryRuns(bridge, agent);
    expect(await broken.memory_read({})).toContain('пуста');
    await broken.memory_write({ key: 'c', content: 'd' });
    expect(await broken.memory_read({ key: 'c' })).toBe('d');
  });

  it('общие заметки kind=shared видны другому агенту', async () => {
    const { bridge } = fakeFolder();
    const first = localMemoryRuns(bridge, 'agent-1');
    const second = localMemoryRuns(bridge, 'agent-2');
    await first.remember({
      kind: 'shared',
      key: 'правило',
      content: 'Всегда отвечать по-русски',
    });
    const found = await second.recall({ query: 'русски' });
    expect(found).toContain('[shared] правило');
    expect(await second.memory_read({ key: 'правило' })).toContain('нет');
  });

  it('проверяет ключ и идентификатор агента', async () => {
    const { bridge } = fakeFolder();
    const runs = localMemoryRuns(bridge, agent);
    expect(await runs.memory_write({ key: '', content: 'x' })).toContain(
      'Ключ',
    );
    expect(
      await runs.memory_write({ key: 'k'.repeat(81), content: 'x' }),
    ).toContain('Ключ');
    expect(() => localMemoryRuns(bridge, '../evil')).toThrow();
  });
});
