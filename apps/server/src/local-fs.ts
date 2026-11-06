import { randomUUID } from 'node:crypto';
import type { ClientEvent } from '@mayak/shared';
import { applyEdit, formatDiff, numberLines } from './workspace';

/**
 * Папка на компьютере пользователя. Файлы читает и пишет браузер (File System Access API):
 * сервер шлёт в поток чата запрос {type:'local_fs'}, браузер выполняет его в выбранной папке
 * и возвращает ответ на /api/local-fs/:id. Пока вкладка открыта — агент работает с файлами на Mac.
 */
export interface LocalFs {
  folder: string;
  call(op: string, args: Record<string, unknown>): Promise<unknown>;
}

const TIMEOUT_MS = 60_000;
const pending = new Map<
  string,
  {
    userId: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

export function createLocalFs(
  userId: string,
  folder: string,
  emit: (event: ClientEvent) => Promise<void>,
): LocalFs {
  return {
    folder,
    call: (op, args) =>
      new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              'Браузер не ответил: откройте вкладку QASTOM AGENT и разрешите доступ к папке.',
            ),
          );
        }, TIMEOUT_MS);
        pending.set(id, { userId, resolve, reject, timer });
        void emit({ type: 'local_fs', id, op, args }).catch(
          (error: unknown) => {
            clearTimeout(timer);
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }),
  };
}

/** Ответ браузера. Принимаем только от того же пользователя. */
export function resolveLocalFs(
  userId: string,
  id: string,
  body: { result?: unknown; error?: string },
): boolean {
  const item = pending.get(id);
  if (!item || item.userId !== userId) return false;
  pending.delete(id);
  clearTimeout(item.timer);
  if (body.error) item.reject(new Error(body.error));
  else item.resolve(body.result);
  return true;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** Инструменты рабочей папки поверх папки на компьютере. */
export function localWorkspaceRuns(
  bridge: LocalFs,
): Record<string, (args: Record<string, unknown>) => Promise<string>> {
  const guard = async (run: () => Promise<string>) => {
    try {
      return await run();
    } catch (error) {
      return error instanceof Error
        ? error.message
        : 'Ошибка папки на компьютере';
    }
  };
  const read = async (path: string) => {
    const result = (await bridge.call('read', { path })) as {
      text?: string;
      missing?: boolean;
    };
    return result;
  };
  return {
    workspace_list: (args) =>
      guard(async () =>
        String(await bridge.call('list', { path: str(args.path) || '.' })),
      ),
    workspace_read: (args) =>
      guard(async () => {
        const path = str(args.path);
        const file = await read(path);
        if (file.missing)
          return `Файла «${path}» нет в папке «${bridge.folder}».`;
        return numberLines(file.text ?? '', path, {
          offset: typeof args.offset === 'number' ? args.offset : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
      }),
    workspace_write: (args) =>
      guard(async () => {
        const path = str(args.path);
        const content = str(args.content);
        if (Buffer.byteLength(content) > 1_000_000) return 'Файл больше 1 МБ.';
        const result = (await bridge.call('write', { path, content })) as {
          before?: string;
          created?: boolean;
        };
        return formatDiff(
          path,
          result.before ?? '',
          content,
          Boolean(result.created),
        );
      }),
    workspace_edit: (args) =>
      guard(async () => {
        const path = str(args.path);
        const file = await read(path);
        if (file.missing) return `Файла «${path}» нет.`;
        const before = file.text ?? '';
        const edit = applyEdit(
          before,
          str(args.old),
          str(args.new),
          args.replace_all === true,
        );
        if ('error' in edit) return edit.error;
        await bridge.call('write', { path, content: edit.after });
        return formatDiff(path, before, edit.after, false);
      }),
    workspace_delete: (args) =>
      guard(async () => {
        const path = str(args.path);
        const result = (await bridge.call('delete', { path })) as {
          before?: string;
        };
        return result.before
          ? formatDiff(path, result.before, '', false)
          : `Удалено: ${path}`;
      }),
    workspace_search: (args) =>
      guard(async () =>
        String(
          await bridge.call('search', {
            query: str(args.query),
            path: str(args.path) || '.',
            regex: args.regex === true,
            glob: str(args.glob),
          }),
        ),
      ),
    workspace_glob: (args) =>
      guard(async () =>
        String(
          await bridge.call('glob', {
            pattern: str(args.pattern),
            path: str(args.path) || '.',
          }),
        ),
      ),
  };
}

/** В режиме «папка на компьютере» эти облачные инструменты не к месту. */
export const CLOUD_ONLY_TOOLS = [
  'shell',
  'run_code',
  'github_clone',
  'github_changes',
  'github_push',
  'workspace_download',
];
