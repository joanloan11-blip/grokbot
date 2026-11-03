import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_TITLES,
  SECRET_MASK,
  type ChatMessage,
  type ClientEvent,
  type Locale,
  type McpServerConfigEntry,
  type McpServerInput,
  type McpServerPublic,
  type McpServersFile,
  type ProviderInput,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODELS,
  type ProviderKind,
} from '@mayak/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runAgentLoop } from './agent/loop';
import type { AppConfig } from './config';
import { type McpRow, Store, toPublicProvider } from './db';
import { HttpError, badRequest } from './errors';
import { encodeMcpToolName, McpManager, type LiveTool } from './mcp/manager';
import { LOAD_SKILL_TOOL, buildSystemPrompt } from './prompt';
import { createClient, providerNeedsKey } from './providers/index';
import type { ModelMessage, ToolDefinition } from './providers/types';
import { SkillLibrary, seedSkills } from './skills';
import { asString, clampText, isRecord, jsonObject } from './util';

interface ExposedTool {
  definition: ToolDefinition;
  run: (args: Record<string, unknown>) => Promise<string>;
}

export interface AppHandle {
  app: Hono;
  close: () => Promise<void>;
}

const KINDS: readonly ProviderKind[] = [
  'openai',
  'deepseek',
  'anthropic',
  'gemini',
  'mock',
];

