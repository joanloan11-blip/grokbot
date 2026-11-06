import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SECRET_MASK,
  type ChatMessage,
  type ClientEvent,
  type McpServerPublic,
  type ProviderPublic,
} from '@mayak/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppHandle } from '../src/app';
import { loadConfig, repoRoot } from '../src/config';

let handle: AppHandle;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mayak-'));
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

async function demoProvider(): Promise<ProviderPublic> {
  const providers = (await (
    await handle.app.request('/api/providers')
  ).json()) as ProviderPublic[];
  const mock = providers.find((item) => item.kind === 'mock');
  if (!mock) throw new Error('demo provider missing');
  return mock;
}

async function demoConversation(): Promise<{ id: string }> {
  const mock = await demoProvider();
  return (await post('/api/conversations', {
    locale: 'ru',
    providerId: mock.id,
    model: mock.models[0] ?? 'mock',
  }).then((response) => response.json())) as { id: string };
}

async function readEvents(response: Response): Promise<ClientEvent[]> {
  const raw = await response.text();
  const events: ClientEvent[] = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((item) => item.startsWith('data:'));
    if (!line) continue;
    events.push(JSON.parse(line.slice(5).trim()) as ClientEvent);
  }
  return events;
}

describe('HTTP API', () => {
  it('answers health checks', async () => {
    const response = await handle.app.request('/api/health');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      name: 'mayak',
    });
  });

  it('never returns a saved API key', async () => {
    const created = await post('/api/providers', {
      name: 'OpenRouter',
      kind: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'super-secret-key',
      models: ['openai/gpt-4o-mini'],
    });
    expect(created.status).toBe(201);
    const provider = (await created.json()) as ProviderPublic;
    expect(provider.hasApiKey).toBe(true);
    expect(JSON.stringify(provider)).not.toContain('super-secret-key');

    const listed = (await (
      await handle.app.request('/api/providers')
    ).json()) as ProviderPublic[];
    expect(JSON.stringify(listed)).not.toContain('super-secret-key');

    const patched = await handle.app.request(`/api/providers/${provider.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'OpenRouter', apiKey: SECRET_MASK }),
    });
    const after = (await patched.json()) as ProviderPublic;
    expect(after.hasApiKey).toBe(true);
    expect(JSON.stringify(after)).not.toContain('super-secret-key');
  });

  it('streams a mock chat reply and keeps history', async () => {
    const mock = await demoProvider();
    const conversation = await demoConversation();
    const response = await post(
      `/api/conversations/${conversation.id}/messages`,
      {
        content: 'привет, маяк',
        locale: 'ru',
        providerId: mock.id,
        model: 'mock',
      },
    );
    expect(response.status).toBe(200);
    const events = await readEvents(response);
    const text = events
      .filter((event) => event.type === 'text')
      .map((event) => (event.type === 'text' ? event.delta : ''))
      .join('');
    expect(text).toContain('привет, маяк');
    expect(events.at(-1)?.type).toBe('done');

    const stored = (await (
      await handle.app.request(`/api/conversations/${conversation.id}`)
    ).json()) as {
      conversation: { title: string };
      messages: ChatMessage[];
    };
    expect(stored.conversation.title).toContain('привет');
    expect(
      stored.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.includes('привет, маяк'),
      ),
    ).toBe(true);
  });

  it('loads a skill through the agent loop', async () => {
    const conversation = await demoConversation();
    const events = await readEvents(
      await post(`/api/conversations/${conversation.id}/messages`, {
        content: 'skill summary',
      }),
    );
    const tool = events.find(
      (event) => event.type === 'message' && event.message.role === 'tool',
    );
    expect(
      tool && tool.type === 'message' ? tool.message.content : '',
    ).toContain('краткий пересказ');
    expect(
      events.some(
        (event) =>
          event.type === 'tool_start' && event.call.name === 'load_skill',
      ),
    ).toBe(true);
  });

  it('connects the bundled demo MCP server and runs echo', async () => {
    const servers = (await (
      await handle.app.request('/api/mcp')
    ).json()) as McpServerPublic[];
    const demo = servers.find((server) => server.name === 'demo');
    expect(demo).toBeTruthy();
    const enabled = (await (
      await handle.app.request(`/api/mcp/${demo?.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
    ).json()) as McpServerPublic;
    expect(enabled.status).toBe('connected');
    expect(enabled.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['echo', 'add']),
    );

    const conversation = await demoConversation();
    const events = await readEvents(
      await post(`/api/conversations/${conversation.id}/messages`, {
        content: 'echo ping-from-test',
      }),
    );
    const tool = events.find(
      (event) => event.type === 'message' && event.message.role === 'tool',
    );
    expect(
      tool && tool.type === 'message' ? tool.message.content : '',
    ).toContain('ping-from-test');
    const followUp = events
      .filter(
        (event) =>
          event.type === 'message' && event.message.role === 'assistant',
      )
      .at(-1);
    expect(
      followUp && followUp.type === 'message' ? followUp.message.content : '',
    ).toContain('ping-from-test');
  });

  it('shows a connector catalog instead of every MCP schema when there are many tools', async () => {
    await handle.runtime.store.setSetting('lazy_mcp_threshold', '0');
    const conversation = await demoConversation();
    const listed = await readEvents(
      await post(`/api/conversations/${conversation.id}/messages`, {
        content: 'tool connector_tools {"connector":"demo"}',
      }),
    );
    const schema = listed.find(
      (event) => event.type === 'message' && event.message.role === 'tool',
    );
    expect(
      schema && schema.type === 'message' ? schema.message.content : '',
    ).toContain('"name":"echo"');
    const called = await readEvents(
      await post(`/api/conversations/${conversation.id}/messages`, {
        content:
          'tool connector_call {"connector":"demo","tool":"echo","arguments":{"text":"lazy-ok"}}',
      }),
    );
    const result = called.find(
      (event) => event.type === 'message' && event.message.role === 'tool',
    );
    expect(
      result && result.type === 'message' ? result.message.content : '',
    ).toContain('lazy-ok');
    await handle.runtime.store.setSetting('lazy_mcp_threshold', '');
  });

  it('redacts MCP env values in the exported config', async () => {
    await post('/api/mcp/import', {
      mcpServers: {
        secretfs: {
          command: 'node',
          args: ['-e', 'process.exit(0)'],
          env: { API_TOKEN: 'token-should-stay-server-side' },
          enabled: false,
        },
      },
    });
    const file = (await (
      await handle.app.request('/api/mcp/config')
    ).json()) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(file.mcpServers.secretfs?.env?.API_TOKEN).toBe(SECRET_MASK);
    expect(JSON.stringify(file)).not.toContain('token-should-stay-server-side');
  });
});
