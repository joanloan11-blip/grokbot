import fs from 'node:fs';
import path from 'node:path';
import type {
  Agent,
  Attachment,
  ChatMessage,
  ClientEvent,
  Locale,
  ProviderKind,
} from '@mayak/shared';
import { runAgentLoop } from './agent/loop';
import type { Store, UserRecord } from './db';
import { isValidCron } from './cron';
import { HttpError, badRequest } from './errors';
import {
  encodeMcpToolName,
  type LiveTool,
  type McpManager,
} from './mcp/manager';
import { LOAD_SKILL_TOOL, buildSystemPrompt } from './prompt';
import { createClient, providerNeedsKey } from './providers/index';
import type {
  LLMClient,
  ModelMessage,
  ToolDefinition,
} from './providers/types';
import { readGithubToken, runGithubTool } from './github/tools';
import { runSandboxed } from './sandbox';
import { webFetch, webSearch } from './webtools';
import { decryptSecret } from './github/secret';
import type { SkillLibrary } from './skills';
import { asString, clampText, jsonObject } from './util';
import {
  deleteWorkspaceFile,
  editWorkspaceFile,
  listWorkspace,
  readWorkspaceFile,
  runWorkspaceShell,
  workspaceRoot,
  writeWorkspaceFile,
} from './workspace';

export interface TurnDeps {
  store: Store;
  mcp: McpManager;
  skills: SkillLibrary;
  jwtSecret?: string;
  onRoutineFinished?: (
    userId: string,
    name: string,
    text: string,
  ) => Promise<void>;
}

interface ExposedTool {
  definition: ToolDefinition;
  run: (args: Record<string, unknown>) => Promise<string>;
}

export interface TurnInput {
  conversationId: string;
  content: string;
  locale: Locale;
  userId?: string;
  providerId?: string;
  model?: string;
  depth?: number;
  signal?: AbortSignal;
  onEvent?: (event: ClientEvent) => Promise<void>;
  /** Файлы из /api/conversations/:id/files, приложенные к сообщению. */
  attachments?: Attachment[];
}

