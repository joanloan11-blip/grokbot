import fs from 'node:fs';
import path from 'node:path';
import type {
  Agent,
  Attachment,
  ChatMessage,
  ClientEvent,
  Locale,
  MessageMeta,
  ProviderKind,
} from '@mayak/shared';
import { toolAllowedByPlugins } from '@mayak/shared';
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
import {
  cloneRepo,
  describeChanges,
  hasClonedRepos,
  pushRepo,
} from './github/workspace-repo';
import { runSandboxed } from './sandbox';
import { webFetch, webSearch } from './webtools';
import { formatStock, searchStock } from './moysklad';
import { readImageSettings, runImageTool } from './images';
import { assertBudget } from './meter';
import { assertCanSpend, chargeTokens } from './billing';
import { costUsd } from './pricing';
import { priceForModel } from './spend';
import { compactHistory } from './context';
import { readCaps } from './model-caps';
import { formatNews, NEWS_TOPICS, type NewsTopic, newsSearch } from './news';
import { DELEGATE_LIMITS, normalizeTasks, runDelegation } from './orchestrator';
import { decryptSecret } from './github/secret';
import type { SkillLibrary } from './skills';
import { asString, clampText, isRecord, jsonObject } from './util';
import {
  deleteWorkspaceFile,
  editWorkspaceFile,
  globWorkspace,
  listWorkspace,
  readWorkspaceFile,
  runWorkspaceShell,
  resolveInside,
  searchWorkspace,
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
  /** Эти инструменты модели не показываем (режим сравнения). */
  excludeTools?: string[];
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
  if (providerNeedsKey(provider.kind, provider.baseUrl) && !provider.apiKey) {
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
  const excluded = new Set(input.excludeTools ?? []);
  const exposed = (
    await exposeTools(deps, agent, userId, depth, conversation.id)
  ).filter(
    (tool) =>
      !excluded.has(tool.definition.name) &&
      // В сравнении внешние коннекторы тоже выключены: два ответа не должны дважды создавать сделку.
      !(excluded.size > 0 && tool.definition.description.startsWith('[MCP ')),
  );
  // Писать можно только агентам, которые доступны владельцу чата.
  const peers = (
    owner
      ? await deps.store.listAgentsFor(owner)
      : await deps.store.listAgents()
  )
    .filter((item) => item.id !== agent.id)
    .map((item) => ({ name: item.name, description: item.description }));
  // Длинный чат: старое — кратким пересказом, свежее — целиком.
  const history = await compactHistory(deps.store, {
    history: await buildHistory(
      deps.store,
      await deps.store.listMessages(conversation.id),
      provider.kind,
    ),
    conversationId: conversation.id,
    provider,
    model,
    userId,
    agentId: agent.id,
  });
  const toolsOff =
    (await readCaps(deps.store))[provider.id]?.[model]?.tools === false;
  const toolNames = new Set(exposed.map((tool) => tool.definition.name));
  // Режим кода: агент с плагином GitHub или уже скачанный в рабочую папку репозиторий.
  const coding =
    toolNames.has('workspace_edit') &&
    ((agent.plugins ?? []).includes('github') ||
      hasClonedRepos(
        workspaceRoot(
          path.dirname(deps.skills.directory),
          userId,
          conversation.projectId
            ? `project-${conversation.projectId}`
            : agent.id,
        ),
      ));
  const stepsSetting = Number(await deps.store.getSetting('agent_max_steps'));
  // Код требует десятков шагов: найти, прочитать, поправить, запустить тесты, исправить.
  const maxSteps =
    Number.isFinite(stepsSetting) && stepsSetting > 0
      ? stepsSetting
      : coding
        ? 60
        : toolNames.has('workspace_edit') || toolNames.has('shell')
          ? 25
          : 12;
  let pending = '';
  let pendingReasoning = '';
  let finalText = '';
  // Итог хода для подписи под ответом.
  const startedAt = Date.now();
  const totals = {
    steps: 0,
    tools: 0,
    input: 0,
    output: 0,
    cached: 0,
    exact: true,
  };
  const price = await priceForModel(deps.store, provider.baseUrl, model).catch(
    () => null,
  );
  const turnMeta = (): MessageMeta => {
    const cost = costUsd(price, {
      inputTokens: totals.input,
      outputTokens: totals.output,
      cachedTokens: totals.cached,
    });
    return {
      model,
      provider: provider.name,
      ms: Date.now() - startedAt,
      steps: totals.steps,
      tools: totals.tools,
      inputTokens: totals.input,
      outputTokens: totals.output,
      costUsd: cost === null ? null : Math.round(cost * 1e6) / 1e6,
      exact: totals.exact,
    };
  };
  try {
    await assertQuota(deps.store, owner);
    await runAgentLoop({
      client: meteredClient(createClient(provider), {
        before: async (messages) => {
          await assertQuota(deps.store, owner);
          await assertBudget(deps.store, userId);
          // Клиент без пробных долларов, тарифа и баланса не тратит платные модели.
          await assertCanSpend(deps.store, owner, provider, model);
          const cap = await deps.store.getSetting(`token_limit:${userId}`);
          if (cap && Number(cap) > 0) {
            const used = await deps.store.tokenSumSince(userId, utcDayStart());
            if (used >= Number(cap)) {
              throw new HttpError(429, 'Дневной лимит токенов исчерпан');
            }
          }
          // Пока провайдер не ответил — оценка по длине; потом заменим реальными цифрами.
          return deps.store.insertUsage({
            userId,
            providerId: provider.id,
            model,
            agentId: agent.id,
            conversationId: conversation.id,
            inputTokens: Math.ceil(
              messages.reduce(
                (sum, message) => sum + message.content.length,
                0,
              ) / 4,
            ),
            outputTokens: 0,
          });
        },
        after: async (id, usage) => {
          totals.steps += 1;
          totals.input += usage.inputTokens;
          totals.output += usage.outputTokens;
          totals.cached += usage.cachedTokens;
          if (!usage.exact) totals.exact = false;
          await deps.store.updateUsageTokens(id, usage);
          await chargeTokens(deps.store, userId, provider, model, usage);
        },
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
            {
              persona: agent.systemPrompt,
              context: await projectBlock(deps.store, conversation.projectId),
              peers: depth === 0 ? peers : [],
              coding,
            },
          ),
        },
        ...history,
      ],
      // Модели без инструментов (по проверке) сразу получают запрос без них.
      tools: toolsOff ? [] : exposed.map((tool) => tool.definition),
      maxSteps,
      signal: input.signal,
      limitMessage:
        input.locale === 'en'
          ? 'Stopped: the agent step limit was reached. Say "continue" to resume.'
          : 'Остановлено: исчерпан лимит шагов агента. Напишите «продолжай», чтобы агент продолжил с того же места.',
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
          totals.tools += 1;
          await emit({ type: 'tool_start', call: event.call });
        } else if (event.type === 'assistant') {
          pending = '';
          pendingReasoning = '';
          finalText = event.content;
          const final = !event.toolCalls?.length;
          const saved = await deps.store.insertMessage({
            conversationId: conversation.id,
            role: 'assistant',
            content: event.content,
            toolCalls: event.toolCalls,
            reasoning: event.reasoning,
            meta: final ? turnMeta() : undefined,
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
  const sender = await deps.store.getUser(input.userId);
  const reachable = sender
    ? await deps.store.listAgentsFor(sender)
    : await deps.store.listAgents();
  const found = await deps.store.findAgentByName(input.targetName);
  const target =
    found && reachable.some((item) => item.id === found.id) ? found : undefined;
  if (!target) {
    const names = reachable.map((agent) => agent.name).join(', ');
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
      internal: true,
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
        name: 'news_search',
        description:
          'Fresh news articles with dates and sources (Google News, fallback RIA/TASS/Lenta). Use it for any news request instead of web_search. Свежие новости по теме или запросу.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Optional keywords, e.g. "рулевые рейки" or "нефть"',
            },
            topic: {
              type: 'string',
              enum: Object.keys(NEWS_TOPICS),
              description:
                'Section when there is no query: top, world, russia, business, technology, science, health, sports',
            },
            period: { type: 'string', enum: ['day', 'week'] },
          },
        },
      },
      run: async (args) =>
        formatNews(
          await newsSearch({
            query: asString(args.query) || undefined,
            topic: (asString(args.topic) || undefined) as NewsTopic | undefined,
            period: args.period === 'week' ? 'week' : 'day',
          }),
        ),
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
          root: root(),
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
    used.add('delegate');
    tools.push({
      definition: {
        name: 'delegate',
        description: `Orchestrate: split a complex request into independent subtasks and run them IN PARALLEL on other agents (or on yourself with agent="self"). Each subtask gets its own chat; you receive all results together and must then compare and synthesize one final answer. Up to ${DELEGATE_LIMITS.maxTasks} subtasks, ${DELEGATE_LIMITS.concurrency} at a time, 5 minutes each. Use for research from several angles, checking stock + competitors + drafting a reply, etc. Available agents: ${names || 'only self'}. Оркестратор: параллельные подзадачи.`,
        inputSchema: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: 'Independent subtasks',
              items: {
                type: 'object',
                properties: {
                  agent: {
                    type: 'string',
                    description: 'Agent name, or "self"',
                  },
                  title: { type: 'string', description: 'Short label' },
                  task: {
                    type: 'string',
                    description:
                      'Full self-contained instruction with all needed context',
                  },
                },
                required: ['task'],
              },
            },
          },
          required: ['tasks'],
        },
      },
      run: (args) =>
        runDelegation(deps, {
          from: agent,
          userId,
          conversationId,
          depth,
          locale: 'ru',
          tasks: normalizeTasks(args.tasks),
        }),
    });
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
    'generate_image',
    'stock_lookup',
    'skill_manage',
    'workspace_list',
    'workspace_read',
    'workspace_write',
    'workspace_edit',
    'workspace_delete',
    'workspace_search',
    'workspace_glob',
    'workspace_download',
    'github_clone',
    'github_changes',
    'github_push',
    'shell',
  ])
    used.add(name);
  const dataDir = path.dirname(deps.skills.directory);
  // В проекте рабочая папка общая для всех чатов проекта.
  const conversationRow = await deps.store.getConversation(conversationId);
  const workspaceScope = conversationRow?.projectId
    ? `project-${conversationRow.projectId}`
    : agent.id;
  const root = () => workspaceRoot(dataDir, userId, workspaceScope);
  // Токен администратора нужен и для чтения публичных репозиториев: без него GitHub даёт 60 запросов в час.
  const githubReadToken =
    githubToken ??
    (deps.jwtSecret
      ? await readGithubToken(deps.store, deps.jwtSecret)
      : undefined);
  const repoContext = () => ({
    root: root(),
    token: githubToken,
    readToken: githubReadToken,
    allow: agent.githubRepos,
  });
  const guardAsync = async (run: () => Promise<string>) => {
    try {
      return await run();
    } catch (error) {
      return error instanceof Error ? error.message : 'Ошибка GitHub';
    }
  };
  const guard = (run: () => string) => {
    try {
      return run();
    } catch (error) {
      return error instanceof Error ? error.message : 'Ошибка рабочей папки';
    }
  };
  const imageSettings = await readImageSettings(deps.store);
  if (imageSettings.enabled) {
    tools.push({
      definition: {
        name: 'generate_image',
        description:
          'Create a picture from a text prompt (or edit the images the user attached when edit_attached=true) and show it in the chat. Write a detailed visual prompt in English or Russian: subject, style, composition, colors, text on the image. Генерирует или правит картинку.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Detailed description of the image',
            },
            size: {
              type: 'string',
              enum: ['auto', '1024x1024', '1536x1024', '1024x1536'],
              description: 'Square, landscape or portrait',
            },
            quality: {
              type: 'string',
              enum: ['auto', 'low', 'medium', 'high'],
            },
            edit_attached: {
              type: 'boolean',
              description:
                'Edit the images attached to the latest user message instead of drawing from scratch',
            },
          },
          required: ['prompt'],
        },
      },
      run: async (args) =>
        runImageTool({
          store: deps.store,
          dataDir,
          userId,
          conversationId,
          prompt: asString(args.prompt),
          size: asString(args.size) || undefined,
          quality: asString(args.quality) || undefined,
          editAttached: args.edit_attached === true,
          agentId: agent.id,
        }),
    });
  }

  const moyskladStored = await deps.store.getSetting('moysklad_token');
  if (moyskladStored && deps.jwtSecret) {
    const secret = deps.jwtSecret;
    tools.push({
      definition: {
        name: 'stock_lookup',
        description:
          'Live stock and prices from MoySklad (read-only): search by name, article, OEM or code. Use it before telling a client whether an item is in stock or how much it costs. Наличие и цены из МойСклад.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Название, артикул, OEM-номер или код',
            },
            limit: {
              type: 'number',
              description: 'Сколько позиций вернуть (1–15)',
            },
          },
          required: ['query'],
        },
      },
      run: async (args) => {
        const query = asString(args.query).trim();
        if (!query) return 'Укажите query: название, артикул или OEM.';
        const limit = Math.min(15, Math.max(1, Number(args.limit) || 8));
        try {
          const token = decryptSecret(moyskladStored, secret);
          return formatStock(query, await searchStock(token, query, limit));
        } catch (error) {
          return error instanceof Error ? error.message : 'МойСклад недоступен';
        }
      },
    });
  }

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
        description:
          'Read a text file from the workspace with line numbers (cat -n format: number, tab, text). For big files pass offset (first line, 1-based) and limit (number of lines). The number and tab are not part of the file: never include them in workspace_edit. Читает файл с номерами строк.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            offset: { type: 'number', description: 'First line, 1-based' },
            limit: { type: 'number', description: 'Max lines, default 2000' },
          },
          required: ['path'],
        },
      },
      run: async (args) =>
        guard(() =>
          readWorkspaceFile(root(), asString(args.path), {
            offset: typeof args.offset === 'number' ? args.offset : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            numbered: true,
          }),
        ),
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
          'Replace the exact fragment `old` with `new` in a workspace file (read the file first). `old` must be unique unless replace_all is true; include surrounding lines to make it unique and keep indentation exact. Returns a diff. Точечная правка файла.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old: { type: 'string' },
            new: { type: 'string' },
            replace_all: {
              type: 'boolean',
              description: 'Replace every occurrence (e.g. rename)',
            },
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
            args.replace_all === true,
          ),
        ),
    },
    {
      definition: {
        name: 'workspace_glob',
        description:
          'Find files by glob pattern, e.g. **/*.ts or src/**/test_*.py. Newest first. Поиск файлов по маске.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string', description: 'Folder, default .' },
          },
          required: ['pattern'],
        },
      },
      run: async (args) =>
        guard(() =>
          globWorkspace(
            root(),
            asString(args.pattern),
            asString(args.path) || '.',
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
        name: 'workspace_search',
        description:
          'Search text in workspace files, like grep -n. Returns file:line: text. Поиск по коду в рабочей папке.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            path: { type: 'string', description: 'Folder or file, default .' },
            regex: { type: 'boolean', description: 'query is a regex' },
            glob: { type: 'string', description: 'File suffix, e.g. *.ts' },
          },
          required: ['query'],
        },
      },
      run: async (args) =>
        guard(() =>
          searchWorkspace(
            root(),
            asString(args.query),
            asString(args.path) || '.',
            { regex: args.regex === true, glob: asString(args.glob) },
          ),
        ),
    },
    {
      definition: {
        name: 'github_clone',
        description:
          'Download a GitHub repository (public, or private if assigned to this agent) into the workspace, by default to repos/<name>. Then read, search and edit it with workspace_* tools. Скачать репозиторий GitHub в рабочую папку.',
        inputSchema: {
          type: 'object',
          properties: {
            repo: {
              type: 'string',
              description: 'owner/name or https://github.com/owner/name',
            },
            ref: { type: 'string', description: 'branch, tag or commit' },
            dir: { type: 'string', description: 'target folder' },
          },
          required: ['repo'],
        },
      },
      run: async (args) =>
        guardAsync(() =>
          cloneRepo(repoContext(), {
            repo: asString(args.repo),
            ref: asString(args.ref),
            dir: asString(args.dir),
          }),
        ),
    },
    {
      definition: {
        name: 'github_changes',
        description:
          'List files changed, added or deleted in a cloned repository folder since it was downloaded. Что изменено в скачанном репозитории.',
        inputSchema: {
          type: 'object',
          properties: { dir: { type: 'string', description: 'e.g. repos/x' } },
          required: ['dir'],
        },
      },
      run: async (args) =>
        guard(() => describeChanges(root(), asString(args.dir))),
    },
    {
      definition: {
        name: 'workspace_download',
        description:
          'Give the user a download link (tar.gz) for a workspace folder or file, e.g. a cloned and edited repository. Ссылка на скачивание результата.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      run: async (args) =>
        guard(() => {
          const rel = asString(args.path) || '.';
          const full = resolveInside(root(), rel);
          if (!fs.existsSync(full)) return `«${rel}» нет в рабочей папке.`;
          const link = `/api/workspace/archive?scope=${encodeURIComponent(workspaceScope)}&path=${encodeURIComponent(rel)}`;
          return `Ссылка для скачивания (дайте её пользователю как есть): [Скачать ${rel}.tar.gz](${link})`;
        }),
    },
    ...(githubToken
      ? [
          {
            definition: {
              name: 'github_push',
              description: `Commit the changes of a cloned repository to a NEW branch and open a pull request. Only for repositories assigned to this agent (${agent.githubRepos.join(', ')}); never the default branch. Отправить правки в ветку и открыть PR.`,
              inputSchema: {
                type: 'object',
                properties: {
                  dir: { type: 'string', description: 'e.g. repos/x' },
                  branch: { type: 'string', description: 'new branch name' },
                  title: { type: 'string', description: 'commit/PR title' },
                  body: { type: 'string', description: 'PR description' },
                },
                required: ['dir', 'title'],
              },
            },
            run: async (args: Record<string, unknown>) =>
              guardAsync(() =>
                pushRepo(repoContext(), {
                  dir: asString(args.dir),
                  branch: asString(args.branch),
                  title: asString(args.title),
                  body: asString(args.body),
                }),
              ),
          } satisfies ExposedTool,
        ]
      : []),
    {
      definition: {
        name: 'shell',
        description:
          'Run a bash command in the sandbox; the current directory is the workspace root (cloned repos are in repos/<name>). Node 22, npm/pnpm/yarn, Python 3 with pip/venv, git, ripgrep. Internet only for npm, PyPI and GitHub. Use it to install dependencies, run tests, linters, builds and scripts. Each call is a fresh shell: chain with && and cd inside the command. Background processes are killed when the command ends. Терминал в песочнице.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout_sec: {
              type: 'number',
              description:
                'Default 120, max 600 (for installs and long test runs)',
            },
          },
          required: ['command'],
        },
      },
      run: async (args) =>
        runWorkspaceShell({
          enabled: (await deps.store.getSetting('code_sandbox')) === '1',
          root: root(),
          command: asString(args.command),
          timeoutMs:
            typeof args.timeout_sec === 'number' && args.timeout_sec > 0
              ? Math.min(600, args.timeout_sec) * 1000
              : undefined,
        }),
    },
  );

  const allowedMcp = new Set(agent.mcpServerIds);
  const toolOwner = await deps.store.getUser(userId);
  // Чужой личный коннектор не работает, даже если его id попал в агента.
  // Клиенту (зарегистрировался сам) не работают и общие коннекторы команды.
  const foreign = new Set(
    (await deps.store.listMcp())
      .filter((row) =>
        toolOwner?.client
          ? row.ownerUserId !== userId
          : row.ownerUserId && row.ownerUserId !== userId,
      )
      .map((row) => row.id),
  );
  const servers = deps.mcp
    .listConnected()
    .filter((server) => allowedMcp.has(server.id) && !foreign.has(server.id));
  const totalMcpTools = servers.reduce(
    (sum, server) => sum + server.tools.length,
    0,
  );
  const thresholdRaw =
    (await deps.store.getSetting('lazy_mcp_threshold')) ?? '';
  const threshold =
    thresholdRaw.trim() !== '' && Number.isFinite(Number(thresholdRaw))
      ? Number(thresholdRaw)
      : LAZY_MCP_THRESHOLD;
  if (totalMcpTools > threshold) {
    // Много инструментов: вместо всех схем — каталог коннекторов и два «ленивых» инструмента.
    // Схемы модель запрашивает только для нужного коннектора — экономия тысяч токенов на шаг.
    const catalog = servers
      .map(
        (server) =>
          `${server.name}: ${server.tools.map((tool) => tool.name).join(', ')}`,
      )
      .join('\n');
    const byName = (name: string) =>
      servers.find((server) => server.name === name.trim());
    used.add('connector_tools');
    used.add('connector_call');
    tools.push(
      {
        definition: {
          name: 'connector_tools',
          description: `Get parameter schemas of a connector's tools before calling them. Сначала узнай параметры инструментов коннектора.\nConnectors and their tools:\n${catalog}`,
          inputSchema: {
            type: 'object',
            properties: {
              connector: { type: 'string', enum: servers.map((s) => s.name) },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Only these tools (optional)',
              },
            },
            required: ['connector'],
          },
        },
        run: async (args) => {
          const server = byName(asString(args.connector));
          if (!server) return `Нет коннектора «${asString(args.connector)}».`;
          const only = Array.isArray(args.tools)
            ? args.tools.map((item) => String(item))
            : [];
          const picked = server.tools.filter(
            (tool) => !only.length || only.includes(tool.name),
          );
          return JSON.stringify(
            picked.map((tool) => ({
              name: tool.name,
              description: (tool.description ?? '').slice(0, 300),
              parameters: normalizeSchema(tool),
            })),
          );
        },
      },
      {
        definition: {
          name: 'connector_call',
          description:
            'Call a connector tool (amoCRM, MoySklad, Avito, browser, …) with arguments that match its schema from connector_tools. Вызвать инструмент коннектора.',
          inputSchema: {
            type: 'object',
            properties: {
              connector: { type: 'string', enum: servers.map((s) => s.name) },
              tool: { type: 'string' },
              arguments: { type: 'object' },
            },
            required: ['connector', 'tool'],
          },
        },
        run: async (args) => {
          const server = byName(asString(args.connector));
          if (!server) return `Нет коннектора «${asString(args.connector)}».`;
          const toolName = asString(args.tool);
          if (!server.tools.some((tool) => tool.name === toolName))
            return `У коннектора ${server.name} нет инструмента «${toolName}». Есть: ${server.tools.map((tool) => tool.name).join(', ')}.`;
          const callArgs = isRecord(args.arguments) ? args.arguments : {};
          return deps.mcp.callTool(server.id, toolName, callArgs);
        },
      },
    );
  } else {
    for (const server of servers) {
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
  }
  // Клиенту не даём данные компании: склад и репозитории по токену администратора.
  const companyOnly = new Set([
    'stock_lookup',
    'github_list_repos',
    'github_read_file',
    'github_search_code',
    'github_list_issues',
    'github_list_pulls',
    'github_push',
  ]);
  // Плагины агента: выключенные группы встроенных инструментов не показываем модели.
  return tools.filter(
    (tool) =>
      toolAllowedByPlugins(tool.definition.name, agent.plugins) &&
      !(toolOwner?.client && companyOnly.has(tool.definition.name)),
  );
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
    name === 'connector_call' ||
    name === 'delegate' ||
    name === 'run_code' ||
    name === 'shell' ||
    name === 'workspace_delete' ||
    name === 'github_push' ||
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
      internal: true,
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
/** Больше стольких MCP-инструментов — показываем модели каталог вместо всех схем. */
const LAZY_MCP_THRESHOLD = 15;
/** Старые результаты инструментов и файлы в истории обрезаются до стольких символов. */
const OLD_TOOL_CHARS = 1_500;
const OLD_FILE_CHARS = 2_000;
/** Картинки отправляем только из последних N сообщений пользователя. */
const IMAGE_TURNS = 2;
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
  // Сколько сообщений пользователя уже пройдено от конца: 0 — текущий ход.
  let userTurns = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const model = toModelMessage(message);
    const old = userTurns > 0;
    if (
      message.role === 'tool' &&
      old &&
      model.content.length > OLD_TOOL_CHARS
    ) {
      // Старый результат инструмента: начало и пометка, полный текст в истории не нужен.
      model.content = `${model.content.slice(0, OLD_TOOL_CHARS)}\n…[сокращено для экономии: было ${model.content.length} символов; вызови инструмент снова, если нужны детали]`;
    }
    if (message.role === 'user') userTurns++;
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
          if (userTurns > IMAGE_TURNS) {
            // Картинку модель уже видела в прошлых ответах — повторно не шлём.
            notes.push(
              `[Изображение ${file.name} было приложено раньше — модель уже видела его]`,
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
            ? `[Файл ${file.name}]\n${text.slice(0, userTurns > 1 ? OLD_FILE_CHARS : 20_000)}${userTurns > 1 && text.length > OLD_FILE_CHARS ? '\n…[сокращено: полный текст был в начале разговора]' : ''}`
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
  hooks: {
    before: (messages: ModelMessage[]) => Promise<string>;
    after: (
      id: string,
      usage: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        exact: boolean;
      },
    ) => Promise<void>;
  },
): LLMClient {
  return {
    stream(input) {
      return (async function* () {
        const id = await hooks.before(input.messages);
        let outputChars = 0;
        let reported = false;
        try {
          for await (const event of client.stream(input)) {
            if (event.type === 'usage') {
              reported = true;
              await hooks.after(id, {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cachedTokens: event.cachedTokens ?? 0,
                exact: true,
              });
              continue;
            }
            if (event.type === 'text' || event.type === 'reasoning')
              outputChars += event.delta.length;
            if (event.type === 'tool_call_delta')
              outputChars += (event.argumentsDelta ?? '').length;
            yield event;
          }
        } finally {
          // Провайдер не прислал usage (или поток оборвался) — хотя бы оценим ответ.
          if (!reported && outputChars > 0)
            await hooks
              .after(id, {
                inputTokens: Math.ceil(
                  input.messages.reduce(
                    (sum, message) => sum + message.content.length,
                    0,
                  ) / 4,
                ),
                outputTokens: Math.ceil(outputChars / 4),
                cachedTokens: 0,
                exact: false,
              })
              .catch(() => undefined);
        }
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

/** Контекст проекта для системного промпта. */
async function projectBlock(
  store: Store,
  projectId?: string | null,
): Promise<string> {
  if (!projectId) return '';
  const project = await store.getProject(projectId);
  if (!project) return '';
  return [
    `## Проект: ${project.name}${project.client ? ` (клиент: ${project.client})` : ''}`,
    project.instructions.trim(),
    'Все чаты этого проекта используют одну рабочую папку (workspace_*). Храни там материалы по проекту.',
  ]
    .filter(Boolean)
    .join('\n');
}
