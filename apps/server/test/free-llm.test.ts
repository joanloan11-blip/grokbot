import { describe, expect, it } from 'vitest';
import {
  freePriceFor,
  isKeylessUrl,
  normalizeCatalog,
  refreshFreeCatalog,
} from '../src/free-llm';
import snapshot from '../src/free-llm-catalog.json';
import { providerNeedsKey } from '../src/providers';
import { proxyFor } from '../src/providers/http';

const catalog = normalizeCatalog(snapshot);

describe('free LLM catalog', () => {
  it('normalizes the awesome-free-llm-apis snapshot', () => {
    expect(catalog?.providers.length).toBeGreaterThanOrEqual(10);
    const cohere = catalog?.providers.find((item) => item.name === 'Cohere');
    expect(cohere?.baseUrl).toBe('https://api.cohere.ai/compatibility/v1');
    expect(cohere?.viaProxy).toBe(true);
    expect(
      catalog?.providers.find((item) => item.name === 'Google Gemini')?.kind,
    ).toBe('gemini');
    const kilo = catalog?.providers.find((item) => item.name === 'Kilo Code');
    expect(kilo?.needsKey).toBe(false);
    for (const item of catalog?.providers ?? []) {
      expect(item.baseUrl.startsWith('https://')).toBe(true);
      expect(item.models.every((model) => model.id)).toBe(true);
    }
  });

  it('prices only catalog models as free', () => {
    if (!catalog) throw new Error('no catalog');
    expect(
      freePriceFor(
        catalog,
        'https://openrouter.ai/api/v1',
        'google/gemma-4-31b-it:free',
      ),
    ).toEqual({ input: 0, cached: 0, output: 0 });
    expect(
      freePriceFor(catalog, 'https://openrouter.ai/api/v1', 'openai/gpt-5.5'),
    ).toBeNull();
    expect(
      freePriceFor(
        catalog,
        'https://api.groq.com/openai/v1',
        'openai/gpt-oss-120b',
      ),
    ).not.toBeNull();
    expect(
      freePriceFor(catalog, 'https://integrate.api.nvidia.com/v1', 'anything'),
    ).not.toBeNull();
    expect(
      freePriceFor(catalog, 'https://api.openai.com/v1', 'gpt-5-mini'),
    ).toBeNull();
  });

  it('knows keyless providers and proxied hosts', () => {
    expect(isKeylessUrl('https://api.llm7.io/v1')).toBe(true);
    expect(providerNeedsKey('openai', 'https://api.llm7.io/v1')).toBe(false);
    expect(providerNeedsKey('openai', 'https://api.openai.com/v1')).toBe(true);
    process.env.LLM_PROXY_URL = 'http://u:p@127.0.0.1:1';
    expect(
      proxyFor('https://api.groq.com/openai/v1/chat/completions'),
    ).toBeDefined();
    expect(proxyFor('https://api.llm7.io/v1/chat/completions')).toBeUndefined();
    delete process.env.LLM_PROXY_URL;
  });

  it('refreshes only from the GitHub raw file and rejects junk', async () => {
    const settings = new Map<string, string>();
    const store = {
      getSetting: async (key: string) => settings.get(key),
      setSetting: async (key: string, value: string) =>
        void settings.set(key, value),
    } as never;
    let asked = '';
    const fake = (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify(snapshot));
    }) as never;
    const fresh = await refreshFreeCatalog(store, fake);
    expect(asked).toContain(
      'raw.githubusercontent.com/mnfst/awesome-free-llm-apis',
    );
    expect(fresh.providers.length).toBe(catalog?.providers.length);
    const junk = (async () => new Response('{"providers": 1}')) as never;
    await expect(refreshFreeCatalog(store, junk)).rejects.toThrow();
  });
});