export async function runTurn(
  deps: TurnDeps,
  input: TurnInput,
): Promise<{ text: string }> {
  const conversation = await deps.store.getConversation(
    input.conversationId,
    input.userId,
  );
  if (!conversation) throw badRequest('Чат не найден');
  const userId = conversation.userId;
  if (!userId) throw badRequest('Чат без владельца');
  const owner = await deps.store.getUser(userId);
  const agent = conversation.agentId
    ? await deps.store.getAgent(conversation.agentId)
    : (await deps.store.listAgents())[0];
  if (!agent) throw badRequest('Агент не найден');
  const providerId =
    input.providerId ?? conversation.providerId ?? agent.providerId;
  const provider = providerId
    ? await deps.store.getProvider(providerId)
    : undefined;
  if (!provider?.enabled) throw badRequest('Выберите включённую модель');
  const requested = input.model ?? conversation.model ?? agent.model;
  const model =
    requested && provider.models.includes(requested)
      ? requested
      : provider.models[0];
  if (!model) throw badRequest('У провайдера не задана модель');
  if (owner && !(await deps.store.isModelAllowed(owner, provider.id, model))) {
    throw new HttpError(403, 'Эта модель недоступна');
  }
  if (providerNeedsKey(provider.kind) && !provider.apiKey) {
    throw badRequest('Сохраните API-ключ провайдера в настройках');
  }

  await deps.store.updateConversation(conversation.id, {
    providerId: provider.id,
    model,
  });
  const freshTitle = await maybeRetitle(
    deps.store,
    conversation.title,
    input.content,
    conversation.id,
  );
  const userMessage = await deps.store.insertMessage({
    conversationId: conversation.id,
    role: 'user',
    content: input.content,
    attachments: input.attachments,
  });
  const emit = input.onEvent ?? (async () => undefined);
  await emit({ type: 'message', message: userMessage });
  if (freshTitle) await emit({ type: 'title', title: freshTitle });

  const depth = input.depth ?? 0;
  const exposed = await exposeTools(
    deps,
    agent,
    userId,
    depth,
    conversation.id,
  );
  const peers = (await deps.store.listAgents())
    .filter((item) => item.id !== agent.id)
    .map((item) => ({ name: item.name, description: item.description }));
  const history = await buildHistory(
    deps.store,
    await deps.store.listMessages(conversation.id),
    provider.kind,
  );
  let pending = '';
  let pendingReasoning = '';
  let finalText = '';
  try {
    await assertQuota(deps.store, owner);
    await runAgentLoop({
      client: meteredClient(createClient(provider), async () => {
        await assertQuota(deps.store, owner);
        const cap = await deps.store.getSetting(`token_limit:${userId}`);
        if (cap && Number(cap) > 0) {
          const used = await deps.store.tokenSumSince(userId, utcDayStart());
          if (used >= Number(cap)) {
            throw new HttpError(429, 'Дневной лимит токенов исчерпан');
          }
        }
        await deps.store.insertUsage({
          userId,
          providerId: provider.id,
          model,
          inputTokens: Math.ceil(
            history.reduce((sum, message) => sum + message.content.length, 0) /
              4,
          ),
          outputTokens: 0,
        });
      }),
      model,
      messages: [
        {
          role: 'system',
          content: buildSystemPrompt(
            deps.skills
              .listEnabled()
              .filter((skill) => agent.skillNames.includes(skill.name)),
            input.locale,
            { persona: agent.systemPrompt, peers: depth === 0 ? peers : [] },
          ),
        },
        ...history,
      ],
      tools: exposed.map((tool) => tool.definition),
      signal: input.signal,
      limitMessage:
        input.locale === 'en'
          ? 'Stopped: the agent step limit was reached.'
          : 'Остановлено: исчерпан лимит шагов агента.',
      executeTool: async (call) => {
        const tool = exposed.find((item) => item.definition.name === call.name);
        if (!tool) return `Неизвестный инструмент ${call.name}`;
        if (await toolNeedsApproval(deps.store, call.name)) {
          const approvalId = await deps.store.createApproval({
            userId,
            conversationId: conversation.id,
            toolName: call.name,
            arguments: call.arguments,
          });
          return `APPROVAL:${approvalId}:${call.name}`;
        }
        return tool.run(jsonObject(call.arguments));
      },
      onEvent: async (event) => {
        if (event.type === 'text') {
          pending += event.delta;
          await emit({ type: 'text', delta: event.delta });
        } else if (event.type === 'reasoning') {
          pendingReasoning += event.delta;
          await emit({ type: 'reasoning', delta: event.delta });
        } else if (event.type === 'tool_start') {
          await emit({ type: 'tool_start', call: event.call });
        } else if (event.type === 'assistant') {
          pending = '';
          pendingReasoning = '';
          finalText = event.content;
          const saved = await deps.store.insertMessage({
            conversationId: conversation.id,
            role: 'assistant',
            content: event.content,
            toolCalls: event.toolCalls,
            reasoning: event.reasoning,
          });
          await emit({ type: 'message', message: saved });
        } else if (event.type === 'tool_result') {
          const saved = await deps.store.insertMessage({
            conversationId: conversation.id,
            role: 'tool',
            content: event.content,
            toolCallId: event.call.id,
            toolName: event.call.name,
          });
          await emit({ type: 'message', message: saved });
        }
      },
    });
    return { text: finalText };
  } catch (error) {
    if (isAbort(error)) {
      if (pending.trim() || pendingReasoning.trim()) {
        await deps.store.insertMessage({
          conversationId: conversation.id,
          role: 'assistant',
          content: pending,
          reasoning: pendingReasoning || undefined,
        });
      }
      return { text: pending };
    }
    throw error;
  }
}

export async function deliverToAgent(
  deps: TurnDeps,
  input: {
    from: Agent;
    userId: string;
    targetName: string;
    message: string;
    depth: number;
    locale: Locale;
    signal?: AbortSignal;
  },
): Promise<string> {
  if (input.depth > 0) return 'Вложенная пересылка между агентами отключена.';
  const target = await deps.store.findAgentByName(input.targetName);
  if (!target) {
    const names = (await deps.store.listAgents())
      .map((agent) => agent.name)
      .join(', ');
    return `Агент «${input.targetName}» не найден. Доступны: ${names || '—'}.`;
  }
  if (target.id === input.from.id)
    return 'Нельзя отправить сообщение самому себе.';
  const text = input.message.trim();
  if (!text) return 'Пустое сообщение.';
  if (text.length > 8_000) return 'Сообщение слишком длинное.';
  const title = `От: ${input.from.name}`;
  let conversation = await deps.store.findConversationByTitle(
    input.userId,
    target.id,
    title,
  );
  if (!conversation) {
    conversation = await deps.store.insertConversation({
      title,
      agentId: target.id,
      userId: input.userId,
      providerId: target.providerId,
      model: target.model,
    });
  }
  const result = await runTurn(deps, {
    conversationId: conversation.id,
    content: `Сообщение от агента «${input.from.name}»:\n\n${text}`,
    locale: input.locale,
    userId: input.userId,
    depth: input.depth + 1,
    signal: input.signal,
  });
  return result.text.trim() || '(пустой ответ)';
}

