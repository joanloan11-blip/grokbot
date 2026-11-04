import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './db';
import { llmFetch } from './providers/http';
import { isRecord } from './util';

/**
 * Генерация и правка картинок через OpenAI Images API (gpt-image-*).
 * Провайдер — OpenAI-совместимый провайдер с ключом (по умолчанию первый на api.openai.com).
 */
export const IMAGE_MODEL_PREFERENCE = [
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
];
export const IMAGE_SIZES = [
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
] as const;
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'] as const;

export interface ImageSettings {
  enabled: boolean;
  providerId: string | null;
  model: string;
  quality: (typeof IMAGE_QUALITIES)[number];
  dailyLimit: number;
}

export async function readImageSettings(store: Store): Promise<ImageSettings> {
  // Картинки — только через общие ключи администратора.
  const providers = (await store.listProviders()).filter(
    (row) => !row.ownerUserId,
  );
  const saved = await store.getSetting('image_provider_id');
  const fallback = providers.find(
    (row) =>
      row.kind === 'openai' &&
      row.enabled &&
      row.apiKey &&
      /api\.openai\.com/.test(row.baseUrl),
  );
  const providerId =
    saved && providers.some((row) => row.id === saved)
      ? saved
      : (fallback?.id ?? null);
  const quality = (await store.getSetting('image_quality')) as
    | ImageSettings['quality']
    | undefined;
  const limit = Number(await store.getSetting('image_daily_limit'));
  return {
    // По умолчанию включено, если есть провайдер OpenAI с ключом.
    enabled:
      (await store.getSetting('images_enabled')) !== '0' && Boolean(providerId),
    providerId,
    model:
      (await store.getSetting('image_model')) || IMAGE_MODEL_PREFERENCE[0]!,
    quality:
      quality && (IMAGE_QUALITIES as readonly string[]).includes(quality)
        ? quality
        : 'medium',
    dailyLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20,
  };
}

function dayKey(userId: string): string {
  return `images_used:${userId}:${new Date().toISOString().slice(0, 10)}`;
}

export async function imagesUsedToday(
  store: Store,
  userId: string,
): Promise<number> {
  return Number((await store.getSetting(dayKey(userId))) ?? 0) || 0;
}

