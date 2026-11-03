import fs from 'node:fs';
import path from 'node:path';
import {
  SECRET_MASK,
  type ClientEvent,
  type Locale,
  type McpServerConfigEntry,
  type McpServerInput,
  type McpServerPublic,
  type McpServersFile,
  type AgentInput,
  type ProviderInput,
  type RoutineInput,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODELS,
  type ProviderKind,
} from '@mayak/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppConfig } from './config';
import { isValidCron } from './cron';
import { type McpRow, Store, toPublicProvider } from './db';
import { HttpError, badRequest } from './errors';
import { McpManager } from './mcp/manager';
import { createClient, providerNeedsKey } from './providers/index';
import { runRoutineNow, startScheduler } from './scheduler';
import { SkillLibrary, seedSkills } from './skills';
import { AGENT_TEMPLATES } from './templates';
import { runTurn } from './turn';
import { asString, isRecord } from './util';

export interface AppHandle {
  app: Hono;
  close: () => Promise<void>;
  startScheduler: () => () => void;
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

  app.get('/api/agent-templates', (c) => c.json(AGENT_TEMPLATES));

  app.get('/api/agents', (c) => c.json(store.listAgents()));

  app.post('/api/agents', async (c) => {
    const input = parseAgentInput(await readBody(c), false);
    if (store.findAgentByName(input.name ?? '')) {
      throw badRequest('Агент с таким именем уже есть');
    }
    const defaults = defaultSelection(store);
    return c.json(
      store.insertAgent({
        ...input,
        name: input.name ?? 'Агент',
        providerId:
          input.providerId === undefined
            ? defaults.providerId
            : input.providerId,
        model: input.model === undefined ? defaults.model : input.model,
      }),
      201,
    );
  });

  app.get('/api/agents/:id', (c) => {
    const agent = store.getAgent(c.req.param('id'));
    if (!agent) return c.json({ error: 'Агент не найден' }, 404);
    return c.json(agent);
  });

  app.patch('/api/agents/:id', async (c) => {
    const current = store.getAgent(c.req.param('id'));
    if (!current) return c.json({ error: 'Агент не найден' }, 404);
    const input = parseAgentInput(await readBody(c), true);
    if (input.name && input.name.toLowerCase() !== current.name.toLowerCase()) {
      const taken = store.findAgentByName(input.name);
      if (taken && taken.id !== current.id)
        throw badRequest('Агент с таким именем уже есть');
    }
    const updated = store.updateAgent(current.id, input);
    return c.json(updated);
  });