async function exposeTools(
  deps: TurnDeps,
  agent: Agent,
  userId: string,
  depth: number,
  conversationId: string,
): Promise<ExposedTool[]> {
  const used = new Set<string>([
    LOAD_SKILL_TOOL.name,
    'memory_read',
    'memory_write',
    'send_to_agent',
    'github_list_repos',
    'github_read_file',
    'github_search_code',
    'github_list_issues',
    'github_list_pulls',
    'create_routine',
  ]);
  const allowedSkills = new Set(agent.skillNames);
  const tools: ExposedTool[] = [
    {
      definition: {
        name: LOAD_SKILL_TOOL.name,
        description: LOAD_SKILL_TOOL.description,
        inputSchema: { ...LOAD_SKILL_TOOL.inputSchema },
      },
      run: async (args) => {
        const name = asString(args.name).trim();
        if (!name) return 'Укажите имя навыка в поле name.';
        if (!allowedSkills.has(name))
          return `Навык «${name}» не включён у этого агента.`;
        let skill: ReturnType<SkillLibrary['get']>;
        try {
          skill = deps.skills.get(name);
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
    {
      definition: {
        name: 'memory_read',
        description:
          'Read this agent persistent notes. Omit key to list every note. Читает память агента.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Note key. Optional.' },
          },
        },
      },
      run: async (args) => {
        const key = asString(args.key).trim();
        if (!key) {
          const notes = await deps.store.listMemory(userId, agent.id);
          if (notes.length === 0) return 'Память пуста.';
          return notes
            .map((note) => `## ${note.key}\n${note.content}`)
            .join('\n\n');
        }
        const note = await deps.store.getMemory(userId, agent.id, key);
        return note ? note.content : `Заметки «${key}» нет.`;
      },
    },
    {
      definition: {
        name: 'memory_write',
        description:
          'Save a named note for this agent. Overwrites the same key. Пишет память агента.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['key', 'content'],
        },
      },
      run: async (args) => {
        const key = asString(args.key).trim();
        const content = asString(args.content);
        if (!key || key.length > 80) return 'Ключ заметки: 1–80 символов.';
        if (content.length > 20_000) return 'Заметка слишком длинная.';
        await deps.store.writeMemory(userId, agent.id, key, content);
        return `Запомнил «${key}».`;
      },
    },
  ];

  const githubToken =
    deps.jwtSecret && agent.githubRepos.length > 0
      ? await readGithubToken(deps.store, deps.jwtSecret)
      : undefined;
  tools.push({
    definition: {
      name: 'create_routine',
      description:
        'Create a routine for this agent. Leave cron empty for a webhook-only trigger. Создаёт расписание или вебхук.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          cron: { type: 'string', description: 'Five-field cron, or empty' },
          prompt: { type: 'string' },
        },
        required: ['name', 'prompt'],
      },
    },
    run: async (args) => {
      const name = asString(args.name).trim();
      const cron = asString(args.cron).trim();
      const prompt = asString(args.prompt).trim();
      if (!name || !prompt) return 'Нужны name и prompt.';
      if (name.length > 80) return 'Слишком длинное имя.';
      if (cron && !isValidCron(cron)) return 'Некорректный cron из пяти полей.';
      if (prompt.length > 8_000) return 'Промпт слишком длинный.';
      const routine = await deps.store.insertRoutine(userId, agent.id, {
        name,
        cron,
        prompt,
        enabled: true,
      });
      return `Рутина «${routine.name}» создана. Вебхук: /api/hooks/${routine.webhookToken ?? ''}`;
    },
  });

  tools.push(
    {
      definition: {
        name: 'remember',
        description:
          'Save long-term memory. kind: profile, journal, or shared (visible to every agent of this user). Запоминает надолго.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            key: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['content'],
        },
      },
      run: async (args) => {
        const content = asString(args.content).trim();
        if (!content) return 'Пусто.';
        const kind = asString(args.kind).trim() || 'journal';
        const key = asString(args.key).trim() || new Date().toISOString();
        await deps.store.remember({
          userId,
          agentId: agent.id,
          kind,
          key,
          content,
        });
        return `Запомнил (${kind}/${key}).`;
      },
    },
    {
      definition: {
        name: 'recall',
        description:
          'Search long-term memory, including notes shared between agents. Ищет в памяти.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      run: async (args) => {
        const notes = await deps.store.recall(
          userId,
          agent.id,
          asString(args.query),
        );
        if (notes.length === 0) return 'Ничего не найдено.';
        return notes
          .map((note) => `[${note.kind}] ${note.key}: ${note.content}`)
          .join('\n');
      },
    },
    {
      definition: {
        name: 'web_search',
        description:
          'Search the web via the admin-configured provider. Ищет в интернете.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      run: async (args) => {
        try {
          const hits = await webSearch({
            query: asString(args.query),
            provider:
              (await deps.store.getSetting('search_provider')) || 'searxng',
            searxngUrl:
              (await deps.store.getSetting('search_url')) ||
              process.env.SEARXNG_URL,
            apiKey: await searchKey(deps),
          });
          if (hits.length === 0) return 'Ничего не найдено.';
          return hits
            .map((hit) => `- ${hit.title}\n  ${hit.url}\n  ${hit.snippet}`)
            .join('\n');
        } catch (error) {
          return error instanceof Error ? error.message : 'Ошибка поиска';
        }
      },
    },
    {
      definition: {
        name: 'web_fetch',
        description:
          'Fetch a public http(s) page and return markdown. Private networks are blocked.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
      },
      run: async (args) => {
        try {
          return await webFetch(asString(args.url));
        } catch (error) {
          return error instanceof Error
            ? error.message
            : 'Не удалось открыть страницу';
        }
      },
    },
    {
      definition: {
        name: 'run_code',
        description:
          'Run Python or Node in a Docker sandbox. Disabled until an admin enables it. Запускает код в песочнице.',
        inputSchema: {
          type: 'object',
          properties: {
            language: { type: 'string' },
            code: { type: 'string' },
          },
          required: ['language', 'code'],
        },
      },
      run: async (args) =>
        runSandboxed({
          enabled: (await deps.store.getSetting('code_sandbox')) === '1',
          language: asString(args.language).trim(),
          code: asString(args.code),
        }),
    },
    {
      definition: {
        name: 'ask_user',
        description:
          'Ask the user to pick one option. Спрашивает пользователя с вариантами ответа.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
          },
          required: ['question', 'options'],
        },
      },
      run: async (args) => {
        const options = Array.isArray(args.options)
          ? args.options
              .filter((item): item is string => typeof item === 'string')
              .slice(0, 6)
          : [];
        return `ASK:${JSON.stringify({ question: asString(args.question), options })}`;
      },
    },
    {
      definition: {
        name: 'todo_write',
        description:
          'Add a todo for this agent or list them when text is empty. Список дел агента.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            doneId: { type: 'string' },
          },
        },
      },
      run: async (args) => {
        const doneId = asString(args.doneId).trim();
        if (doneId) await deps.store.setTodoDone(doneId, userId, true);
        const text = asString(args.text).trim();
        if (text)
          await deps.store.addTodo(userId, agent.id, text.slice(0, 200));
        const items = await deps.store.listTodos(userId, agent.id);
        if (items.length === 0) return 'Список пуст.';
        return items
          .map(
            (item) => `- [${item.done ? 'x' : ' '}] ${item.text} (${item.id})`,
          )
          .join('\n');
      },
    },
    {
      definition: {
        name: 'create_page',
        description:
          'Create a shareable markdown page (report or dashboard). Создаёт страницу со ссылкой.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['title', 'body'],
        },
      },
      run: async (args) => {
        const title = asString(args.title).trim().slice(0, 120);
        const body = asString(args.body).slice(0, 100_000);
        if (!title || !body) return 'Нужны title и body.';
        const page = await deps.store.createPage({
          userId,
          agentId: agent.id,
          title,
          body,
        });
        return `Страница «${title}»: /api/public/pages/${page.shareToken}`;
      },
    },
  );

  if (depth === 0) {
    tools.push({
      definition: {
        name: 'task',
        description:
          'Start a background sub-agent task. The result is posted back into this chat. Фоновая подзадача.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['prompt'],
        },
      },
      run: async (args) => {
        const title = asString(args.title).trim().slice(0, 80) || 'Задача';
        const prompt = asString(args.prompt).trim();
        if (!prompt) return 'Нужен prompt.';
        const taskId = await deps.store.createTask({
          userId,
          agentId: agent.id,
          conversationId,
          title,
          prompt,
        });
        void runBackgroundTask(deps, {
          taskId,
          title,
          prompt,
          userId,
          agent,
          conversationId,
        });
        return `Задача «${title}» запущена. Результат появится в этом чате.`;
      },
    });
  }

  if (githubToken) {
    const context = { token: githubToken, allow: agent.githubRepos };
    const repos = agent.githubRepos.join(', ');
    const addGithub = (
      name: string,
      description: string,
      properties: Record<string, unknown>,
      required: string[],
    ) => {
      tools.push({
        definition: {
          name,
          description,
          inputSchema: { type: 'object', properties, required },
        },
        run: (args) => runGithubTool(name, args, context),
      });
    };
    addGithub(
      'github_list_repos',
      `List repositories assigned to this agent: ${repos}. Список репозиториев агента.`,
      {},
      [],
    );
    addGithub(
      'github_read_file',
      'Read a text file from an assigned GitHub repository. Читает файл из подключённого репозитория.',
      {
        repo: { type: 'string', description: 'owner/name' },
        path: { type: 'string' },
        ref: { type: 'string', description: 'branch, tag, or commit' },
      },
      ['repo', 'path'],
    );
    addGithub(
      'github_search_code',
      'Search code in an assigned repository. Ищет код в подключённом репозитории.',
      {
        repo: { type: 'string' },
        query: { type: 'string' },
      },
      ['repo', 'query'],
    );
    addGithub(
      'github_list_issues',
      'List issues in an assigned repository. Список задач.',
      {
        repo: { type: 'string' },
        state: { type: 'string', description: 'open, closed, or all' },
      },
      ['repo'],
    );
    addGithub(
      'github_list_pulls',
      'List pull requests in an assigned repository. Список запросов на слияние.',
      {
        repo: { type: 'string' },
        state: { type: 'string', description: 'open, closed, or all' },
      },
      ['repo'],
    );
  }

  if (depth === 0) {
    const names = (await deps.store.listAgents())
      .filter((item) => item.id !== agent.id)
      .map((item) => item.name)
      .join(', ');
    tools.push({
      definition: {
        name: 'send_to_agent',
        description: `Send a message to another agent and return their reply. Agents: ${names || 'none'}. Пишет другому агенту и возвращает ответ.`,
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'Target agent name' },
            message: { type: 'string' },
          },
          required: ['agent', 'message'],
        },
      },
      run: (args) =>
        deliverToAgent(deps, {
          from: agent,
          userId,
          targetName: asString(args.agent),
          message: asString(args.message),
          depth,
          locale: 'ru',
        }),
    });
  }

  for (const name of [
    'skill_manage',
    'workspace_list',
    'workspace_read',
    'workspace_write',
    'workspace_edit',
    'workspace_delete',
    'shell',
  ])
    used.add(name);
  const dataDir = path.dirname(deps.skills.directory);
  const root = () => workspaceRoot(dataDir, userId, agent.id);
  const guard = (run: () => string) => {
    try {
      return run();
    } catch (error) {
      return error instanceof Error ? error.message : 'Ошибка рабочей папки';
    }
  };
  tools.push(
    {
      definition: {
        name: 'skill_manage',
        description:
          'Create, update or list reusable skills (SKILL.md). After solving a repeatable task, save the procedure as a skill so it can be reused with load_skill. Создаёт и улучшает навыки агента.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'update'] },
            name: {
              type: 'string',
              description: 'latin, digits, - and _, e.g. weekly-report',
            },
            description: {
              type: 'string',
              description: 'One line: when to use the skill',
            },
            body: {
              type: 'string',
              description: 'Markdown instructions: steps, checks, examples',
            },
          },
          required: ['action'],
        },
      },
      run: async (args) => {
        const action = asString(args.action).trim();
        if (action === 'list') {
          const list = deps.skills.list();
          return list.length
            ? list
                .map(
                  (skill) =>
                    `${skill.name}${agent.skillNames.includes(skill.name) ? ' (подключён)' : ''} — ${skill.description}`,
                )
                .join('\n')
            : 'Навыков пока нет.';
        }
        if (action !== 'create' && action !== 'update')
          return 'action: list, create или update.';
        const owner = await deps.store.getUser(userId);
        if (owner && owner.role !== 'admin')
          return 'Создавать и менять навыки может только администратор.';
        const name = asString(args.name).trim().toLowerCase();
        const body = asString(args.body).trim();
        if (!name || !body) return 'Нужны name и body.';
        let existing: ReturnType<SkillLibrary['get']>;
        try {
          existing = deps.skills.get(name);
        } catch (error) {
          return error instanceof Error ? error.message : 'Некорректное имя';
        }
        if (action === 'create' && existing)
          return `Навык «${name}» уже есть — используйте action=update.`;
        if (action === 'update' && !existing)
          return `Навыка «${name}» нет — используйте action=create.`;
        try {
          const saved = deps.skills.save({
            name,
            description:
              asString(args.description).trim() || existing?.description || '',
            enabled: existing?.enabled ?? true,
            body,
          });
          if (!agent.skillNames.includes(saved.name)) {
            const skillNames = [...agent.skillNames, saved.name];
            await deps.store.updateAgent(agent.id, { skillNames });
            agent.skillNames = skillNames;
            allowedSkills.add(saved.name);
          }
          return `Навык «${saved.name}» ${action === 'create' ? 'создан' : 'обновлён'} и подключён к агенту.`;
        } catch (error) {
          return error instanceof Error
            ? error.message
            : 'Не удалось сохранить';
        }
      },
    },
    {
      definition: {
        name: 'workspace_list',
        description:
          'List files in the agent workspace folder. Список файлов рабочей папки.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Folder, default .' },
          },
        },
      },
      run: async (args) =>
        guard(() => listWorkspace(root(), asString(args.path) || '.')),
    },
    {
      definition: {
        name: 'workspace_read',
        description: 'Read a text file from the workspace. Читает файл.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      run: async (args) =>
        guard(() => readWorkspaceFile(root(), asString(args.path))),
    },
    {
      definition: {
        name: 'workspace_write',
        description:
          'Create or overwrite a file in the workspace. Returns a diff. Создаёт или перезаписывает файл.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
      run: async (args) =>
        guard(() =>
          writeWorkspaceFile(
            root(),
            asString(args.path),
            asString(args.content),
          ),
        ),
    },
    {
      definition: {
        name: 'workspace_edit',
        description:
          'Replace one unique fragment `old` with `new` in a workspace file. Returns a diff. Точечная правка файла.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old: { type: 'string' },
            new: { type: 'string' },
          },
          required: ['path', 'old', 'new'],
        },
      },
      run: async (args) =>
        guard(() =>
          editWorkspaceFile(
            root(),
            asString(args.path),
            asString(args.old),
            asString(args.new),
          ),
        ),
    },
    {
      definition: {
        name: 'workspace_delete',
        description: 'Delete a file or folder in the workspace. Удаляет файл.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      run: async (args) =>
        guard(() => deleteWorkspaceFile(root(), asString(args.path))),
    },
    {
      definition: {
        name: 'shell',
        description:
          'Run a shell command in a sandbox with the workspace mounted at /work (no network, 60 s). Disabled until an admin enables the code sandbox. Терминал в песочнице.',
        inputSchema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      run: async (args) =>
        runWorkspaceShell({
          enabled: (await deps.store.getSetting('code_sandbox')) === '1',
          root: root(),
          command: asString(args.command),
        }),
    },
  );

  const allowedMcp = new Set(agent.mcpServerIds);
  for (const server of deps.mcp.listConnected()) {
    if (!allowedMcp.has(server.id)) continue;
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
        run: (args) => deps.mcp.callTool(server.id, tool.name, args),
      });
    }
  }
  return tools;
}

