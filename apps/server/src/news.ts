import { llmFetch } from './providers/http';

/**
 * Свежие новости: Google News RSS (через LLM_PROXY_URL — из России напрямую не открывается),
 * запасной вариант — RSS РИА, ТАСС и Ленты. Обычный web_search для новостей плох:
 * SearXNG без новостных движков отдаёт главные страницы сайтов, а не статьи.
 */
export const NEWS_TOPICS = {
  top: '',
  world: 'WORLD',
  russia: 'NATION',
  business: 'BUSINESS',
  technology: 'TECHNOLOGY',
  science: 'SCIENCE',
  health: 'HEALTH',
  sports: 'SPORTS',
} as const;

export type NewsTopic = keyof typeof NEWS_TOPICS;

export interface NewsItem {
  title: string;
  source: string;
  url: string;
  published: string;
}

const FALLBACK_FEEDS: Record<string, string[]> = {
  world: [
    'https://ria.ru/export/rss2/world/index.xml',
    'https://tass.ru/rss/v2.xml',
  ],
  business: ['https://ria.ru/export/rss2/economy/index.xml'],
  default: [
    'https://ria.ru/export/rss2/archive/index.xml',
    'https://lenta.ru/rss/news',
    'https://tass.ru/rss/v2.xml',
  ],
};

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function parseRss(xml: string, fallbackSource = ''): NewsItem[] {
  const items: NewsItem[] = [];
  for (const block of xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? []) {
    const tag = (name: string) => {
      const match = block.match(
        new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`),
      );
      return match ? decode(match[1] ?? '') : '';
    };
    let title = tag('title');
    const source = tag('source') || fallbackSource;
    // У Google News заголовок заканчивается « - Источник».
    const dash = title.lastIndexOf(' - ');
    if (source && dash > 0 && title.slice(dash + 3) === source)
      title = title.slice(0, dash);
    const date = new Date(tag('pubDate'));
    items.push({
      title,
      source,
      url: tag('link'),
      published: Number.isNaN(date.getTime()) ? '' : date.toISOString(),
    });
  }
  return items.filter((item) => item.title && item.url);
}

export async function newsSearch(input: {
  query?: string;
  topic?: NewsTopic;
  period?: 'day' | 'week';
  limit?: number;
  fetchImpl?: typeof llmFetch;
}): Promise<{ items: NewsItem[]; via: string }> {
  const doFetch = input.fetchImpl ?? llmFetch;
  const period = input.period === 'week' ? '7d' : '1d';
  const query = (input.query ?? '').trim().slice(0, 200);
  const topic = NEWS_TOPICS[input.topic ?? 'top'] ?? '';
  const locale = 'hl=ru&gl=RU&ceid=RU:ru';
  const url = query
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${period}`)}&${locale}`
    : topic
      ? `https://news.google.com/rss/headlines/section/topic/${topic}?${locale}`
      : `https://news.google.com/rss?${locale}`;
  const since = Date.now() - (input.period === 'week' ? 7 : 1.5) * 86_400_000;
  const fresh = (items: NewsItem[]) =>
    items
      .filter((item) => !item.published || Date.parse(item.published) >= since)
      .sort((a, b) => (b.published > a.published ? 1 : -1))
      .slice(0, input.limit ?? 12);
  try {
    const response = await doFetch(url, {
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) {
      const items = fresh(parseRss(await response.text()));
      if (items.length) return { items, via: 'Google News' };
    }
  } catch {
    // запасной вариант ниже
  }
  const feeds = FALLBACK_FEEDS[input.topic ?? ''] ?? FALLBACK_FEEDS.default!;
  const all: NewsItem[] = [];
  for (const feed of feeds) {
    try {
      const response = await doFetch(feed, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      all.push(
        ...parseRss(
          await response.text(),
          new URL(feed).hostname.replace(/^www\./, ''),
        ),
      );
    } catch {
      // следующий источник
    }
  }
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 3);
  const matched = words.length
    ? all.filter((item) =>
        words.some((word) => item.title.toLowerCase().includes(word)),
      )
    : all;
  return {
    items: fresh(matched.length ? matched : all),
    via: 'RSS (РИА, ТАСС, Лента)',
  };
}

export function formatNews(result: { items: NewsItem[]; via: string }): string {
  if (!result.items.length) return 'Свежих новостей не нашлось.';
  const when = (iso: string) =>
    iso
      ? new Date(iso).toLocaleString('ru-RU', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Yekaterinburg',
        })
      : '';
  return [
    `Новости (${result.via}), время — Екатеринбург:`,
    ...result.items.map(
      (item) =>
        `- ${item.title} — ${item.source}${item.published ? `, ${when(item.published)}` : ''}\n  ${item.url}`,
    ),
  ].join('\n');
}
