import type { Agent, ChatMessage, ClientEvent, Locale } from '@mayak/shared';
import { runAgentLoop } from './agent/loop';
import type { Store } from './db';
import { badRequest } from './errors';
import {
  encodeMcpToolName,
  type LiveTool,
  type McpManager,
} from './mcp/manager';
import { LOAD_SKILL_TOOL, buildSystemPrompt } from './prompt';
import { createClient, providerNeedsKey } from './providers/index';
import type { ModelMessage, ToolDefinition } from './providers/types';
import type { SkillLibrary } from './skills';
import { asString, clampText, jsonObject } from './util';

export interface TurnDeps {
  store: Store;
  mcp: McpManager;
  skills: SkillLibrary;
}

interface ExposedTool {
  definition: ToolDefinition;
  run: (args: Record<string, unknown>) => Promise<string>;
}

export interface TurnInput {
  conversationId: string;
  content: string;
  locale: Locale;
  providerId?: string;
  model?: string;
  depth?: number;
  signal?: AbortSignal;
  onEvent?: (event: ClientEvent) => Promise<void>;
}

export async function runTurn(
  deps: TurnDeps,
  input: TurnInput,
): Promise<{ text: string }> {
  const conversation = deps.store.getConversation(input.conversationId);
  if (!conversation) throw badRequest('Чат не найден');
  const agent = conversation.agentId
    ? deps.store.getAgent(conversation.agentId)
    : deps.store.listAgents()[0];
  if (!agent) throw badRequest('Агент не найден');
  const providerId =
    input.providerId ?? conversation.providerId ?? agent.providerId;
  const provider = providerId ? deps.store.getProvider(providerId) : undefined;
  if (!provider?.enabled) throw badRequest('Выберите включённую модель');
  const requested = input.model ?? conversation.model ?? agent.model;
  const model =
    requested && provider.models.includes(requested)
      ? requested
      : provider.models[0];
  if (!model) throw badRequest('У провайдера не задана модель');
  if (providerNeedsKey(provider.kind) && !provider.apiKey) {
    throw badRequest('Сохраните API-ключ провайдера в настройках');
  }

  deps.store.updateConversation(conversation.id, {
    providerId: provider.id,
    model,
  });
  const freshTitle = maybeRetitle(
    deps.store,
    conversation.title,
    input.content,
    conversation.id,
  );
  const userMessage = deps.store.insertMessage({
    conversationId: conversation.id,
    role: 'user',
    content: input.content,
  });
  const emit = input.onEvent ?? (async () => undefined);
  await emit({ type: 'message', message: userMessage });
  if (freshTitle) await emit({ type: 'title', title: freshTitle });

  const depth = input.depth ?? 0;
  const exposed = exposeTools(deps, agent, depth);
  const peers = deps.store
    .listAgents()
    .filter((item) => item.id !== agent.id)
    .map((item) => ({ name: item.name, description: item.description }));
  const history = deps.store.listMessages(conversation.id).map(toModelMessage);
  let pending = '';
  let pendingReasoning = '';
  let finalText = '';
  try {
    await runAgentLoop({
      client: createClient(provider),
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
          const saved = deps.store.insertMessage({
            conversationId: conversation.id,
            role: 'assistant',
            content: event.content,
            toolCalls: event.toolCalls,
            reasoning: event.reasoning,
          });
          await emit({ type: 'message', message: saved });
        } else if (event.type === 'tool_result') {
          const saved = deps.store.insertMessage({
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
        deps.store.insertMessage({
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
    targetName: string;
    message: string;
    depth: number;
    locale: Locale;
    signal?: AbortSignal;
  },
): Promise<string> {
  if (input.depth > 0) return 'Вложенная пересылка между агентами отключена.';
  const target = deps.store.findAgentByName(input.targetName);
  if (!target) {
    const names = deps.store
      .listAgents()
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
  let conversation = deps.store.findConversationByTitle(target.id, title);
  if (!conversation) {
    conversation = deps.store.insertConversation({
      title,
      agentId: target.id,
      providerId: target.providerId,
      model: target.model,
    });
  }
  const result = await runTurn(deps, {
    conversationId: conversation.id,
    content: `Сообщение от агента «${input.from.name}»:\n\n${text}`,
    locale: input.locale,
    depth: input.depth + 1,
    signal: input.signal,
  });
  return result.text.trim() || '(пустой ответ)';
}

function exposeTools(
  deps: TurnDeps,
  agent: Agent,
  depth: number,
): ExposedTool[] {
  const used = new Set<string>([
    LOAD_SKILL_TOOL.name,
    'memory_read',
    'memory_write',
    'send_to_agent',
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
          const notes = deps.store.listMemory(agent.id);
          if (notes.length === 0) return 'Память пуста.';
          return notes
            .map((note) => `## ${note.key}\n${note.content}`)
            .join('\n\n');
        }
        const note = deps.store.getMemory(agent.id, key);
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
        deps.store.writeMemory(agent.id, key, content);
        return `Запомнил «${key}».`;
      },
    },
  ];

  if (depth === 0) {
    const names = deps.store
      .listAgents()
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
          targetName: asString(args.agent),
          message: asString(args.message),
          depth,
          locale: 'ru',
        }),
    });
  }

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

function maybeRetitle(
  store: Store,
  title: string,
  content: string,
  conversationId: string,
): string | undefined {
  if (title !== 'Новый чат' && title !== 'New chat') return undefined;
  const next = clampText(content);
  store.updateConversation(conversationId, { title: next });
  return next;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message === 'Запрос отменён')
  );
}
