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
  enabled: boolean;
  hasApiKey: boolean;
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
  providerId: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
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
