import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * Запросы к API моделей. Если задан LLM_PROXY_URL (http://user:pass@host:port),
 * запросы к хостам из LLM_PROXY_HOSTS идут через этот прокси. Нужно, когда
 * провайдер (например, OpenAI) недоступен из страны сервера.
 */
const DEFAULT_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  // Закрыты для России (403/451), проверено с сервера qastom.
  'integrate.api.nvidia.com',
  'api.cohere.ai',
  'api.groq.com',
  'api.kilo.ai',
  'openrouter.ai',
  'api.cloudflare.com',
  // Google News RSS для инструмента news_search.
  'news.google.com',
];

let cached: { url: string; agent: ProxyAgent } | undefined;

export function proxyFor(target: string): string | undefined {
  const proxy = process.env.LLM_PROXY_URL?.trim();
  if (!proxy) return undefined;
  let host: string;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const list = (process.env.LLM_PROXY_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const hosts = list.length ? list : DEFAULT_HOSTS;
  const match = hosts.some(
    (item) => item === '*' || host === item || host.endsWith(`.${item}`),
  );
  return match ? proxy : undefined;
}

/** Сколько ждём заголовков ответа, прежде чем считать соединение зависшим. */
const HEADERS_TIMEOUT_MS = Number(process.env.LLM_HEADERS_TIMEOUT_MS) || 90_000;

function proxyAgent(proxy: string): ProxyAgent {
  if (!cached || cached.url !== proxy)
    cached = {
      url: proxy,
      // Короткий keep-alive: прокси молча рвёт простаивающие туннели, и запрос
      // в «мёртвое» соединение висел до 5 минут, пока undici не сдавался.
      agent: new ProxyAgent({
        uri: proxy,
        connectTimeout: 20_000,
        // Чуть дольше нашего таймера: пусть сработает он и даст понятную ошибку.
        headersTimeout: HEADERS_TIMEOUT_MS + 5_000,
        bodyTimeout: 120_000,
        keepAliveTimeout: 4_000,
        keepAliveMaxTimeout: 10_000,
      }),
    };
  return cached.agent;
}

async function fetchOnce(
  url: string,
  init: RequestInit & { signal?: AbortSignal | null },
): Promise<Response> {
  // Свой таймаут на заголовки: срабатывает и без прокси, снимается, как только ответ начался.
  const timer = new AbortController();
  const handle = setTimeout(
    () => timer.abort(new Error('timeout')),
    HEADERS_TIMEOUT_MS,
  );
  const signal = init.signal
    ? AbortSignal.any([init.signal, timer.signal])
    : timer.signal;
  try {
    const proxy = proxyFor(url);
    if (!proxy) return await fetch(url, { ...init, signal });
    // undici.fetch с прокси-агентом; ответ совместим с WHATWG Response.
    return (await undiciFetch(url, {
      ...(init as Record<string, unknown>),
      signal,
      dispatcher: proxyAgent(proxy),
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  } catch (error) {
    if (timer.signal.aborted && !init.signal?.aborted)
      throw new Error(
        `Провайдер не ответил за ${Math.round(HEADERS_TIMEOUT_MS / 1000)} с`,
      );
    throw error;
  } finally {
    clearTimeout(handle);
  }
}

/** Код ошибки undici/сети: ECONNRESET, UND_ERR_SOCKET, UND_ERR_HEADERS_TIMEOUT… */
function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })
    ?.cause;
  return (
    cause?.code ||
    cause?.message ||
    (error instanceof Error ? error.message : String(error))
  );
}

/** Запрос, который не прошёл дважды, сохраняем для разбора (без заголовков с ключом). */
function dumpFailed(
  url: string,
  init: RequestInit,
  codes: string[],
  ms: number,
): void {
  const dir = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'debug')
    : '';
  const body = typeof init.body === 'string' ? init.body : '';
  console.warn(
    `[llm] нет ответа ${new URL(url).host} · ${codes.join(' → ')} · ${body.length} Б тела · ${Math.round(ms / 1000)} с`,
  );
  if (!dir || !body) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('llm-failed-'))
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - 4)))
      fs.rmSync(path.join(dir, old), { force: true });
    fs.writeFileSync(
      path.join(dir, `llm-failed-${Date.now()}.json`),
      JSON.stringify({ url, codes, ms, body: JSON.parse(body) }),
    );
  } catch {
    // разбор — не главное
  }
}