export async function createApp(config: AppConfig): Promise<AppHandle> {
  const store = new Store(config.dataDir);
  const skills = new SkillLibrary(path.join(config.dataDir, 'skills'));
  const mcp = new McpManager();
  seed(store, skills, config);
  ensureDeepSeek(store);

  for (const row of store.listMcp()) {
    if (row.enabled) await mcp.connect(row);
  }

  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.message }, error.status as 400 | 404 | 500);
    }
    console.error(error);
    return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
  });

  app.get('/api/health', (c) =>
    c.json({ ok: true, name: 'mayak', version: '0.1.0' }),
  );

  app.get('/api/providers', (c) =>
    c.json(store.listProviders().map(toPublicProvider)),
  );

  app.post('/api/providers', async (c) => {
    const input = parseProviderInput(await readBody(c));
    if (input.apiKey === SECRET_MASK) input.apiKey = undefined;
    const row = store.insertProvider(input);
    return c.json(toPublicProvider(row), 201);
  });

  app.patch('/api/providers/:id', async (c) => {
    const current = store.getProvider(c.req.param('id'));
    if (!current) return c.json({ error: 'Провайдер не найден' }, 404);
    const body = await readBody(c);
    const record = isRecord(body) ? body : {};
    const input = parseProviderInput(
      {
        ...record,
        name: record.name ?? current.name,
        kind: record.kind ?? current.kind,
      },
      true,
    );
    if (!input.apiKey || input.apiKey === SECRET_MASK) input.apiKey = undefined;
    const row = store.updateProvider(current.id, input);
    if (!row) return c.json({ error: 'Провайдер не найден' }, 404);
    return c.json(toPublicProvider(row));
  });

  app.delete('/api/providers/:id', (c) => {
    const ok = store.deleteProvider(c.req.param('id'));
    if (!ok) return c.json({ error: 'Провайдер не найден' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/providers/:id/test', async (c) => {
    const provider = store.getProvider(c.req.param('id'));
    if (!provider) return c.json({ error: 'Провайдер не найден' }, 404);
    if (providerNeedsKey(provider.kind) && !provider.apiKey)
      return c.json({ error: 'Сначала сохраните API-ключ' }, 400);
    const model = provider.models[0];
    if (!model) return c.json({ error: 'Добавьте хотя бы одну модель' }, 400);
    let preview = '';
    try {
      for await (const event of createClient(provider).stream({
        model,
        messages: [
          { role: 'user', content: 'Reply with the single word: pong' },
        ],
        tools: [],
        signal: AbortSignal.timeout(30_000),
      })) {
        if (event.type === 'error')
          return c.json({ ok: false, error: event.message }, 502);
        if (event.type === 'text') preview += event.delta;
        if (preview.length > 180) break;
      }
    } catch (error) {
      return c.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : 'Ошибка запроса',
        },
        502,
      );
    }
    return c.json({ ok: true, preview: preview.slice(0, 180) });
  });

  app.get('/api/mcp', (c) =>
    c.json(store.listMcp().map((row) => presentMcp(row, mcp))),
  );

  app.get('/api/mcp/config', (c) => c.json(toMcpFile(store.listMcp())));

  app.post('/api/mcp/import', async (c) => {
    const file = parseMcpFile(await readBody(c));
    for (const [name, entry] of Object.entries(file.mcpServers)) {
      const input = entryToInput(name, entry, store.getMcpByName(name));
      const saved = store.upsertMcp(input);
      if (saved.enabled) await mcp.connect(saved);
      else await mcp.disconnect(saved.id);
    }
    return c.json(store.listMcp().map((row) => presentMcp(row, mcp)));
  });

  app.post('/api/mcp', async (c) => {
    const input = parseMcpInput(await readBody(c));
    const saved = store.upsertMcp(input);
    if (saved.enabled) await mcp.connect(saved);
    return c.json(presentMcp(saved, mcp), 201);
  });

  app.patch('/api/mcp/:id', async (c) => {
    const current = store.getMcp(c.req.param('id'));
    if (!current) return c.json({ error: 'MCP-сервер не найден' }, 404);
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    if (typeof body.name === 'string' && body.name.trim() !== current.name) {
      throw badRequest(
        'Переименование MCP-сервера не поддерживается — удалите его и создайте заново.',
      );
    }
    const saved = store.upsertMcp(mergeMcp(current, body));
    if (saved.enabled) await mcp.connect(saved);
    else await mcp.disconnect(saved.id);
    return c.json(presentMcp(saved, mcp));
  });

  app.delete('/api/mcp/:id', async (c) => {
    const current = store.getMcp(c.req.param('id'));
    if (!current) return c.json({ error: 'MCP-сервер не найден' }, 404);
    await mcp.disconnect(current.id);
    store.deleteMcp(current.id);
    return c.json({ ok: true });
  });

  app.get('/api/skills', (c) =>
    c.json({ directory: skills.directory, skills: skills.list() }),
  );

  app.get('/api/skills/:name', (c) => {
    const skill = skills.get(c.req.param('name'));
    if (!skill) return c.json({ error: 'Навык не найден' }, 404);
    return c.json(skill);
  });

  app.put('/api/skills/:name', async (c) => {
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const saved = skills.save({
      name: c.req.param('name'),
      description: asString(body.description),
      enabled: body.enabled !== false,
      body: asString(body.body),
    });
    return c.json(saved);
  });

  app.delete('/api/skills/:name', (c) => {
    const ok = skills.remove(c.req.param('name'));
    if (!ok) return c.json({ error: 'Навык не найден' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/conversations', (c) => c.json(store.listConversations()));

  app.post('/api/conversations', async (c) => {
    const body = await readBody(c).catch(() => ({}));
    const record = isRecord(body) ? body : {};
    const locale: Locale = record.locale === 'en' ? 'en' : 'ru';
    const defaults = defaultSelection(store);
    const providerId =
      typeof record.providerId === 'string'
        ? record.providerId
        : defaults.providerId;
    const model =
      typeof record.model === 'string' ? record.model : defaults.model;
    const created = store.insertConversation({
      title: locale === 'en' ? 'New chat' : 'Новый чат',
      providerId,
      model,
    });
    return c.json(created, 201);
  });

  app.get('/api/conversations/:id', (c) => {
    const conversation = store.getConversation(c.req.param('id'));
    if (!conversation) return c.json({ error: 'Чат не найден' }, 404);
    return c.json({
      conversation,
      messages: store.listMessages(conversation.id),
    });
  });

  app.patch('/api/conversations/:id', async (c) => {
    const current = store.getConversation(c.req.param('id'));
    if (!current) return c.json({ error: 'Чат не найден' }, 404);
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    const title =
      typeof body.title === 'string'
        ? body.title.trim().slice(0, 120)
        : undefined;
    const providerId =
      typeof body.providerId === 'string' ? body.providerId : undefined;
    const model = typeof body.model === 'string' ? body.model : undefined;
    const updated = store.updateConversation(current.id, {
      title: title || undefined,
      providerId,
      model,
    });
    return c.json(updated);
  });

  app.delete('/api/conversations/:id', (c) => {
    const ok = store.deleteConversation(c.req.param('id'));
    if (!ok) return c.json({ error: 'Чат не найден' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/conversations/:id/messages', async (c) => {
    const conversation = store.getConversation(c.req.param('id'));
    if (!conversation) return c.json({ error: 'Чат не найден' }, 404);
    const body = await readBody(c);
    if (
      !isRecord(body) ||
      typeof body.content !== 'string' ||
      !body.content.trim()
    ) {
      throw badRequest('Пустое сообщение');
    }
    const content = body.content.trim();
    if (content.length > 32_000) throw badRequest('Сообщение слишком длинное');
    const locale: Locale = body.locale === 'en' ? 'en' : 'ru';
    const providerId =
      typeof body.providerId === 'string'
        ? body.providerId
        : conversation.providerId;
    const provider = providerId ? store.getProvider(providerId) : undefined;
    if (!provider?.enabled)
      return c.json({ error: 'Выберите включённую модель' }, 400);
    const requestedModel =
      typeof body.model === 'string' ? body.model : conversation.model;
    const model =
      requestedModel && provider.models.includes(requestedModel)
        ? requestedModel
        : provider.models[0];
    if (!model) return c.json({ error: 'У провайдера не задана модель' }, 400);
    if (providerNeedsKey(provider.kind) && !provider.apiKey) {
      return c.json(
        { error: 'Сохраните API-ключ провайдера в настройках' },
        400,
      );
    }

    store.updateConversation(conversation.id, {
      providerId: provider.id,
      model,
    });
    const isDefaultTitle = (DEFAULT_TITLES as readonly string[]).includes(
      conversation.title,
    );
    if (isDefaultTitle)
      store.updateConversation(conversation.id, { title: clampText(content) });
    const userMessage = store.insertMessage({
      conversationId: conversation.id,
      role: 'user',
      content,
    });
    const fresh = store.getConversation(conversation.id);

    return streamSSE(c, async (stream) => {
      const write = async (event: ClientEvent) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };
      let pending = '';
      let pendingReasoning = '';
      try {
        await write({ type: 'message', message: userMessage });
        if (fresh && fresh.title !== conversation.title)
          await write({ type: 'title', title: fresh.title });
        const exposed = exposeTools(mcp, skills);
        const history = store.listMessages(conversation.id).map(toModelMessage);
        await runAgentLoop({
          client: createClient(provider),
          model,
          messages: [
            {
              role: 'system',
              content: buildSystemPrompt(skills.listEnabled(), locale),
            },
            ...history,
          ],
          tools: exposed.map((tool) => tool.definition),
          signal: c.req.raw.signal,
          limitMessage:
            locale === 'en'
              ? 'Stopped: the agent step limit was reached.'
              : 'Остановлено: исчерпан лимит шагов агента.',
          executeTool: async (call) => {
            const tool = exposed.find(
              (item) => item.definition.name === call.name,
            );
            if (!tool) return `Неизвестный инструмент ${call.name}`;
            return tool.run(jsonObject(call.arguments));
          },
          onEvent: async (event) => {
            if (event.type === 'text') {
              pending += event.delta;
              await write({ type: 'text', delta: event.delta });
            } else if (event.type === 'reasoning') {
              pendingReasoning += event.delta;
              await write({ type: 'reasoning', delta: event.delta });
            } else if (event.type === 'tool_start') {
              await write({ type: 'tool_start', call: event.call });
            } else if (event.type === 'assistant') {
              pending = '';
              pendingReasoning = '';
              const saved = store.insertMessage({
                conversationId: conversation.id,
                role: 'assistant',
                content: event.content,
                toolCalls: event.toolCalls,
                reasoning: event.reasoning,
              });
              await write({ type: 'message', message: saved });
            } else if (event.type === 'tool_result') {
              const saved = store.insertMessage({
                conversationId: conversation.id,
                role: 'tool',
                content: event.content,
                toolCallId: event.call.id,
                toolName: event.call.name,
              });
              await write({ type: 'message', message: saved });
            }
          },
        });
        await write({ type: 'done' });
      } catch (error) {
        if (isAbort(error)) {
          if (pending.trim() || pendingReasoning.trim()) {
            store.insertMessage({
              conversationId: conversation.id,
              role: 'assistant',
              content: pending,
              reasoning: pendingReasoning || undefined,
            });
          }
          return;
        }
        const message =
          error instanceof Error ? error.message : 'Ошибка агента';
        await write({ type: 'error', message }).catch(() => undefined);
      }
    });
  });

  if (config.staticDir) {
    const root = path.resolve(config.staticDir);
    app.get('*', (c) => serveSpa(c, root));
  }

  app.notFound((c) => c.json({ error: 'Не найдено' }, 404));

  return {
    app,
    close: async () => {
      await mcp.disconnectAll();
      store.close();
    },
  };
}

function seed(store: Store, skills: SkillLibrary, config: AppConfig): void {
  if (!store.getSetting('seeded')) {
    if (store.listProviders().length === 0) {
      store.insertProvider({
        name: 'Демо',
        kind: 'mock',
        models: ['mock'],
        enabled: true,
        baseUrl: '',
      });
      const baseUrl = process.env.MAYAK_OPENAI_BASE_URL;
      const apiKey = process.env.MAYAK_OPENAI_API_KEY;
      const model = process.env.MAYAK_OPENAI_MODEL;
      if (baseUrl && apiKey && model) {
        store.insertProvider({
          name: process.env.MAYAK_OPENAI_NAME || 'OpenAI-compatible',
          kind: 'openai',
          baseUrl,
          apiKey,
          models: [model],
          enabled: true,
        });
      }
    }
    if (store.listMcp().length === 0 && fs.existsSync(config.demoServerPath)) {
      store.upsertMcp({
        name: 'demo',
        transport: 'stdio',
        command: process.execPath,
        args: [config.demoServerPath],
        enabled: false,
      });
    }
    store.setSetting('seeded', '1');
  }
  seedSkills(skills.directory, config.examplesSkillsDir);
}

function ensureDeepSeek(store: Store): void {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return;
  const existing = store
    .listProviders()
    .find((item) => item.kind === 'deepseek');
  if (existing) {
    if (!existing.apiKey) store.updateProvider(existing.id, { apiKey });
    return;
  }
  store.insertProvider({
    name: 'DeepSeek',
    kind: 'deepseek',
    baseUrl: DEEPSEEK_BASE_URL,
    apiKey,
    models: [...DEEPSEEK_MODELS],
    enabled: true,
  });
}

function exposeTools(mcp: McpManager, skills: SkillLibrary): ExposedTool[] {
  const used = new Set<string>([LOAD_SKILL_TOOL.name]);
  const tools: ExposedTool[] = [
    {
      definition: {
        name: LOAD_SKILL_TOOL.name,
        description: LOAD_SKILL_TOOL.description,
        inputSchema: LOAD_SKILL_TOOL.inputSchema,
      },
      run: async (args) => {
        const name = asString(args.name).trim();
        if (!name) return 'Укажите имя навыка в поле name.';
        let skill: ReturnType<SkillLibrary['get']>;
        try {
          skill = skills.get(name);
        } catch (error) {
          return error instanceof Error
            ? error.message
            : 'Некорректное имя навыка';
        }
        if (!skill?.enabled) return `Навык «${name}» не найден или выключен.`;
        return [`# ${skill.name}`, skill.description, '', skill.body]
          .filter(Boolean)
          .join('\n');
      },
    },
  ];

  for (const server of mcp.listConnected()) {
    for (const tool of server.tools) {
      let name = encodeMcpToolName(server.name, tool.name);
      while (used.has(name)) name = `${name.slice(0, 60)}_${used.size}`;
      used.add(name);
      tools.push({
        definition: {
          name,
          description: `[MCP ${server.name}] ${tool.description || tool.name}`,
          inputSchema: normalizeSchema(tool),
        },
        run: (args) => mcp.callTool(server.id, tool.name, args),
      });
    }
  }
  return tools;
}

function normalizeSchema(tool: LiveTool): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (schema.type === 'object') return schema;
  return {
    type: 'object',
    properties: schema.properties ?? {},
    required: schema.required ?? [],
  };
}

function toModelMessage(message: ChatMessage): ModelMessage {
  return {
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    name: message.toolName,
  };
}

function defaultSelection(store: Store): {
  providerId: string | null;
  model: string | null;
} {
  const enabled = store
    .listProviders()
    .filter((item) => item.enabled && item.models.length > 0);
  const provider =
    enabled.find((item) => item.kind === 'deepseek') ?? enabled[0];
  if (!provider) return { providerId: null, model: null };
  const model = provider.models.includes('deepseek-chat')
    ? 'deepseek-chat'
    : provider.models[0];
  return { providerId: provider.id, model: model ?? null };
}

function presentMcp(row: McpRow, mcp: McpManager): McpServerPublic {
  const live = row.enabled
    ? mcp.snapshot(row.id)
    : { status: 'disconnected' as const, tools: [], error: undefined };
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    enabled: row.enabled,
    hasEnv: Object.keys(row.env).length > 0,
    hasHeaders: Object.keys(row.headers).length > 0,
    status: live.status,
    error: live.error,
    tools: live.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  };
}

function toMcpFile(rows: McpRow[]): McpServersFile {
  const mcpServers: McpServersFile['mcpServers'] = {};
  for (const row of rows) {
    const entry: McpServerConfigEntry = { enabled: row.enabled };
    if (row.transport === 'http') {
      entry.url = row.url;
      if (Object.keys(row.headers).length > 0) {
        entry.headers = Object.fromEntries(
          Object.keys(row.headers).map((key) => [key, SECRET_MASK]),
        );
      }
    } else {
      entry.command = row.command;
      entry.args = row.args;
      if (Object.keys(row.env).length > 0) {
        entry.env = Object.fromEntries(
          Object.keys(row.env).map((key) => [key, SECRET_MASK]),
        );
      }
    }
    mcpServers[row.name] = entry;
  }
  return { mcpServers };
}

async function readBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest('Некорректный JSON');
  }
}