async function searchKey(deps: TurnDeps): Promise<string | undefined> {
  const stored = await deps.store.getSetting('search_key');
  if (!stored || !deps.jwtSecret) return undefined;
  try {
    return decryptSecret(stored, deps.jwtSecret);
  } catch {
    return undefined;
  }
}

export async function toolNeedsApproval(
  store: Store,
  name: string,
): Promise<boolean> {
  if ((await store.getSetting('approvals_enabled')) !== '1') return false;
  const auto = ((await store.getSetting('approval_auto')) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (auto.includes('*') || auto.includes(name)) return false;
  return (
    name === 'send_to_agent' ||
    name === 'run_code' ||
    name === 'shell' ||
    name === 'workspace_delete' ||
    name === 'skill_manage' ||
    name.startsWith('mcp__')
  );
}

async function runBackgroundTask(
  deps: TurnDeps,
  input: {
    taskId: string;
    title: string;
    prompt: string;
    userId: string;
    agent: Agent;
    conversationId: string;
  },
): Promise<void> {
  try {
    const chat = await deps.store.insertConversation({
      title: `Задача: ${input.title}`,
      agentId: input.agent.id,
      userId: input.userId,
      providerId: input.agent.providerId,
      model: input.agent.model,
    });
    const result = await runTurn(deps, {
      conversationId: chat.id,
      content: input.prompt,
      locale: 'ru',
      userId: input.userId,
      depth: 1,
    });
    await deps.store.finishTask(input.taskId, 'done', result.text);
    await deps.store.insertMessage({
      conversationId: input.conversationId,
      role: 'assistant',
      content: `Результат задачи «${input.title}»:\n\n${result.text.slice(0, 4_000)}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ошибка';
    await deps.store.finishTask(input.taskId, 'error', message);
  }
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

/** Провайдеры, которые принимают картинки. DeepSeek и демо — только текст. */
export function supportsVision(kind: ProviderKind): boolean {
  return kind === 'openai' || kind === 'anthropic' || kind === 'gemini';
}

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5_000_000;

/**
 * История для модели. Вложения пользователя раскрываются: текст документов
 * дописывается к сообщению, картинки уходят как image parts (самые свежие, до 6).
 */
export async function buildHistory(
  store: Store,
  messages: ChatMessage[],
  kind: ProviderKind,
): Promise<ModelMessage[]> {
  const vision = supportsVision(kind);
  let imageBudget = MAX_IMAGES;
  const out: ModelMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const model = toModelMessage(message);
    if (message.role === 'user' && message.attachments?.length) {
      const notes: string[] = [];
      for (const attachment of message.attachments) {
        const file = await store.getUpload(attachment.id);
        if (!file) {
          notes.push(`[Файл ${attachment.name} недоступен]`);
          continue;
        }
        if (IMAGE_MIMES.has(file.mime)) {
          if (!vision) {
            notes.push(
              `[Изображение ${file.name}: выбранная модель не видит картинки. Чтобы модель её разобрала, выберите OpenAI, Anthropic или Gemini.]`,
            );
            continue;
          }
          if (imageBudget <= 0) {
            notes.push(
              `[Изображение ${file.name} пропущено: лимит картинок в истории]`,
            );
            continue;
          }
          try {
            const bytes = fs.readFileSync(file.path);
            if (bytes.length > MAX_IMAGE_BYTES) {
              notes.push(`[Изображение ${file.name} больше 5 МБ]`);
              continue;
            }
            model.images = [
              ...(model.images ?? []),
              { mime: file.mime, data: bytes.toString('base64') },
            ];
            imageBudget--;
            notes.push(`[Изображение ${file.name}]`);
          } catch {
            notes.push(`[Изображение ${file.name} не прочитано]`);
          }
          continue;
        }
        const text = file.text?.trim();
        notes.push(
          text
            ? `[Файл ${file.name}]\n${text.slice(0, 20_000)}`
            : `[Файл ${file.name}: текст не извлечён]`,
        );
      }
      if (notes.length)
        model.content = `${model.content}\n\n${notes.join('\n\n')}`;
    }
    out.push(model);
  }
  return out.reverse();
}

async function maybeRetitle(
  store: Store,
  title: string,
  content: string,
  conversationId: string,
): Promise<string | undefined> {
  if (title !== 'Новый чат' && title !== 'New chat') return undefined;
  const next = clampText(content);
  await store.updateConversation(conversationId, { title: next });
  return next;
}

export function utcDayStart(now = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

export async function assertQuota(
  store: Store,
  user: UserRecord | undefined,
): Promise<void> {
  if (!user || user.dailyRequestLimit === null) return;
  const used = await store.countUsageSince(user.id, utcDayStart());
  if (used >= user.dailyRequestLimit) {
    throw new HttpError(429, 'Дневной лимит запросов исчерпан');
  }
}

function meteredClient(
  client: LLMClient,
  onCall: () => Promise<void>,
): LLMClient {
  return {
    stream(input) {
      return (async function* () {
        await onCall();
        yield* client.stream(input);
      })();
    },
  };
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'Запрос отменён')
  );
}