/** Запрос к API модели: таймаут на ответ и один повтор при сетевой ошибке. */
export async function llmFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal | null },
): Promise<Response> {
  const started = Date.now();
  try {
    return await fetchOnce(url, init);
  } catch (first) {
    if (init.signal?.aborted) throw first;
    // Сетевой сбой (оборванное соединение, таймаут) — пробуем ещё раз на новом соединении.
    await new Promise((resolve) =>
      setTimeout(resolve, process.env.VITEST ? 1 : 1500),
    );
    if (init.signal?.aborted) throw first;
    try {
      return await fetchOnce(url, init);
    } catch (second) {
      if (init.signal?.aborted) throw second;
      const codes = [errorCode(first), errorCode(second)];
      dumpFailed(url, init, codes, Date.now() - started);
      throw new Error(
        `Провайдер не ответил (${codes.at(-1)}). Повторите запрос или выберите другую модель.`,
      );
    }
  }
}

/**
 * Прокси LLM_PROXY_URL рвёт запросы с телом больше ~30 КБ (проверено: 16 КБ проходит,
 * 32 КБ и больше — обрыв на любом сайте). Пока прокси такой, ужимаем тело запроса:
 * сначала старые длинные результаты инструментов и сообщения, потом описания инструментов.
 */
export const PROXY_MAX_BODY = Number(process.env.LLM_PROXY_MAX_BODY) || 20_000;

type Leaf = {
  holder: Record<string, unknown> | unknown[];
  key: string | number;
  length: number;
  age: number;
};

export function fitBody(
  body: Record<string, unknown>,
  max = PROXY_MAX_BODY,
): Record<string, unknown> {
  const size = () => Buffer.byteLength(JSON.stringify(body));
  if (size() <= max) return body;
  const list = (
    Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.contents)
        ? body.contents
        : []
  ) as unknown[];
  // Строки внутри всех сообщений, кроме последнего (вопрос пользователя или свежий результат) и системного.
  const leaves: Leaf[] = [];
  const walk = (
    node: unknown,
    holder: Leaf['holder'],
    key: Leaf['key'],
    age: number,
  ) => {
    if (typeof node === 'string') {
      if (node.length > 400)
        leaves.push({ holder, key, length: node.length, age });
      return;
    }
    if (Array.isArray(node))
      node.forEach((item, i) => walk(item, node, i, age));
    else if (node && typeof node === 'object')
      for (const [k, v] of Object.entries(node as Record<string, unknown>))
        walk(v, node as Record<string, unknown>, k, age);
  };
  list.slice(0, -1).forEach((message, index) => {
    const role = (message as { role?: string })?.role;
    if (role === 'system') return;
    walk(message, list, index, list.length - index);
  });
  const cut = (leaf: Leaf, keep: number) => {
    const holder = leaf.holder as Record<string | number, unknown>;
    const value = holder[leaf.key];
    if (typeof value !== 'string' || value.length <= keep) return;
    holder[leaf.key] =
      `${value.slice(0, keep)}\n…[сокращено, было ${value.length} символов]`;
  };
  // Старые и длинные — первыми.
  leaves.sort((a, b) => b.age * b.length - a.age * a.length);
  for (const keep of [1500, 600, 200]) {
    for (const leaf of leaves) {
      cut(leaf, keep);
      if (size() <= max) return body;
    }
  }
  // Описания инструментов короче.
  const tools = Array.isArray(body.tools)
    ? (body.tools as Record<string, unknown>[])
    : [];
  for (const tool of tools) {
    const fn = (tool.function ?? tool) as Record<string, unknown>;
    if (typeof fn.description === 'string' && fn.description.length > 120)
      fn.description = `${fn.description.slice(0, 120)}…`;
  }
  if (size() <= max) return body;
  // Последнее средство — самые старые сообщения целиком (системное и последнее остаются).
  while (size() > max && list.length > 3) {
    const index = list.findIndex(
      (message, i) =>
        i > 0 &&
        i < list.length - 2 &&
        (message as { role?: string })?.role !== 'system',
    );
    if (index < 0) break;
    list.splice(index, 1);
    // Ответ инструмента без вызова OpenAI не примет — убираем осиротевшие.
    while ((list[index] as { role?: string })?.role === 'tool')
      list.splice(index, 1);
  }
  return body;
}