  app.delete('/api/agents/:id', (c) => {
    if (store.listAgents().length <= 1) {
      return c.json({ error: 'Нельзя удалить последнего агента' }, 400);
    }
    const ok = store.deleteAgent(c.req.param('id'));
    if (!ok) return c.json({ error: 'Агент не найден' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/agents/:id/memory', (c) => {
    if (!store.getAgent(c.req.param('id')))
      return c.json({ error: 'Агент не найден' }, 404);
    return c.json(store.listMemory(c.req.param('id')));
  });

  app.put('/api/agents/:id/memory/:key', async (c) => {
    if (!store.getAgent(c.req.param('id')))
      return c.json({ error: 'Агент не найден' }, 404);
    const body = await readBody(c);
    if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
    return c.json(
      store.writeMemory(
        c.req.param('id'),
        decodeURIComponent(c.req.param('key')),
        asString(body.content),
      ),
    );
  });

  app.delete('/api/agents/:id/memory/:key', (c) => {
    const ok = store.deleteMemory(
      c.req.param('id'),
      decodeURIComponent(c.req.param('key')),
    );
    if (!ok) return c.json({ error: 'Заметка не найдена' }, 404);
    return c.json({ ok: true });
  });

  app.get('/api/agents/:id/routines', (c) => {
    if (!store.getAgent(c.req.param('id')))
      return c.json({ error: 'Агент не найден' }, 404);
    return c.json(store.listRoutines(c.req.param('id')));
  });

  app.post('/api/agents/:id/routines', async (c) => {
    if (!store.getAgent(c.req.param('id')))
      return c.json({ error: 'Агент не найден' }, 404);
    const input = parseRoutineInput(await readBody(c), false);
    if (!input.name || !input.cron || !input.prompt) {
      throw badRequest('Укажите название, cron и промпт');
    }
    return c.json(
      store.insertRoutine(c.req.param('id'), {
        name: input.name,
        cron: input.cron,
        prompt: input.prompt,
        enabled: input.enabled,
      }),
      201,
    );
  });

  app.patch('/api/agents/:id/routines/:routineId', async (c) => {
    const current = store.getRoutine(c.req.param('routineId'));
    if (!current || current.agentId !== c.req.param('id')) {
      return c.json({ error: 'Расписание не найдено' }, 404);
    }
    const input = parseRoutineInput(await readBody(c), true);
    return c.json(store.updateRoutine(current.id, input));
  });

  app.delete('/api/agents/:id/routines/:routineId', (c) => {
    const current = store.getRoutine(c.req.param('routineId'));
    if (!current || current.agentId !== c.req.param('id')) {
      return c.json({ error: 'Расписание не найдено' }, 404);
    }
    store.deleteRoutine(current.id);
    return c.json({ ok: true });
  });

  app.post('/api/agents/:id/routines/:routineId/run', async (c) => {
    const current = store.getRoutine(c.req.param('routineId'));
    if (!current || current.agentId !== c.req.param('id')) {
      return c.json({ error: 'Расписание не найдено' }, 404);
    }
    await runRoutineNow({ store, mcp, skills }, current.id);
    return c.json({ ok: true });
  });

  app.get('/api/conversations', (c) =>
    c.json(store.listConversations(c.req.query('agentId') || undefined)),
  );

  app.post('/api/conversations', async (c) => {
    const body = await readBody(c).catch(() => ({}));
    const record = isRecord(body) ? body : {};
    const locale: Locale = record.locale === 'en' ? 'en' : 'ru';
    const requestedAgent =
      typeof record.agentId === 'string'
        ? record.agentId
        : store.listAgents()[0]?.id;
    const agent = requestedAgent ? store.getAgent(requestedAgent) : undefined;
    if (!agent) throw badRequest('Агент не найден');
    const defaults = defaultSelection(store);
    const providerId =
      typeof record.providerId === 'string'
        ? record.providerId
        : (agent.providerId ?? defaults.providerId);
    const model =
      typeof record.model === 'string'
        ? record.model
        : (agent.model ?? defaults.model);
    const created = store.insertConversation({
      title: locale === 'en' ? 'New chat' : 'Новый чат',
      agentId: agent.id,
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
    if (!store.getConversation(c.req.param('id'))) {
      return c.json({ error: 'Чат не найден' }, 404);
    }
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
    return streamSSE(c, async (stream) => {
      const write = async (event: ClientEvent) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      };
      try {
        await runTurn(
          { store, mcp, skills },
          {
            conversationId: c.req.param('id'),
            content,
            locale,
            providerId:
              typeof body.providerId === 'string' ? body.providerId : undefined,
            model: typeof body.model === 'string' ? body.model : undefined,
            signal: c.req.raw.signal,
            onEvent: write,
          },
        );
        await write({ type: 'done' });
      } catch (error) {
        if (isAbort(error)) return;
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

  const deps = { store, mcp, skills };
  return {
    app,
    startScheduler: () => startScheduler(deps),
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
  ensureDefaultAgent(store, skills);
}

function ensureDefaultAgent(store: Store, skills: SkillLibrary): void {
  if (store.listAgents().length === 0) {
    const defaults = defaultSelection(store);
    store.insertAgent({
      name: 'Маяк',
      emoji: '🏮',
      description: 'Основной локальный ассистент',
      systemPrompt:
        'Ты — Маяк, локальный ассистент на компьютере пользователя. Отвечай на языке пользователя, коротко и по делу.',
      providerId: defaults.providerId,
      model: defaults.model,
      mcpServerIds: store.listMcp().map((item) => item.id),
      skillNames: skills.listEnabled().map((item) => item.name),
    });
  }
  const first = store.listAgents()[0];
  if (first) store.assignOrphanConversations(first.id);
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
  const created = store.insertProvider({
    name: 'DeepSeek',
    kind: 'deepseek',
    baseUrl: DEEPSEEK_BASE_URL,
    apiKey,
    models: [...DEEPSEEK_MODELS],
    enabled: true,
  });
  const agent = store.listAgents()[0];
  if (agent) {
    store.updateAgent(agent.id, {
      providerId: created.id,
      model: 'deepseek-chat',
    });
  }
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

function parseAgentInput(
  body: unknown,
  partial: boolean,
): AgentInput & { name?: string } {
  if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
  const name = body.name === undefined ? undefined : asString(body.name).trim();
  if (!partial && !name) throw badRequest('Укажите имя агента');
  if (name !== undefined && !name) throw badRequest('Укажите имя агента');
  if (name && name.length > 80) throw badRequest('Имя агента слишком длинное');
  const emoji =
    body.emoji === undefined
      ? undefined
      : asString(body.emoji).trim().slice(0, 8);
  const description =
    body.description === undefined
      ? undefined
      : asString(body.description).trim();
  const systemPrompt =
    body.systemPrompt === undefined ? undefined : asString(body.systemPrompt);
  if (systemPrompt && systemPrompt.length > 20_000)
    throw badRequest('Системный промпт слишком длинный');
  const mcpServerIds =
    body.mcpServerIds === undefined ? undefined : stringList(body.mcpServerIds);
  const skillNames =
    body.skillNames === undefined ? undefined : stringList(body.skillNames);
  return {
    name,
    emoji,
    description,
    systemPrompt,
    providerId:
      body.providerId === null
        ? null
        : typeof body.providerId === 'string'
          ? body.providerId
          : undefined,
    model:
      body.model === null
        ? null
        : typeof body.model === 'string'
          ? body.model
          : undefined,
    mcpServerIds,
    skillNames,
  };
}

function parseRoutineInput(body: unknown, partial: boolean): RoutineInput {
  if (!isRecord(body)) throw badRequest('Ожидался JSON-объект');
  const name = body.name === undefined ? undefined : asString(body.name).trim();
  const cron = body.cron === undefined ? undefined : asString(body.cron).trim();
  const prompt = body.prompt === undefined ? undefined : asString(body.prompt);
  if (!partial || body.name !== undefined) {
    if (!name) throw badRequest('Укажите название расписания');
  }
  if (!partial || body.cron !== undefined) {
    if (!cron || !isValidCron(cron)) {
      throw badRequest(
        'Нужно пять полей cron: минута час день месяц день-недели',
      );
    }
  }
  if (!partial || body.prompt !== undefined) {
    if (!prompt?.trim()) throw badRequest('Укажите промпт расписания');
  }
  if (prompt && prompt.length > 8_000)
    throw badRequest('Промпт расписания слишком длинный');
  return {
    name,
    cron,
    prompt,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) throw badRequest('Ожидался список строк');
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
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
