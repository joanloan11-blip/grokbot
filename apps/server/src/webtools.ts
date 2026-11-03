import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

export function isBlockedAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::1' || host.endsWith('.local') || BLOCKED_HOSTS.has(host))
    return true;
  if (!isIP(host)) return false;
  const v4 = host.startsWith('::ffff:') ? host.slice(7) : host;
  const parts = v4.split('.').map((item) => Number(item));
  if (parts.length !== 4 || parts.some((item) => Number.isNaN(item))) {
    return (
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80')
    );
  }
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  return false;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Некорректный URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Разрешены только http и https');
  }
  if (url.username || url.password) throw new Error('URL с паролем запрещён');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedAddress(host) || host.endsWith('.local')) {
    throw new Error('Адрес во внутренней сети запрещён');
  }
  if (!isIP(host)) {
    const records = await lookup(host, { all: true });
    if (records.some((record) => isBlockedAddress(record.address))) {
      throw new Error('Адрес во внутренней сети запрещён');
    }
  }
  return url;
}

export function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<a [^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 20_000);
}

export async function webFetch(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let current = await assertPublicUrl(raw);
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: { 'user-agent': 'mayak' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Пустой редирект');
      current = await assertPublicUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > 1_000_000) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
    const html = Buffer.concat(chunks).toString('utf8');
    const type = response.headers.get('content-type') ?? '';
    return type.includes('html') ? htmlToMarkdown(html) : html.slice(0, 20_000);
  }
  throw new Error('Слишком много редиректов');
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(input: {
  query: string;
  provider: string;
  apiKey?: string;
  searxngUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<SearchHit[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const query = input.query.trim();
  if (!query) return [];
  if (input.provider === 'brave') {
    if (!input.apiKey) throw new Error('Нет ключа Brave');
    const response = await fetchImpl(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': input.apiKey,
        },
      },
    );
    if (!response.ok) throw new Error(`Brave HTTP ${response.status}`);
    const body = (await response.json()) as {
      web?: {
        results?: { title?: string; url?: string; description?: string }[];
      };
    };
    return (body.web?.results ?? []).slice(0, 5).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.description ?? '',
    }));
  }
  if (input.provider === 'tavily') {
    if (!input.apiKey) throw new Error('Нет ключа Tavily');
    const response = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: input.apiKey, query, max_results: 5 }),
    });
    if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
    const body = (await response.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };
    return (body.results ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.content ?? '',
    }));
  }
  const base = input.searxngUrl?.replace(/\/$/, '');
  if (!base)
    throw new Error('Поиск не настроен. Укажите SearXNG, Brave или Tavily.');
  await assertPublicUrl(base);
  const response = await fetchImpl(
    `${base}/search?q=${encodeURIComponent(query)}&format=json`,
    { headers: { Accept: 'application/json' } },
  );
  if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
  const body = (await response.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (body.results ?? []).slice(0, 5).map((item) => ({
    title: item.title ?? '',
    url: item.url ?? '',
    snippet: item.content ?? '',
  }));
}
