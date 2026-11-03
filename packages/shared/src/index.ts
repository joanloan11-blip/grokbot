export type Locale = 'ru' | 'en';

export type ProviderKind =
  | 'openai'
  | 'deepseek'
  | 'anthropic'
  | 'gemini'
  | 'mock';

/** OpenAI-совместимый endpoint DeepSeek. К пути добавляется `/chat/completions`. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export const DEEPSEEK_MODELS = ['deepseek-chat', 'deepseek-reasoner'] as const;

export interface ProviderPublic {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  models: string[];
  /** Модели этого провайдера, которые админ открыл менеджерам. */
  managerModels: string[];
  enabled: boolean;
  hasApiKey: boolean;
}

export interface ModelRef {
  providerId: string;
  model: string;
}

export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
  enabled?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  agentId: string | null;
  userId: string | null;
  providerId: string | null;
  model: string | null;
  /** Проект (клиент/сделка), к которому относится чат. */
  projectId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  /** Клиент или компания, необязательно. */
  client: string;
  /** Контекст и правила проекта: агент получает их в каждом чате проекта. */
  instructions: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name?: string;
  client?: string;
  instructions?: string;
  archived?: boolean;
}

export type UserRole = 'admin' | 'manager';
export type UserStatus = 'active' | 'pending' | 'disabled';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  dailyRequestLimit: number | null;
  agentIds: string[];
  /** false — все модели из общего списка. true — только `models`. */
  modelsRestricted: boolean;
  models: ModelRef[];
  createdAt: string;
}

export interface UsageModelCount {
  model: string;
  calls: number;
}

export interface UsageRow {
  userId: string;
  email: string;
  name: string;
  calls: number;
  limit: number | null;
  tokens?: number;
  costUsd?: number;
  models: UsageModelCount[];
}

export interface Agent {
  id: string;
  name: string;
  emoji: string;
  description: string;
  systemPrompt: string;
  providerId: string | null;
  model: string | null;
  mcpServerIds: string[];
  skillNames: string[];
  /** Репозитории owner/name, которые агент может читать через GitHub. */
  githubRepos: string[];
  /** Личный агент менеджера (null — общий агент команды). */
  ownerId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInput {
  name?: string;
  emoji?: string;
  description?: string;
  systemPrompt?: string;
  providerId?: string | null;
  model?: string | null;
  mcpServerIds?: string[];
  skillNames?: string[];
  githubRepos?: string[];
}

export interface GithubStatus {
  connected: boolean;
  login: string | null;
  oauth: boolean;
  error?: string;
}

export interface GithubRepoInfo {
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
}

export interface GithubSkillPreview {
  name: string;
  description: string;
}

export interface GithubPreview {
  id: string;
  repo: string;
  kind: 'node' | 'python' | 'docker' | 'config' | 'unknown';
  summary: string;
  command: string;
  args: string[];
  skills: GithubSkillPreview[];
}

export interface AgentTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  systemPrompt: string;
}

export interface MemoryNote {
  agentId: string;
  key: string;
  content: string;
  updatedAt: string;
}