/** Генерирует (или правит по исходным картинкам) и возвращает PNG. */
export async function generateImage(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  sources?: { name: string; mime: string; bytes: Buffer }[];
  fetchImpl?: typeof llmFetch;
  /** Сколько токенов списал OpenAI (поле usage ответа). */
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  }) => void;
}): Promise<Buffer> {
  const base = (input.baseUrl || 'https://api.openai.com/v1').replace(
    /\/$/,
    '',
  );
  const doFetch = input.fetchImpl ?? llmFetch;
  const size = (IMAGE_SIZES as readonly string[]).includes(input.size ?? '')
    ? input.size!
    : 'auto';
  const quality = (IMAGE_QUALITIES as readonly string[]).includes(
    input.quality ?? '',
  )
    ? input.quality!
    : 'auto';
  let response: Response;
  if (input.sources?.length) {
    const form = new FormData();
    form.append('model', input.model);
    form.append('prompt', input.prompt);
    form.append('size', size);
    form.append('quality', quality);
    for (const source of input.sources.slice(0, 4)) {
      form.append(
        'image[]',
        new Blob([source.bytes], { type: source.mime }),
        source.name,
      );
    }
    response = await doFetch(`${base}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
  } else {
    response = await doFetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        size,
        quality,
        n: 1,
      }),
      signal: AbortSignal.timeout(180_000),
    });
  }
  const data = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const message =
      isRecord(data) &&
      isRecord(data.error) &&
      typeof data.error.message === 'string'
        ? data.error.message
        : `HTTP ${response.status}`;
    if (/safety|moderation|content_policy/i.test(message))
      throw new Error(
        'Генератор отказался рисовать по этому запросу (правила безопасности). Переформулируйте.',
      );
    throw new Error(`Генерация не удалась: ${message.slice(0, 300)}`);
  }
  if (isRecord(data) && isRecord(data.usage)) {
    const usage = data.usage;
    const details = isRecord(usage.input_tokens_details)
      ? usage.input_tokens_details
      : {};
    input.onUsage?.({
      inputTokens: Number(usage.input_tokens ?? 0) || 0,
      outputTokens: Number(usage.output_tokens ?? 0) || 0,
      cachedTokens: Number(details.cached_tokens ?? 0) || 0,
    });
  }
  const first =
    isRecord(data) && Array.isArray(data.data) ? data.data[0] : undefined;
  if (isRecord(first) && typeof first.b64_json === 'string')
    return Buffer.from(first.b64_json, 'base64');
  if (isRecord(first) && typeof first.url === 'string') {
    const image = await doFetch(first.url, {
      signal: AbortSignal.timeout(60_000),
    });
    return Buffer.from(await image.arrayBuffer());
  }
  throw new Error('Генератор не вернул картинку');
}

/** Полный цикл для инструмента агента: лимит → генерация → файл чата. */
export async function runImageTool(input: {
  store: Store;
  dataDir: string;
  userId: string;
  conversationId: string;
  prompt: string;
  size?: string;
  quality?: string;
  editAttached?: boolean;
  agentId?: string;
  fetchImpl?: typeof llmFetch;
}): Promise<string> {
  const settings = await readImageSettings(input.store);
  if (!settings.enabled || !settings.providerId)
    return 'Генерация картинок выключена: администратор должен подключить провайдера OpenAI (Настройки → Общие → Картинки).';
  const prompt = input.prompt.trim().slice(0, 4000);
  if (!prompt) return 'Опишите, что нарисовать (prompt).';
  const used = await imagesUsedToday(input.store, input.userId);
  if (used >= settings.dailyLimit)
    return `Дневной лимит картинок исчерпан (${settings.dailyLimit}). Завтра лимит обновится.`;
  const provider = await input.store.getProvider(settings.providerId);
  if (!provider?.apiKey) return 'У провайдера картинок нет API-ключа.';

  let sources: { name: string; mime: string; bytes: Buffer }[] | undefined;
  if (input.editAttached) {
    const messages = await input.store.listMessages(input.conversationId);
    const lastWithImages = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === 'user' &&
          message.attachments?.some((file) => file.mime.startsWith('image/')),
      );
    sources = [];
    for (const file of lastWithImages?.attachments ?? []) {
      if (!file.mime.startsWith('image/')) continue;
      const stored = await input.store.getUpload(file.id, input.userId);
      if (stored && fs.existsSync(stored.path))
        sources.push({
          name: stored.name,
          mime: stored.mime,
          bytes: fs.readFileSync(stored.path),
        });
    }
    if (!sources.length)
      return 'Чтобы изменить картинку, приложите её к сообщению.';
  }

  let png: Buffer;
  let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let exact = false;
  try {
    png = await generateImage({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: settings.model,
      prompt,
      size: input.size,
      quality: input.quality || settings.quality,
      sources,
      fetchImpl: input.fetchImpl,
      onUsage: (value) => {
        usage = value;
        exact = true;
      },
    });
  } catch (error) {
    return error instanceof Error ? error.message : 'Генерация не удалась';
  }
  await input.store.insertUsage({
    userId: input.userId,
    providerId: provider.id,
    model: settings.model,
    agentId: input.agentId ?? null,
    conversationId: input.conversationId,
    kind: 'image',
    exact,
    ...usage,
  });
  await input.store.setSetting(
    `images_used:${input.userId}:${new Date().toISOString().slice(0, 10)}`,
    String(used + 1),
  );

  const dir = path.join(input.dataDir, 'uploads', input.userId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `image-${Date.now()}.png`;
  const stored = path.join(dir, name);
  fs.writeFileSync(stored, png);
  const id = await input.store.insertUpload({
    userId: input.userId,
    conversationId: input.conversationId,
    name,
    mime: 'image/png',
    path: stored,
    text: '',
  });
  return `IMAGE:${JSON.stringify({ id, name, prompt: prompt.slice(0, 300), edited: Boolean(sources) })}`;
}
