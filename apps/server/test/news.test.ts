import { describe, expect, it } from 'vitest';
import { formatNews, newsSearch, parseRss } from '../src/news';

const now = new Date().toUTCString();
const old = new Date(Date.now() - 5 * 86_400_000).toUTCString();
const gnews = `<rss><channel><title>Google Новости</title>
<item><title>Саммит в Женеве - РИА Новости</title><link>https://news.google.com/a</link><pubDate>${now}</pubDate><source url="https://ria.ru">РИА Новости</source></item>
<item><title>Старая новость - ТАСС</title><link>https://news.google.com/b</link><pubDate>${old}</pubDate><source url="https://tass.ru">ТАСС</source></item>
</channel></rss>`;

describe('news_search', () => {
  it('parses Google News RSS and keeps only fresh items', async () => {
    expect(parseRss(gnews)[0]).toMatchObject({
      title: 'Саммит в Женеве',
      source: 'РИА Новости',
    });
    let asked = '';
    const fake = (async (url: string) => {
      asked = url;
      return new Response(gnews);
    }) as never;
    const result = await newsSearch({ topic: 'world', fetchImpl: fake });
    expect(asked).toContain('topic/WORLD');
    expect(result.items).toHaveLength(1);
    expect(formatNews(result)).toContain('Саммит в Женеве — РИА Новости');
  });

  it('falls back to Russian RSS feeds when Google News is down', async () => {
    const fake = (async (url: string) => {
      if (url.includes('news.google.com')) throw new Error('blocked');
      return new Response(
        `<rss><item><title><![CDATA[Курс рубля вырос]]></title><link>https://ria.ru/x</link><pubDate>${now}</pubDate></item></rss>`,
      );
    }) as never;
    const result = await newsSearch({ query: 'курс рубля', fetchImpl: fake });
    expect(result.via).toMatch(/RSS/);
    expect(result.items[0]?.title).toBe('Курс рубля вырос');
  });
});