function parseProviderInput(body: unknown, partial = false): ProviderInput {
  if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
  const kind = body.kind;
  if (!partial || kind !== undefined) {
    if (!isKind(kind))
      throw badRequest(
        'Тип провайдера: openai, deepseek, anthropic, gemini или mock',
      );
  }
  const name = asString(body.name).trim();
  if ((!partial || body.name !== undefined) && !name)
    throw badRequest('Укажите название провайдера');
  let models: string[] | undefined;
  if (Array.isArray(body.models))
    models = body.models.filter(
      (item): item is string => typeof item === 'string',
    );
  else if (typeof body.models === 'string') models = body.models.split(/[\n,]/);
  return {
    name: name || 'Провайдер',
    kind: isKind(kind) ? kind : 'openai',
    baseUrl: body.baseUrl === undefined ? undefined : asString(body.baseUrl),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    models,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  };
}

function isKind(value: unknown): value is ProviderKind {
  return (
    typeof value === 'string' && (KINDS as readonly string[]).includes(value)
  );
}

function parseMcpInput(body: unknown): McpServerInput {
  if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
  return entryToInput(asString(body.name), {
    command: asString(body.command) || undefined,
    args: Array.isArray(body.args)
      ? body.args.filter((item): item is string => typeof item === 'string')
      : undefined,
    env: isStringRecord(body.env) ? body.env : undefined,
    url: asString(body.url) || undefined,
    headers: isStringRecord(body.headers) ? body.headers : undefined,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  });
}

