import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors';
import { transcribeAudio } from '../src/transcribe';

const ENV_KEYS = ['WHISPER_URL', 'WHISPER_MODEL', 'WHISPER_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(handler: (call: FetchCall) => Response | undefined): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    const response = handler(call);
    return response ?? jsonResponse({});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('transcribeAudio: whisper.cpp', () => {
  it('ходит на /inference, передаёт язык и чистит пометки', async () => {
    process.env.WHISPER_URL = 'http://whisper.local:8080/';
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ text: ' [BLANK_AUDIO] привет [00:00.000] ' }),
    );

    const text = await transcribeAudio(Buffer.from('audio-bytes'), {
      convertToWav: false,
      fetchImpl,
      mime: 'audio/ogg',
      filename: 'voice.ogg',
      locale: 'ru',
    });

    expect(text).toBe('привет');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://whisper.local:8080/inference');
    const form = calls[0]?.init.body as FormData;
    expect(form.get('language')).toBe('ru');
    expect(form.get('response_format')).toBe('json');
    expect(form.has('model')).toBe(false);
    // convertToWav: false — отправляем исходный формат как есть.
    const file = form.get('file') as File;
    expect(file.name).toBe('voice.ogg');
    expect(file.type).toBe('audio/ogg');
  });

  it('по умолчанию отвечает "" на пустой текст', async () => {
    process.env.WHISPER_URL = 'http://whisper.local';
    const { fetchImpl } = recordingFetch(() => jsonResponse({ text: '   ' }));
    await expect(
      transcribeAudio(Buffer.from('audio'), {
        convertToWav: false,
        fetchImpl,
      }),
    ).resolves.toBe('');
  });

  it('возвращает "" если в ответе нет поля text', async () => {
    process.env.WHISPER_URL = 'http://whisper.local';
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));
    await expect(
      transcribeAudio(Buffer.from('audio'), {
        convertToWav: false,
        fetchImpl,
      }),
    ).resolves.toBe('');
  });
});

describe('transcribeAudio: OpenAI-совместимый режим', () => {
  it('ходит на /audio/transcriptions с моделью, ключом и языком en', async () => {
    process.env.WHISPER_URL = 'http://openai.local/v1';
    process.env.WHISPER_MODEL = 'large-v3';
    process.env.WHISPER_API_KEY = 'sk-test';
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ text: 'hello world' }),
    );

    const text = await transcribeAudio(Buffer.from('audio'), {
      convertToWav: false,
      fetchImpl,
      locale: 'en',
      mime: 'audio/wav',
    });

    expect(text).toBe('hello world');
    expect(calls[0]?.url).toBe('http://openai.local/v1/audio/transcriptions');
    expect(calls[0]?.init.headers).toEqual({
      authorization: 'Bearer sk-test',
    });
    const form = calls[0]?.init.body as FormData;
    expect(form.get('model')).toBe('large-v3');
    expect(form.get('language')).toBe('en');
  });

  it('использует whisper-1, если WHISPER_MODEL не задан', async () => {
    process.env.WHISPER_URL = 'http://openai.local/v1';
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ text: 'ok' }),
    );
    await transcribeAudio(Buffer.from('audio'), {
      convertToWav: false,
      fetchImpl,
    });
    const form = calls[0]?.init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
  });
});

describe('transcribeAudio: ошибки', () => {
  it('503 без WHISPER_URL', async () => {
    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toMatchObject({
      status: 503,
    });
    await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow(
      'Распознавание речи не настроено (WHISPER_URL)',
    );
  });

  it('502 при не-ok ответе сервиса', async () => {
    process.env.WHISPER_URL = 'http://whisper.local';
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ error: 'boom' }, 500),
    );
    const error = await transcribeAudio(Buffer.from('audio'), {
      convertToWav: false,
      fetchImpl,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(502);
    expect((error as HttpError).message).toBe(
      'Сервис распознавания не ответил',
    );
  });

  it('502 если fetch упал (нет сети)', async () => {
    process.env.WHISPER_URL = 'http://whisper.local';
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    await expect(
      transcribeAudio(Buffer.from('audio'), {
        convertToWav: false,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});
