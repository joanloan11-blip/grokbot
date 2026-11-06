import type { ProviderRow, Store } from './db';
import { createClient } from './providers/index';
import type { ModelMessage } from './providers/types';

/**
 * Сжатие длинной истории: последние сообщения идут модели целиком,
 * всё, что раньше, — кратким пересказом. Пересказ кэшируется в настройке
 * chat_summary:<id> и дописывается по мере роста чата.
 */
const KEEP_MESSAGES = 14;
/** Сжимаем, только когда старая часть больше стольких символов (~3–4 тыс. токенов). */
const MIN_OLD_CHARS = 14_000;
const MAX_SUMMARY_INPUT = 60_000;

interface Cached {
  count: number;
  text: string;
}

const size = (messages: ModelMessage[]) =>
  messages.reduce((sum, item) => sum + item.content.length, 0);

/** Индекс начала «свежей» части: на сообщении пользователя, чтобы не разорвать вызов инструмента и его результат. */
export function cutIndex(
  history: ModelMessage[],
  keep = KEEP_MESSAGES,
): number {
  for (let index = history.length - keep; index > 0; index--)
    if (history[index]?.role === 'user') return index;
  return 0;
}

function transcript(messages: ModelMessage[]): string {
  return messages
    .map((item) => {
      const who =
        item.role === 'user'
          ? 'Пользователь'
          : item.role === 'assistant'
            ? 'Ассистент'
            : item.role === 'tool'
              ? `Инструмент ${item.name ?? ''}`.trim()
              : 'Система';
      const calls = item.toolCalls?.length
        ? ` [вызвал: ${item.toolCalls.map((call) => call.name).join(', ')}]`
        : '';
      return `${who}${calls}: ${item.content.slice(0, 4_000)}`;
    })
    .join('\n\n')
    .slice(-MAX_SUMMARY_INPUT);
}

async function summarize(
  provider: ProviderRow,
  model: string,
  previous: string,
  messages: ModelMessage[],
): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  exact: boolean;
}> {
  const client = createClient(provider);
  const prompt = [
    previous
      ? `Краткое содержание раньше:\n${previous}\n\nНовая часть разговора:`
      : 'Разговор:',
    transcript(messages),
  ].join('\n');
  let text = '';
  let inputTokens = Math.ceil(prompt.length / 4);
  let outputTokens = 0;
  let exact = false;
  for await (const event of client.stream({
    model,
    messages: [
      {
        role: 'system',
        content:
          'Сожми переписку в краткое содержание для продолжения работы. Сохрани: цели и задачи пользователя, принятые решения, важные факты, числа, имена, артикулы, ссылки, договорённости и что осталось сделать. Без вступлений, списком, не длиннее 300 слов, на языке разговора.',
      },
      { role: 'user', content: prompt },
    ],
    tools: [],
    signal: AbortSignal.timeout(90_000),
  })) {
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'text') text += event.delta;
    if (event.type === 'usage') {
      inputTokens = event.inputTokens;
      outputTokens = event.outputTokens;
      exact = true;
    }
  }
  if (!exact) outputTokens = Math.ceil(text.length / 4);
  return { text: text.trim(), inputTokens, outputTokens, exact };
}

export async function compactHistory(
  store: Store,
  input: {
    history: ModelMessage[];
    conversationId: string;
    provider: ProviderRow;
    model: string;
    userId: string;
    agentId: string;
  },
): Promise<ModelMessage[]> {
  const { history } = input;
  if (input.provider.kind === 'mock') return history;
  const cut = cutIndex(history);
  if (cut < 4) return history;
  const older = history.slice(0, cut);
  if (size(older) < MIN_OLD_CHARS) return history;
  const key = `chat_summary:${input.conversationId}`;
  let cached: Cached | null = null;
  try {
    cached = JSON.parse(
      (await store.getSetting(key)) ?? 'null',
    ) as Cached | null;
  } catch {
    cached = null;
  }
  let summary = cached && cached.count === cut ? cached.text : '';
  if (!summary) {
    // Дописываем к прошлому пересказу только новую часть; если историю правили — заново.
    const reuse = cached && cached.count < cut ? cached : null;
    try {
      const result = await summarize(
        input.provider,
        input.model,
        reuse?.text ?? '',
        older.slice(reuse?.count ?? 0),
      );
      if (!result.text) return history;
      summary = result.text;
      await store.setSetting(
        key,
        JSON.stringify({ count: cut, text: summary }),
      );
      await store.insertUsage({
        userId: input.userId,
        providerId: input.provider.id,
        model: input.model,
        agentId: input.agentId,
        conversationId: input.conversationId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        exact: result.exact,
      });
    } catch {
      // Не вышло сжать — отправим как есть, чат не должен ломаться.
      return history;
    }
  }
  return [
    {
      role: 'system',
      content: `Краткое содержание начала разговора (старые сообщения скрыты для экономии токенов):\n${summary}`,
    },
    ...history.slice(cut),
  ];
}