function parseMcpFile(body: unknown): McpServersFile {
  if (!isRecord(body) || !isRecord(body.mcpServers))
    throw badRequest('Ожидался объект { "mcpServers": { ... } }');
  const mcpServers: McpServersFile['mcpServers'] = {};
  for (const [name, entry] of Object.entries(body.mcpServers)) {
    if (!isRecord(entry)) throw badRequest(`Сервер «${name}»: ожидался объект`);
    mcpServers[name] = {
      command: typeof entry.command === 'string' ? entry.command : undefined,
      args: Array.isArray(entry.args)
        ? entry.args.filter((item): item is string => typeof item === 'string')
        : undefined,
      env: isStringRecord(entry.env) ? entry.env : undefined,
      url: typeof entry.url === 'string' ? entry.url : undefined,
      headers: isStringRecord(entry.headers) ? entry.headers : undefined,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
    };
  }
  return { mcpServers };
}

function entryToInput(
  name: string,
  entry: McpServerConfigEntry,
  existing?: McpRow,
): McpServerInput {
  const cleanName = name.trim();
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(cleanName)) {
    throw badRequest(
      `Имя MCP-сервера «${cleanName}» должно содержать латиницу, цифры, точку, «-» или «_».`,
    );
  }
  const transport = entry.url ? 'http' : 'stdio';
  if (transport === 'http') {
    try {
      const url = new URL(entry.url ?? '');
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('protocol');
    } catch {
      throw badRequest(`Сервер «${cleanName}»: нужен http(s) URL`);
    }
  } else if (!entry.command?.trim()) {
    throw badRequest(`Сервер «${cleanName}»: укажите command или url`);
  }
  return {
    name: cleanName,
    transport,
    command: entry.command?.trim() ?? '',
    args: entry.args ?? [],
    env: entry.env
      ? resolveSecrets(entry.env, existing?.env ?? {})
      : (existing?.env ?? {}),
    url: entry.url?.trim() ?? '',
    headers: entry.headers
      ? resolveSecrets(entry.headers, existing?.headers ?? {})
      : (existing?.headers ?? {}),
    enabled: entry.enabled ?? existing?.enabled ?? true,
  };
}

