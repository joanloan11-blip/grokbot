import type {
  FreeCatalog,
  FreeProvider,
  ModelPrice,
  ProviderKind,
} from '@mayak/shared';
import type { Store } from './db';
import snapshot from './free-llm-catalog.json';
import { isRecord } from './util';

/**
 * Каталог бесплатных LLM API из github.com/mnfst/awesome-free-llm-apis (CC0-1.0).
 * В Маяке лежит снимок data.json; администратор может обновить его с GitHub.
 */
export const FREE_CATALOG_URL =
  'https://raw.githubusercontent.com/mnfst/awesome-free-llm-apis/main/data.json';
export const FREE_CATALOG_SOURCE =
  'https://github.com/mnfst/awesome-free-llm-apis';

/** Поправки, чтобы адрес работал как OpenAI-совместимый в Маяке. */
const FIXES: Record<
  string,
  { baseUrl?: string; kind?: ProviderKind; needsKey?: boolean; note?: string }
> = {
  Cohere: { baseUrl: 'https://api.cohere.ai/compatibility/v1' },
  'Google Gemini': { kind: 'gemini' },
  'Z AI (Zhipu AI)': { baseUrl: 'https://api.z.ai/api/paas/v4' },
  'Cloudflare Workers AI': {
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    note: 'В адресе замените {account_id} на ID аккаунта Cloudflare.',
  },
  'Kilo Code': { needsKey: false },
  'LLM7.io': { needsKey: false },
  'OVHcloud AI Endpoints': { needsKey: false },
};

/** Хосты, которые из России отвечают 403/451 — к ним Маяк ходит через LLM_PROXY_URL. */
export const PROXY_HOSTS = [
  'api.cohere.ai',
  'api.groq.com',
  'api.kilo.ai',
  'openrouter.ai',
  'api.cloudflare.com',
  'integrate.api.nvidia.com',
];

function hostOf(url: string): string {
  try {
    return new URL(url.replace('{account_id}', 'x')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const squash = (text: string) =>
  text.toLowerCase().replace(/[^a-zа-я0-9]+/g, '');

const RISKY =
  /(train|log|real-name|identity|verification|non-commercial|trial|phone|Alibaba|mainland|EEA|regions)/i;

export function normalizeCatalog(raw: unknown): FreeCatalog | null {
  if (!isRecord(raw) || !Array.isArray(raw.providers)) return null;
  const footnotes = new Map<number, string>();
  if (Array.isArray(raw.footnotes))
    for (const item of raw.footnotes)
      if (
        isRecord(item) &&
        typeof item.id === 'number' &&
        typeof item.text === 'string'
      )
        footnotes.set(item.id, item.text);
  const providers: FreeProvider[] = [];
  for (const item of raw.providers) {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.baseUrl !== 'string'
    )
      continue;
    const fix = FIXES[item.name] ?? {};
    const baseUrl = (fix.baseUrl ?? item.baseUrl).replace(/\/$/, '');
    if (!/^https:\/\//.test(baseUrl)) continue;
    const description =
      typeof item.description === 'string' ? item.description : '';
    const footnote =
      typeof item.footnoteRef === 'number'
        ? footnotes.get(item.footnoteRef)
        : undefined;
    // Важное из сноски (логи, проверка личности, регионы); то, что уже есть в описании, не повторяем.
    const notes = [
      fix.note,
      ...(footnote ?? '')
        .split(/(?<=\.)\s+/)
        .filter((sentence) => RISKY.test(sentence))
        .map((sentence) =>
          sentence
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/`/g, '')
            .trim(),
        )
        .filter((sentence) => !squash(description).includes(squash(sentence)))
        .map((sentence) =>
          sentence.length > 180 ? `${sentence.slice(0, 177)}…` : sentence,
        ),
    ]
      .filter((note): note is string => Boolean(note))
      .slice(0, 3);
    const models = (Array.isArray(item.models) ? item.models : [])
      .filter(isRecord)
      .filter((model) => typeof model.id === 'string' && model.id)
      .filter((model) => !/embed|bge-|rerank/i.test(String(model.id)))
      .map((model) => ({
        id: String(model.id),
        context: typeof model.context === 'string' ? model.context : undefined,
        rateLimit:
          typeof model.rateLimit === 'string' ? model.rateLimit : undefined,
        modality:
          typeof model.modality === 'string' ? model.modality : undefined,
      }));
    providers.push({
      id: slug(item.name),
      name: item.name,
      country: typeof item.country === 'string' ? item.country : '',
      flag: typeof item.flag === 'string' ? item.flag : '',
      keyUrl:
        typeof item.url === 'string' && /^https:\/\//.test(item.url)
          ? item.url
          : '',
      baseUrl,
      kind: fix.kind ?? 'openai',
      needsKey: fix.needsKey !== false,
      description: description.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'),
      notes,
      viaProxy: PROXY_HOSTS.includes(hostOf(baseUrl)),
      models,
    });
  }
  return {
    lastUpdated: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : '',
    source: FREE_CATALOG_SOURCE,
    providers,
  };
}

const bundled = normalizeCatalog(snapshot) as FreeCatalog;

export async function readFreeCatalog(store: Store): Promise<FreeCatalog> {
  const saved = await store.getSetting('free_llm_catalog');
  if (saved) {
    try {
      const parsed = normalizeCatalog(JSON.parse(saved));
      if (parsed && parsed.providers.length) return parsed;
    } catch {
      // битый кэш — берём снимок
    }
  }
  return bundled;
}

/** Скачать свежий каталог с GitHub (только этот адрес). */
export async function refreshFreeCatalog(
  store: Store,
  fetchImpl: typeof fetch = fetch,
): Promise<FreeCatalog> {
  const response = await fetchImpl(FREE_CATALOG_URL, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub ответил ${response.status}`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('Каталог слишком большой');
  const parsed = normalizeCatalog(JSON.parse(text));
  if (!parsed || !parsed.providers.length)
    throw new Error('Каталог не распознан');
  await store.setSetting('free_llm_catalog', text);
  return parsed;
}

const FREE: ModelPrice = { input: 0, cached: 0, output: 0 };

/** Бесплатная ли эта модель у этого провайдера по каталогу (или NVIDIA целиком). */
export function freePriceFor(
  catalog: FreeCatalog,
  baseUrl: string,
  model: string,
): ModelPrice | null {
  const host = hostOf(baseUrl);
  if (!host) return null;
  if (host === 'integrate.api.nvidia.com') return FREE;
  const entry = catalog.providers.find((item) => hostOf(item.baseUrl) === host);
  if (!entry) return null;
  if (host === 'openrouter.ai')
    return model.endsWith(':free') || model === 'openrouter/free' ? FREE : null;
  return entry.models.some(
    (item) => item.id.toLowerCase() === model.toLowerCase(),
  )
    ? FREE
    : null;
}

export function isKeylessUrl(baseUrl: string): boolean {
  const host = hostOf(baseUrl);
  return bundled.providers.some(
    (item) => !item.needsKey && hostOf(item.baseUrl) === host,
  );
}
