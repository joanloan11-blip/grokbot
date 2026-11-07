import fs from 'node:fs';
import path from 'node:path';
import {
  type Dispatcher,
  ProxyAgent,
  Socks5ProxyAgent,
  fetch as undiciFetch,
} from 'undici';

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

let cached: { url: string; agent: Dispatcher } | undefined;

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

function proxyAgent(proxy: string): Dispatcher {
  if (!cached || cached.url !== proxy) {
    const timeouts = {
      connectTimeout: 20_000,
      // Чуть дольше нашего таймера: пусть сработает он и даст понятную ошибку.
      headersTimeout: HEADERS_TIMEOUT_MS + 5_000,
      bodyTimeout: 120_000,
      // Короткий keep-alive: прокси молча рвёт простаивающие туннели.
      keepAliveTimeout: 4_000,
      keepAliveMaxTimeout: 10_000,
    };
    let agent: Dispatcher;
    if (/^socks5h?:\/\//i.test(proxy)) {
      // SOCKS5: логин и пароль — из адреса socks5://user:pass@host:port.
      const url = new URL(proxy.replace(/^socks5h:/i, 'socks5:'));
      agent = new Socks5ProxyAgent(`socks5://${url.host}`, {
        ...timeouts,
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
      });
    } else agent = new ProxyAgent({ uri: proxy, ...timeouts });
    cached = { url: proxy, agent };
  }
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
  // Самый частый сбой — тело больше лимита прокси: он молча обрывает запрос.
  const limit = proxyFor(url) ? PROXY_MAX_BODY : 0;
  console.warn(
    `[llm] нет ответа ${new URL(url).host} · ${codes.join(' → ')} · ${body.length} Б тела${
      limit && body.length > limit
        ? ` (лимит прокси ${limit} Б)`
        : limit
          ? ''
          : ' (без прокси)'
    } · ${Math.round(ms / 1000)} с`,
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
export const PROXY_MAX_BODY = Number(process.env.LLM_PROXY_MAX_BODY) || 16_000;

type Leaf = {
  holder: Record<string, unknown> | unknown[];
  key: string | number;
  length: number;
  age: number;
};

const roleOf = (message: unknown) => (message as { role?: string })?.role;

export function fitBody(
  body: Record<string, unknown>,
  max = PROXY_MAX_BODY,
): Record<string, unknown> {
  const before = Buffer.byteLength(JSON.stringify(body));
  const fitted = fitBodyInner(body, max);
  if (before > max) {
    const after = Buffer.byteLength(JSON.stringify(fitted));
    // Обрезка контекста объясняет «модель забыла, что видела» — фиксируем в журнале.
    console.warn(
      `[llm] тело ${before} Б ужато до ${after} Б (лимит прокси ${max} Б): часть истории и результатов инструментов отброшена`,
    );
  }
  return fitted;
}

function fitBodyInner(
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
  // Последний вопрос пользователя не трогаем; системный — тоже.
  const lastUser = () => {
    for (let i = list.length - 1; i >= 0; i--)
      if (roleOf(list[i]) === 'user') return i;
    return -1;
  };
  const collect = () => {
    const leaves: Leaf[] = [];
    const protectedIndex = lastUser();
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
    list.forEach((message, index) => {
      if (index === protectedIndex || roleOf(message) === 'system') return;
      walk(message, list, index, list.length - index);
    });
    // Старые и длинные — первыми.
    return leaves.sort((a, b) => b.age * b.length - a.age * a.length);
  };
  const cutAll = (keep: number, onlyOld = false) => {
    for (const leaf of collect()) {
      if (onlyOld && leaf.age <= 1) continue;
      const holder = leaf.holder as Record<string | number, unknown>;
      const value = holder[leaf.key];
      if (typeof value === 'string' && value.length > keep)
        holder[leaf.key] =
          `${value.slice(0, keep)}\n…[сокращено, было ${value.length} символов]`;
      if (size() <= max) return true;
    }
    return size() <= max;
  };
  const shortenTools = (limit: number) => {
    const tools = Array.isArray(body.tools)
      ? (body.tools as Record<string, unknown>[])
      : [];
    for (const tool of tools) {
      const fn = (tool.function ?? tool) as Record<string, unknown>;
      if (typeof fn.description === 'string' && fn.description.length > limit)
        fn.description = `${fn.description.slice(0, limit)}…`;
    }
    return size() <= max;
  };
  // Самый старый ход (от вопроса до следующего вопроса), кроме последнего.
  const dropOldestTurn = () => {
    const first = list.findIndex((message) => roleOf(message) !== 'system');
    const protectedIndex = lastUser();
    if (first < 0 || first >= protectedIndex) return false;
    let end = first + 1;
    while (end < protectedIndex && roleOf(list[end]) !== 'user') end++;
    list.splice(first, end - first);
    return true;
  };
  if (cutAll(1500, true)) return body;
  if (shortenTools(160)) return body;
  if (cutAll(3000)) return body;
  if (cutAll(800)) return body;
  if (shortenTools(60)) return body;
  while (size() > max && dropOldestTurn()) {}
  if (size() <= max) return body;
  cutAll(250);
  return body;
}