function mergeMcp(
  current: McpRow,
  body: Record<string, unknown>,
): McpServerInput {
  const entry: McpServerConfigEntry = {
    command: typeof body.command === 'string' ? body.command : current.command,
    args: Array.isArray(body.args)
      ? body.args.filter((item): item is string => typeof item === 'string')
      : current.args,
    url: typeof body.url === 'string' ? body.url : current.url,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
    env: isStringRecord(body.env) ? body.env : undefined,
    headers: isStringRecord(body.headers) ? body.headers : undefined,
  };
  if (typeof body.transport === 'string') {
    if (body.transport === 'http' && !entry.url)
      throw badRequest('Для HTTP-транспорта нужен url');
    if (body.transport === 'stdio') entry.url = undefined;
  }
  const name = typeof body.name === 'string' ? body.name : current.name;
  return entryToInput(name, entry, current);
}

function resolveSecrets(
  incoming: Record<string, string>,
  previous: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === SECRET_MASK && previous[key]) out[key] = previous[key];
    else if (value !== SECRET_MASK) out[key] = value;
  }
  return out;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'Запрос отменён')
  );
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serveSpa(c: Context, root: string) {
  const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(
    /^\/+/,
    '',
  );
  if (rel.includes('\0')) return c.notFound();
  const target = path.resolve(root, rel);
  const inside = target === root || target.startsWith(`${root}${path.sep}`);
  const file =
    inside && rel && fs.existsSync(target) && fs.statSync(target).isFile()
      ? target
      : path.join(root, 'index.html');
  if (!file.startsWith(root) || !fs.existsSync(file)) return c.notFound();
  const type =
    MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  return c.body(new Uint8Array(fs.readFileSync(file)), 200, {
    'Content-Type': type,
  });
}
