import type { Agent, Locale } from '@mayak/shared';
import { runTurn, type TurnDeps } from './turn';

/**
 * Оркестратор: агент раздаёт независимые подзадачи другим агентам (или копиям себя),
 * они работают параллельно в отдельных чатах, результаты возвращаются вместе.
 * Вложенность — один уровень: субагенты сами никого не зовут.
 */
export const DELEGATE_LIMITS = {
  maxTasks: 6,
  concurrency: 3,
  timeoutMs: 5 * 60_000,
  resultChars: 6_000,
};

export interface DelegateTask {
  agent?: string;
  title?: string;
  task: string;
}

export interface DelegateResult {
  agent: string;
  emoji: string;
  title: string;
  status: 'done' | 'error' | 'timeout';
  result: string;
  conversationId: string | null;
  seconds: number;
}

export function normalizeTasks(raw: unknown): DelegateTask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object',
    )
    .map((item) => ({
      agent: typeof item.agent === 'string' ? item.agent.trim() : undefined,
      title:
        typeof item.title === 'string'
          ? item.title.trim().slice(0, 80)
          : undefined,
      task:
        typeof item.task === 'string' ? item.task.trim().slice(0, 8_000) : '',
    }))
    .filter((item) => item.task);
}

/** Запускает fn для элементов с ограничением параллельности, сохраняя порядок. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export async function runDelegation(
  deps: TurnDeps,
  input: {
    from: Agent;
    userId: string;
    conversationId: string;
    depth: number;
    locale: Locale;
    tasks: DelegateTask[];
    signal?: AbortSignal;
  },
): Promise<string> {
  if (input.depth > 0)
    return 'Субагент не может раздавать задачи дальше. Выполни задачу сам.';
  const tasks = input.tasks.slice(0, DELEGATE_LIMITS.maxTasks);
  if (!tasks.length) return 'Передайте tasks: список { agent, title, task }.';
  const owner = await deps.store.getUser(input.userId);
  const reachable = owner
    ? await deps.store.listAgentsFor(owner)
    : await deps.store.listAgents();
  const parent = await deps.store.getConversation(input.conversationId);

  const results = await mapLimit(
    tasks,
    DELEGATE_LIMITS.concurrency,
    async (item, index) => {
      const started = Date.now();
      const wanted = (item.agent ?? '').toLowerCase();
      const target =
        !wanted || wanted === 'self' || wanted === input.from.name.toLowerCase()
          ? input.from
          : reachable.find(
              (agent) =>
                agent.name.toLowerCase() === wanted || agent.id === item.agent,
            );
      const title = item.title || `Подзадача ${index + 1}`;
      if (!target) {
        return {
          agent: item.agent ?? '?',
          emoji: '❔',
          title,
          status: 'error',
          result: `Агент «${item.agent}» не найден. Доступны: ${reachable.map((agent) => agent.name).join(', ')}.`,
          conversationId: null,
          seconds: 0,
        } satisfies DelegateResult;
      }
      const chat = await deps.store.insertConversation({
        title: `Подзадача: ${title}`.slice(0, 120),
        agentId: target.id,
        userId: input.userId,
        providerId: target.providerId,
        model: target.model,
        projectId: parent?.projectId ?? null,
      });
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        DELEGATE_LIMITS.timeoutMs,
      );
      const onParentAbort = () => controller.abort();
      input.signal?.addEventListener('abort', onParentAbort);
      try {
        const result = await runTurn(deps, {
          conversationId: chat.id,
          content: [
            `Задача от агента-оркестратора «${input.from.name}».`,
            '',
            item.task,
            '',
            'Сделай только эту часть и верни результат: кратко, по делу, с фактами и цифрами. Если данных не хватает — так и скажи.',
          ].join('\n'),
          locale: input.locale,
          userId: input.userId,
          depth: input.depth + 1,
          signal: controller.signal,
        });
        const timedOut = controller.signal.aborted && !input.signal?.aborted;
        return {
          agent: target.name,
          emoji: target.emoji,
          title,
          status: timedOut ? 'timeout' : 'done',
          result: (result.text.trim() || '(пустой ответ)').slice(
            0,
            DELEGATE_LIMITS.resultChars,
          ),
          conversationId: chat.id,
          seconds: Math.round((Date.now() - started) / 1000),
        } satisfies DelegateResult;
      } catch (error) {
        return {
          agent: target.name,
          emoji: target.emoji,
          title,
          status: controller.signal.aborted ? 'timeout' : 'error',
          result: error instanceof Error ? error.message : 'Ошибка подзадачи',
          conversationId: chat.id,
          seconds: Math.round((Date.now() - started) / 1000),
        } satisfies DelegateResult;
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onParentAbort);
      }
    },
  );
  return `DELEGATE:${JSON.stringify({ results })}`;
}
