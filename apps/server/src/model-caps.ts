import type { ModelCaps } from '@mayak/shared';
import type { ProviderRow, Store } from './db';
import { createClient, providerNeedsKey } from './providers/index';
import { toolsUnsupported } from './providers/openai';
import type { LLMClient, ToolDefinition } from './providers/types';

/**
 * Проверка моделей: отвечает ли модель и умеет ли вызывать инструменты
 * (MCP, склад, поиск). Результаты — в настройке model_caps.
 */
const SETTING = 'model_caps';

const PROBE_TOOL: ToolDefinition = {
  name: 'stock_lookup',
  description: 'Look up stock in the warehouse by article. Наличие на складе.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Article or name' } },
    required: ['query'],
  },
};

type CapsMap = Record<string, Record<string, ModelCaps>>;

export async function readCaps(store: Store): Promise<CapsMap> {
  try {
    const raw = JSON.parse((await store.getSetting(SETTING)) ?? '{}');
    return raw && typeof raw === 'object' ? (raw as CapsMap) : {};
  } catch {
    return {};
  }
}

async function writeProviderCaps(
  store: Store,
  providerId: string,
  caps: Record<string, ModelCaps>,
): Promise<void> {
  const all = await readCaps(store);
  all[providerId] = caps;
  await store.setSetting(SETTING, JSON.stringify(all));
}

/** Лимит, таймаут, сеть — это не «модель не работает». */
function transient(message: string): boolean {
  return /429|rate|limit|quota|timeout|timed out|aborted|ECONN|ETIMEDOUT|fetch failed|сеть|прокси|503|502|504|overloaded|busy|частоту/i.test(
    message,
  );
}

async function run(
  client: LLMClient,
  model: string,
  tools: ToolDefinition[],
): Promise<{
  text: string;
  called: boolean;
  error?: string;
  noTools: boolean;
}> {
  let text = '';
  let called = false;
  let noTools = false;
  try {
    for await (const event of client.stream({
      model,
      messages: [
        {
          role: 'user',
          content: tools.length
            ? 'Call the stock_lookup tool with query "4G0". Do not answer in text.'
            : 'Reply with the single word: pong',
        },
      ],
      tools,
      signal: AbortSignal.timeout(60_000),
    })) {
      if (event.type === 'error')
        return { text, called, noTools, error: event.message };
      if (event.type === 'text') text += event.delta;
      if (
        event.type === 'reasoning' &&
        /не умеет вызывать инструменты/.test(event.delta)
      )
        noTools = true;
      if (event.type === 'tool_call_delta' && event.name) called = true;
    }
  } catch (error) {
    return {
      text,
      called,
      noTools,
      error: error instanceof Error ? error.message : 'Ошибка запроса',
    };
  }
  return { text, called, noTools };
}

export async function probeCaps(
  provider: ProviderRow,
  model: string,
): Promise<ModelCaps> {
  const checkedAt = new Date().toISOString();
  if (provider.kind === 'mock') return { ok: true, tools: true, checkedAt };
  if (providerNeedsKey(provider.kind, provider.baseUrl) && !provider.apiKey)
    return { ok: null, tools: null, checkedAt, error: 'Нет ключа' };
  const client = createClient(provider);
  const withTools = await run(client, model, [PROBE_TOOL]);
  if (withTools.called) return { ok: true, tools: true, checkedAt };
  if (!withTools.error)
    // Ответила, но инструмент не вызвала (или провайдер отказал и QASTOM AGENT повторил без них).
    return {
      ok: withTools.text.trim().length > 0 || withTools.noTools,
      tools: false,
      checkedAt,
    };
  const error = withTools.error.slice(0, 200);
  if (transient(error)) return { ok: null, tools: null, checkedAt, error };
  if (toolsUnsupported(error)) {
    const plain = await run(client, model, []);
    return {
      ok: plain.error ? (transient(plain.error) ? null : false) : true,
      tools: false,
      checkedAt,
      error: plain.error?.slice(0, 200),
    };
  }
  return { ok: false, tools: null, checkedAt, error };
}

const running = new Set<string>();

/** Проверяет все модели провайдера по очереди (бережём лимиты бесплатных API). */
export async function checkProviderModels(
  store: Store,
  provider: ProviderRow,
  options: {
    gapMs?: number;
    onModel?: (model: string, caps: ModelCaps) => void;
    /** Проверить только эти модели (остальные результаты сохраняются). */
    only?: string[];
  } = {},
): Promise<Record<string, ModelCaps>> {
  if (running.has(provider.id))
    return (await readCaps(store))[provider.id] ?? {};
  running.add(provider.id);
  try {
    const previous = (await readCaps(store))[provider.id] ?? {};
    const result: Record<string, ModelCaps> = {};
    const queue = options.only
      ? provider.models.filter((model) => options.only?.includes(model))
      : provider.models;
    for (const [index, model] of queue.entries()) {
      if (index > 0 && options.gapMs)
        await new Promise((r) => setTimeout(r, options.gapMs));
      const caps = await probeCaps(provider, model);
      // Временная ошибка не затирает прошлый хороший результат.
      result[model] =
        caps.ok === null &&
        previous[model]?.ok !== undefined &&
        previous[model]?.ok !== null
          ? { ...previous[model]!, error: caps.error }
          : caps;
      options.onModel?.(model, result[model]!);
      await writeProviderCaps(store, provider.id, { ...previous, ...result });
    }
    // Итог: прошлые результаты + новые, только для моделей, которые есть у провайдера.
    const merged: Record<string, ModelCaps> = {};
    for (const model of provider.models) {
      const item = result[model] ?? previous[model];
      if (item) merged[model] = item;
    }
    await writeProviderCaps(store, provider.id, merged);
    return merged;
  } finally {
    running.delete(provider.id);
  }
}

export function isChecking(providerId: string): boolean {
  return running.has(providerId);
}

const HOUR = 3_600_000;

/** Модели, которые пора проверить: не проверялись, давно проверялись или прошлый раз не ответили по времени. */
export function staleModels(
  provider: ProviderRow,
  caps: Record<string, ModelCaps>,
  now = Date.now(),
): string[] {
  return provider.models.filter((model) => {
    const item = caps[model];
    if (!item) return true;
    const age = now - Date.parse(item.checkedAt);
    if (item.ok === null) return age > HOUR;
    return age > 24 * HOUR;
  });
}

/** Фоновая проверка: через минуту после старта и дальше раз в 3 часа. */
export function startModelChecks(store: Store): () => void {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    const all = await readCaps(store);
    for (const provider of await store.listProviders()) {
      if (stopped) return;
      if (!provider.enabled || provider.kind === 'mock') continue;
      const only = staleModels(provider, all[provider.id] ?? {});
      if (only.length)
        await checkProviderModels(store, provider, { gapMs: 3000, only }).catch(
          () => undefined,
        );
    }
  };
  const first = setTimeout(() => void run(), 60_000);
  const timer = setInterval(() => void run(), 3 * HOUR);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
