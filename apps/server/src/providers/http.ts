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
  // NVIDIA отвечает 451 на запросы из России.
  'integrate.api.nvidia.com',
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

export async function llmFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal | null },
): Promise<Response> {
  const proxy = proxyFor(url);
  if (!proxy) return fetch(url, init);
  if (!cached || cached.url !== proxy)
    cached = { url: proxy, agent: new ProxyAgent(proxy) };
  // undici.fetch с прокси-агентом; ответ совместим с WHATWG Response.
  return (await undiciFetch(url, {
    ...(init as Record<string, unknown>),
    dispatcher: cached.agent,
  } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
}
