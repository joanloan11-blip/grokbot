import http from 'node:http';
import type net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatMessage, ProviderPublic } from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';
import { runImageTool } from '../src/images';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let handle: AppHandle;
let dataDir: string;
let fake: http.Server;
let base = '';
const calls: { path: string; type: string; body: string }[] = [];

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-images-'));
  handle = await createApp(loadConfig({ dataDir, repoRoot }));
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      calls.push({
        path: req.url ?? '',
        type: String(req.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('latin1'),
      });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer sk-img') {
        res.statusCode = 401;
        res.end('{"error":{"message":"bad key"}}');
        return;
      }
      res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}/v1`;
});

afterAll(async () => {
  fake.close();
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

function send(method: string, pathname: string, body?: unknown) {
  return handle.app.request(pathname, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function chat(): Promise<string> {
  const providers = (await (
    await send('GET', '/api/providers')
  ).json()) as ProviderPublic[];
  const mock = providers.find((item) => item.kind === 'mock');
  const created = (await (
    await send('POST', '/api/conversations', {
      locale: 'ru',
      providerId: mock?.id,
      model: 'mock',
    })
  ).json()) as { id: string };
  return created.id;
}

async function toolResult(
  conversationId: string,
  command: string,
): Promise<string> {
  await (
    await send('POST', `/api/conversations/${conversationId}/messages`, {
      content: command,
      locale: 'ru',
    })
  ).text();
  const data = (await (
    await send('GET', `/api/conversations/${conversationId}`)
  ).json()) as {
    messages: ChatMessage[];
  };
  return (
    data.messages.filter((message) => message.role === 'tool').at(-1)
      ?.content ?? ''
  );
}

describe('image generation', () => {
  it('is off until an OpenAI provider is configured', async () => {
    const id = await chat();
    const result = await toolResult(
      id,
      'tool generate_image {"prompt":"маяк"}',
    );
    expect(result.startsWith('IMAGE:')).toBe(false);
  });

  it('generates an image, stores it and shows it in the chat', async () => {
    const provider = (await (
      await send('POST', '/api/providers', {
        name: 'OpenAI img',
        kind: 'openai',
        baseUrl: base,
        apiKey: 'sk-img',
        models: ['gpt-4o-mini'],
      })
    ).json()) as ProviderPublic;
    const saved = await send('PUT', '/api/admin/images', {
      providerId: provider.id,
      dailyLimit: 2,
    });
    expect(saved.status).toBe(200);

    const id = await chat();
    const result = await toolResult(
      id,
      'tool generate_image {"prompt":"Рекламная карточка рулевой рейки на белом фоне","size":"1024x1024"}',
    );
    expect(result.startsWith('IMAGE:')).toBe(true);
    const image = JSON.parse(result.slice(6)) as { id: string };
    const file = await send('GET', `/api/files/${image.id}`);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(50);
    const last = calls.at(-1);
    expect(last?.path).toBe('/v1/images/generations');
    expect(JSON.parse(last?.body ?? '{}')).toMatchObject({
      model: 'gpt-image-2',
      size: '1024x1024',
    });
  });

  it('edits the attached photo with multipart upload', async () => {
    const id = await chat();
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from(PNG_B64, 'base64')], { type: 'image/png' }),
      'rack.png',
    );
    const upload = (await (
      await handle.app.request(`/api/conversations/${id}/files`, {
        method: 'POST',
        body: form,
      })
    ).json()) as { id: string; name: string; mime: string };
    await handle.runtime.store.insertMessage({
      conversationId: id,
      role: 'user',
      content: 'Убери фон',
      attachments: [{ id: upload.id, name: upload.name, mime: upload.mime }],
    });
    const result = await runImageTool({
      store: handle.runtime.store,
      dataDir,
      userId: 'local',
      conversationId: id,
      prompt: 'Убери фон, оставь только рейку',
      editAttached: true,
    });
    expect(result.startsWith('IMAGE:')).toBe(true);
    expect(JSON.parse(result.slice(6)).edited).toBe(true);
    const last = calls.at(-1);
    expect(last?.path).toBe('/v1/images/edits');
    expect(last?.type).toContain('multipart/form-data');
    expect(last?.body).toContain('rack.png');
  });

  it('enforces the daily limit', async () => {
    const id = await chat();
    const result = await toolResult(
      id,
      'tool generate_image {"prompt":"ещё одна"}',
    );
    expect(result).toContain('лимит');
  });
});
