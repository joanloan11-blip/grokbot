import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ChatMessage,
  ClientEvent,
  ProviderPublic,
  SearchHit,
} from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';
import { buildHistory, supportsVision } from '../src/turn';
import {
  editWorkspaceFile,
  listWorkspace,
  readWorkspaceFile,
  resolveInside,
  unifiedDiff,
  workspaceRoot,
  writeWorkspaceFile,
} from '../src/workspace';

let handle: AppHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-parity-'));
  handle = await createApp(loadConfig({ dataDir, repoRoot }));
});

afterAll(async () => {
  await handle.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function post(pathname: string, body: unknown): Promise<Response> {
  return handle.app.request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function conversation(): Promise<{ id: string }> {
  const providers = (await (
    await handle.app.request('/api/providers')
  ).json()) as ProviderPublic[];
  const mock = providers.find((item) => item.kind === 'mock');
  if (!mock) throw new Error('demo provider missing');
  return (await post('/api/conversations', {
    locale: 'ru',
    providerId: mock.id,
    model: mock.models[0] ?? 'mock',
  }).then((response) => response.json())) as { id: string };
}

async function events(response: Response): Promise<ClientEvent[]> {
  const out: ClientEvent[] = [];
  for (const block of (await response.text()).split('\n\n')) {
    const line = block.split('\n').find((item) => item.startsWith('data:'));
    if (line) out.push(JSON.parse(line.slice(5).trim()) as ClientEvent);
  }
  return out;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('workspace', () => {
  it('keeps paths inside the root', () => {
    const root = workspaceRoot(dataDir, 'u1', 'a1');
    expect(() => resolveInside(root, '../../etc/passwd')).toThrow();
    expect(() => resolveInside(root, '/../../x')).toThrow();
    expect(resolveInside(root, 'notes/a.txt').startsWith(root)).toBe(true);
  });

  it('writes, edits with a diff and lists files', () => {
    const root = workspaceRoot(dataDir, 'u1', 'a2');
    const created = writeWorkspaceFile(
      root,
      'src/app.py',
      'a = 1\nb = 2\nc = 3\n',
    );
    expect(created.startsWith('DIFF:')).toBe(true);
    expect(JSON.parse(created.slice(5)).created).toBe(true);
    const edited = editWorkspaceFile(root, 'src/app.py', 'b = 2', 'b = 20');
    const diff = JSON.parse(edited.slice(5)) as {
      added: number;
      removed: number;
      lines: string[];
    };
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines).toContain('+b = 20');
    expect(readWorkspaceFile(root, 'src/app.py')).toContain('b = 20');
    expect(listWorkspace(root)).toContain('src/app.py');
    expect(editWorkspaceFile(root, 'src/app.py', 'zzz', 'y')).toContain(
      'не найден',
    );
  });

  it('builds a compact unified diff', () => {
    const lines = unifiedDiff(
      '1\n2\n3\n4\n5\n6\n7\n8',
      '1\n2\n3\n4\nX\n6\n7\n8',
    );
    expect(lines).toEqual([' 3', ' 4', '-5', '+X', ' 6', ' 7']);
  });
});

describe('attachments and vision', () => {
  it('knows which providers see images', () => {
    expect(supportsVision('openai')).toBe(true);
    expect(supportsVision('anthropic')).toBe(true);
    expect(supportsVision('deepseek')).toBe(false);
    expect(supportsVision('mock')).toBe(false);
  });

  it('uploads an image, sends it with a message and expands history', async () => {
    const chat = await conversation();
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'dot.png');
    const upload = await handle.app.request(
      `/api/conversations/${chat.id}/files`,
      {
        method: 'POST',
        body: form,
      },
    );
    expect(upload.status).toBe(201);
    const file = (await upload.json()) as { id: string; mime: string };
    expect(file.mime).toBe('image/png');

    const docForm = new FormData();
    docForm.append(
      'file',
      new Blob(['план: купить рейку'], { type: 'text/plain' }),
      'plan.txt',
    );
    const doc = (await (
      await handle.app.request(`/api/conversations/${chat.id}/files`, {
        method: 'POST',
        body: docForm,
      })
    ).json()) as { id: string };

    const response = await post(`/api/conversations/${chat.id}/messages`, {
      content: '',
      attachments: [file.id, doc.id],
      locale: 'ru',
    });
    const list = await events(response);
    const user = list.find(
      (event): event is Extract<ClientEvent, { type: 'message' }> =>
        event.type === 'message' && event.message.role === 'user',
    );
    expect(user?.message.attachments?.map((item) => item.name)).toEqual([
      'dot.png',
      'plan.txt',
    ]);

    const stored = (await (
      await handle.app.request(`/api/conversations/${chat.id}`)
    ).json()) as {
      messages: ChatMessage[];
    };
    const vision = await buildHistory(
      handle.runtime.store,
      stored.messages,
      'openai',
    );
    const first = vision.find((message) => message.role === 'user');
    expect(first?.images?.[0]?.mime).toBe('image/png');
    expect(first?.content).toContain('план: купить рейку');

    const text = await buildHistory(
      handle.runtime.store,
      stored.messages,
      'deepseek',
    );
    expect(
      text.find((message) => message.role === 'user')?.images,
    ).toBeUndefined();
    expect(text.find((message) => message.role === 'user')?.content).toContain(
      'не видит картинки',
    );
  });

  it('rejects foreign or missing attachments', async () => {
    const chat = await conversation();
    const response = await post(`/api/conversations/${chat.id}/messages`, {
      content: 'hi',
      attachments: ['nope'],
      locale: 'ru',
    });
    expect(response.status).toBe(400);
  });
});

describe('search', () => {
  it('finds chats by message text', async () => {
    const chat = await conversation();
    await (
      await post(`/api/conversations/${chat.id}/messages`, {
        content: 'Уникальная фраза про маяк и рулевую рейку',
        locale: 'ru',
      })
    ).text();
    const hits = (await (
      await handle.app.request(
        `/api/search?q=${encodeURIComponent('РУЛЕВУЮ рейку')}`,
      )
    ).json()) as SearchHit[];
    expect(hits.some((hit) => hit.conversationId === chat.id)).toBe(true);
    expect(hits[0]?.snippet.toLowerCase()).toContain('рулевую рейку');
    const none = (await (
      await handle.app.request('/api/search?q=%25%25')
    ).json()) as SearchHit[];
    expect(none.every((hit) => hit.snippet.includes('%'))).toBe(true);
  });
});

describe('skills written by the agent', () => {
  it('saves a skill through skill_manage via the demo tool command', async () => {
    const chat = await conversation();
    const payload = JSON.stringify({
      action: 'create',
      name: 'weekly-report',
      description: 'Как собрать недельный отчёт',
      body: '1. Собрать продажи\n2. Сравнить с прошлой неделей',
    });
    await (
      await post(`/api/conversations/${chat.id}/messages`, {
        content: `tool skill_manage ${payload}`,
        locale: 'ru',
      })
    ).text();
    const file = path.join(dataDir, 'skills', 'weekly-report', 'SKILL.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain(
      'Сравнить с прошлой неделей',
    );
  });
});

describe('voice input', () => {
  it('forwards audio to whisper and returns text', async () => {
    const { createServer } = await import('node:http');
    let received = 0;
    const server = createServer((req, res) => {
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
      });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ text: ' купил рейку за 1250 рублей [музыка]' }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    process.env.WHISPER_URL = `http://127.0.0.1:${port}`;
    try {
      const form = new FormData();
      form.append(
        'file',
        new Blob([Buffer.alloc(2048, 1)], { type: 'audio/webm' }),
        'voice.webm',
      );
      const response = await handle.app.request('/api/transcribe?lang=ru', {
        method: 'POST',
        body: form,
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { text: string }).text).toBe(
        'купил рейку за 1250 рублей',
      );
      expect(received).toBeGreaterThan(1000);
    } finally {
      delete process.env.WHISPER_URL;
      server.close();
    }
  });

  it('reports when whisper is not configured', async () => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.alloc(10)], { type: 'audio/webm' }),
      'voice.webm',
    );
    const response = await handle.app.request('/api/transcribe', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(503);
  });
});
