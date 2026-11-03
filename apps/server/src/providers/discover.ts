import {
  type DiscoverResult,
  type ProviderGuess,
  type ProviderKind,
  DEEPSEEK_BASE_URL,
  guessProviderFromModel,
  guessProvidersFromKey,
} from '@mayak/shared';
import type { ProviderRow } from '../db';
import { isRecord } from '../util';
import { llmFetch } from './http';

const TIMEOUT_MS = 15_000;

/** Модели, которые не подходят для чата (эмбеддинги, озвучка, картинки и т.п.). */
const NOT_CHAT =
  /(embed|embedding|whisper|tts|dall-e|davinci-00|babbage|moderation|transcribe|realtime|audio|image|search-preview|computer-use|aqa|imagen|veo|-001$)/i;

export function defaultBaseUrl(kind: ProviderKind): string {
  if (kind === 'deepseek') return DEEPSEEK_BASE_URL;
  if (kind === 'anthropic') return 'https://api.anthropic.com';
  if (kind === 'gemini')
    return 'https://generativelanguage.googleapis.com/v1beta';
  return 'https://api.openai.com/v1';
}

/** Список моделей провайдера. Бросает ошибку с понятным текстом. */
export async function listProviderModels(input: {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
}): Promise<string[]> {
  if (input.kind === 'mock') return ['mock'];
  const base = (input.baseUrl || defaultBaseUrl(input.kind)).replace(/\/$/, '');
  let url: string;
  const headers: Record<string, string> = {};
  if (input.kind === 'anthropic') {
    url = `${base.replace(/\/v1$/, '')}/v1/models?limit=100`;
    headers['x-api-key'] = input.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (input.kind === 'gemini') {
    url = `${base}/models?pageSize=200&key=${encodeURIComponent(input.apiKey)}`;
  } else {
    url = `${base.replace(/\/chat\/completions$/, '')}/models`;
    headers.authorization = `Bearer ${input.apiKey}`;
  }
  let response: Response;
  try {
    response = await llmFetch(url, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error('Провайдер не ответил (сеть или прокси)');
  }
  if (response.status === 401 || response.status === 403) {
    const text = await response.text().catch(() => '');
    if (/unsupported_country|region/i.test(text))
      throw new Error(
        'Провайдер недоступен из страны сервера — нужен LLM_PROXY_URL',
      );
    throw new Error('Ключ не подошёл к этому провайдеру');
  }
  if (!response.ok) throw new Error(`Провайдер ответил ${response.status}`);
  const data = (await response.json().catch(() => ({}))) as unknown;
  const ids: string[] = [];
  if (isRecord(data) && Array.isArray(data.data)) {
    for (const item of data.data)
      if (isRecord(item) && typeof item.id === 'string') ids.push(item.id);
  }
  if (isRecord(data) && Array.isArray(data.models)) {
    for (const item of data.models) {
      if (!isRecord(item) || typeof item.name !== 'string') continue;
      const methods = Array.isArray(item.supportedGenerationMethods)
        ? item.supportedGenerationMethods
        : [];
      if (methods.length && !methods.includes('generateContent')) continue;
      ids.push(item.name.replace(/^models\//, ''));
    }
  }
  const chat = ids.filter((id) => !NOT_CHAT.test(id));
  return [...new Set(chat.length ? chat : ids)]
    .sort(compareModels)
    .slice(0, 200);
}

/** Сначала новые и «основные» модели, потом остальные по алфавиту. */
function compareModels(a: string, b: string): number {
  const rank = (id: string) =>
    /(latest|preview|mini|flash|sonnet|chat|turbo)/i.test(id) ? 0 : 1;
  return rank(a) - rank(b) || b.localeCompare(a, 'en', { numeric: true });
}

/**
 * Определяет провайдера по ключу (или по именам моделей) и загружает модели.
 * Ключ, если не введён, берётся из уже сохранённого провайдера того же типа.
 */
export async function discoverProvider(input: {
  apiKey?: string;
  baseUrl?: string;
  kind?: ProviderKind;
  models?: string[];
  existing: ProviderRow[];
  currentId?: string;
}): Promise<DiscoverResult> {
  const typedKey = input.apiKey?.trim() ?? '';
  const current = input.currentId
    ? input.existing.find((row) => row.id === input.currentId)
    : undefined;

  // Кандидаты на тип провайдера.
  let candidates: ProviderGuess[] = [];
  if (input.kind && input.kind !== 'mock') {
    candidates = [
      {
        kind: input.kind,
        baseUrl: input.baseUrl?.trim() || defaultBaseUrl(input.kind),
        name: '',
      },
    ];
  } else if (typedKey) {
    candidates = guessProvidersFromKey(typedKey);
    if (input.baseUrl?.trim()) {
      // Свой адрес (Ollama, LM Studio, прокси-шлюз) — OpenAI-совместимый.
      const base = input.baseUrl.trim();
      const known = candidates.find((item) => item.baseUrl === base);
      candidates = known
        ? [known]
        : [{ kind: 'openai', baseUrl: base, name: '' }];
    }
    if (!candidates.length)
      candidates = [
        { kind: 'openai', baseUrl: defaultBaseUrl('openai'), name: '' },
      ];
  } else if (current) {
    candidates = [
      { kind: current.kind, baseUrl: current.baseUrl, name: current.name },
    ];
  } else {
    const byModel = (input.models ?? [])
      .map(guessProviderFromModel)
      .find(Boolean);
    if (byModel) candidates = [byModel];
  }
  if (!candidates.length)
    return {
      kind: 'openai',
      baseUrl: defaultBaseUrl('openai'),
      name: '',
      models: [],
      verified: false,
    };

  // Ключ: введённый → сохранённый у редактируемого → у другого провайдера того же типа.
  let keyFrom: DiscoverResult['keyFrom'];
  const keyFor = (guess: ProviderGuess): string => {
    if (typedKey) return typedKey;
    if (current?.apiKey && current.kind === guess.kind) return current.apiKey;
    const donor = input.existing.find(
      (row) =>
        row.id !== input.currentId &&
        row.kind === guess.kind &&
        row.apiKey &&
        (row.baseUrl || defaultBaseUrl(row.kind)).replace(/\/$/, '') ===
          (guess.baseUrl || defaultBaseUrl(guess.kind)).replace(/\/$/, ''),
    );
    if (donor) keyFrom = { providerId: donor.id, name: donor.name };
    return donor?.apiKey ?? '';
  };

  let lastError = '';
  for (const guess of candidates) {
    const apiKey = keyFor(guess);
    if (!apiKey) continue;
    try {
      const models = await listProviderModels({ ...guess, apiKey });
      return { ...guess, models, keyFrom, verified: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Ошибка';
      keyFrom = undefined;
    }
  }
  const first = candidates[0]!;
  return {
    ...first,
    models: [],
    keyFrom,
    verified: false,
    error: lastError || (typedKey ? undefined : 'Введите API-ключ'),
  };
}