export interface Routine {
  id: string;
  agentId: string;
  userId: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  webhookToken: string | null;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  status: 'running' | 'ok' | 'error';
  output: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RoutineInput {
  name?: string;
  cron?: string;
  prompt?: string;
  enabled?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
}

export interface SearchHit {
  conversationId: string;
  title: string;
  agentId: string | null;
  snippet: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** Текст рассуждения (DeepSeek reasoner, поле `reasoning_content`). Не уходит обратно в API. */
  reasoning?: string;
  /** Файлы, приложенные к сообщению пользователя. */
  attachments?: Attachment[];
  createdAt: string;
}

export type McpStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpServerPublic {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
  hasEnv: boolean;
  hasHeaders: boolean;
  status: McpStatus;
  error?: string;
  tools: McpToolInfo[];
}

export interface McpServerInput {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** Фрагмент общепринятого формата `mcpServers` (Claude Desktop / Cursor). */
export interface McpServerConfigEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpServersFile {
  mcpServers: Record<string, McpServerConfigEntry>;
}

export interface SkillSummary {
  name: string;
  description: string;
  enabled: boolean;
}

export interface Skill extends SkillSummary {
  body: string;
}

export type ClientEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'title'; title: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Подставляется вместо секретов в ответах API. При сохранении такое значение не затирает секрет. */
export const SECRET_MASK = '••••••';

export const DEFAULT_TITLES = ['Новый чат', 'New chat'] as const;

// ---------- Автоопределение провайдера по ключу и по имени модели ----------

export interface ProviderGuess {
  kind: ProviderKind;
  baseUrl: string;
  name: string;
}

const OPENAI_URL = 'https://api.openai.com/v1';

/** Тип провайдера по префиксу ключа. Для «голого» sk-… вернёт несколько вариантов. */
export function guessProvidersFromKey(rawKey: string): ProviderGuess[] {
  const key = rawKey.trim();
  if (!key) return [];
  if (key.startsWith('sk-ant-'))
    return [
      {
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        name: 'Anthropic',
      },
    ];
  if (key.startsWith('AIza'))
    return [
      {
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        name: 'Google Gemini',
      },
    ];
  if (key.startsWith('sk-or-'))
    return [
      {
        kind: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        name: 'OpenRouter',
      },
    ];
  if (key.startsWith('gsk_'))
    return [
      {
        kind: 'openai',
        baseUrl: 'https://api.groq.com/openai/v1',
        name: 'Groq',
      },
    ];
  if (key.startsWith('xai-'))
    return [
      { kind: 'openai', baseUrl: 'https://api.x.ai/v1', name: 'xAI Grok' },
    ];
  if (key.startsWith('pplx-'))
    return [
      {
        kind: 'openai',
        baseUrl: 'https://api.perplexity.ai',
        name: 'Perplexity',
      },
    ];
  if (
    key.startsWith('sk-proj-') ||
    key.startsWith('sk-svcacct-') ||
    key.startsWith('sk-admin-')
  )
    return [{ kind: 'openai', baseUrl: OPENAI_URL, name: 'OpenAI' }];
  if (key.startsWith('sk-')) {
    // DeepSeek и старые ключи OpenAI выглядят одинаково: проверяем оба.
    return [
      { kind: 'deepseek', baseUrl: DEEPSEEK_BASE_URL, name: 'DeepSeek' },
      { kind: 'openai', baseUrl: OPENAI_URL, name: 'OpenAI' },
    ];
  }
  return [];
}

/** Тип провайдера по имени модели (для вручную введённых моделей). */
export function guessProviderFromModel(
  rawModel: string,
): ProviderGuess | undefined {
  const model = rawModel.trim().toLowerCase();
  if (!model) return undefined;
  if (model.startsWith('claude'))
    return {
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      name: 'Anthropic',
    };
  if (model.startsWith('gemini') || model.startsWith('gemma'))
    return {
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      name: 'Google Gemini',
    };
  if (model.startsWith('deepseek'))
    return { kind: 'deepseek', baseUrl: DEEPSEEK_BASE_URL, name: 'DeepSeek' };
  if (model.startsWith('grok'))
    return { kind: 'openai', baseUrl: 'https://api.x.ai/v1', name: 'xAI Grok' };
  if (model.includes('/'))
    return {
      kind: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      name: 'OpenRouter',
    };
  if (/^(gpt|o\d|chatgpt|text-|davinci)/.test(model))
    return { kind: 'openai', baseUrl: OPENAI_URL, name: 'OpenAI' };
  return undefined;
}

export interface DiscoverResult {
  kind: ProviderKind;
  baseUrl: string;
  name: string;
  models: string[];
  /** Ключ не введён, но есть сохранённый ключ этого типа у другого провайдера. */
  keyFrom?: { providerId: string; name: string };
  /** Ключ проверен запросом списка моделей. */
  verified: boolean;
  /** Модели, ответившие на пробный запрос. */
  working?: string[];
  /** Модели, которые провайдер отклонил (удалены, отключены, не для чата). */
  failed?: string[];
  error?: string;
}
