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
        headersTimeout: HEADERS_TIMEOUT_MS,
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

/** Запрос к API модели: таймаут на ответ и один повтор при сетевой ошибке. */
export async function llmFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal | null },
): Promise<Response> {
  try {
    return await fetchOnce(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    // Сетевой сбой (оборванное соединение, таймаут) — пробуем ещё раз на новом соединении.
    await new Promise((resolve) =>
      setTimeout(resolve, process.env.VITEST ? 1 : 1500),
    );
    if (init.signal?.aborted) throw error;
    return fetchOnce(url, init);
  }
}
