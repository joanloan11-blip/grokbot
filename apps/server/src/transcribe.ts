import { spawn } from 'node:child_process';
import { HttpError } from './errors';

/** Настройки распознавания речи. */
export interface TranscribeOptions {
  /** Язык записи: по умолчанию русский. */
  locale?: 'ru' | 'en';
  /** MIME-тип исходной записи (audio/webm, audio/ogg, …). */
  mime?: string;
  /** Имя файла для multipart-формы. */
  filename?: string;
  /** Внешний сигнал отмены; вместе с ним действует общий таймаут 180 с. */
  signal?: AbortSignal;
  /** Инъекция fetch для тестов; по умолчанию globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** false — не перекодировать в WAV (например, запись уже в поддерживаемом формате). */
  convertToWav?: boolean;
}

/** Таймаут запроса к сервису распознавания. */
const TRANSCRIBE_TIMEOUT_MS = 180_000;

/**
 * Переводит запись браузера/Telegram (webm/ogg) в WAV 16 кГц mono.
 * Если ffmpeg недоступен или не смог разобрать вход, промис отклоняется —
 * вызывающий код может отправить в распознавание исходные байты.
 */
export function toWav(input: Buffer): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error('ffmpeg failed'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/**
 * Распознаёт аудио через сервис, заданный WHISPER_URL.
 * - оканчивается на /v1 — OpenAI-совместимый endpoint /audio/transcriptions;
 * - иначе — whisper.cpp endpoint /inference.
 */
export async function transcribeAudio(
  raw: Buffer,
  options: TranscribeOptions = {},
): Promise<string> {
  const base = (process.env.WHISPER_URL ?? '').replace(/\/$/, '');
  if (!base)
    throw new HttpError(503, 'Распознавание речи не настроено (WHISPER_URL)');

  let audio = raw;
  let mime = options.mime || 'audio/webm';
  let filename =
    options.filename ||
    (options.mime?.startsWith('video/') ? 'voice.mp4' : 'voice.webm');

  if (options.convertToWav !== false) {
    const wav = await toWav(raw).catch(() => undefined);
    if (wav) {
      audio = wav;
      mime = 'audio/wav';
      filename = 'voice.wav';
    }
  }

  const form = new FormData();
  const headers: Record<string, string> = {};
  let url = `${base}/inference`;
  if (base.endsWith('/v1')) {
    // OpenAI-совместимый Whisper API.
    url = `${base}/audio/transcriptions`;
    form.append('model', process.env.WHISPER_MODEL || 'whisper-1');
    if (process.env.WHISPER_API_KEY)
      headers.authorization = `Bearer ${process.env.WHISPER_API_KEY}`;
  }
  form.append(
    'file',
    new Blob([new Uint8Array(audio)], { type: mime }),
    filename,
  );
  form.append('response_format', 'json');
  form.append('language', options.locale === 'en' ? 'en' : 'ru');

  const timeout = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: form,
    signal,
  }).catch(() => undefined);
  if (!response?.ok)
    throw new HttpError(502, 'Сервис распознавания не ответил');

  const data = (await response.json().catch(() => ({}))) as { text?: unknown };
  if (typeof data.text !== 'string') return '';
  // whisper.cpp иногда вставляет служебные пометки вида [BLANK_AUDIO], [00:00.000].
  return data.text.replace(/\[[^\]]*\]/g, '').trim();
}
