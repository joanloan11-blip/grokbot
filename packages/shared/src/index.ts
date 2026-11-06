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
  /** Личный провайдер текущего пользователя (свой ключ). */
  owned?: boolean;
  /** Работает без ключа (анонимный бесплатный доступ). */
  keyless?: boolean;
  /** Провайдеру нужен ключ (у демо и анонимных бесплатных — нет). */
  needsKey?: boolean;
  /** Что умеет каждая модель — по последней проверке. */
  caps?: Record<string, ModelCaps>;
  /** Сейчас идёт проверка моделей. */
  checking?: boolean;
}

/**
 * Результат проверки модели. ok: отвечает ли вообще (null — не удалось проверить:
 * лимит запросов, таймаут). tools: умеет ли вызывать инструменты (MCP, склад, поиск).
 */
export interface ModelCaps {
  ok: boolean | null;
  tools: boolean | null;
  checkedAt: string;
  error?: string;
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
  /** Зарегистрировался сам (клиент): платит за модели, общих коннекторов не видит. */
  client?: boolean;
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

/** Цена модели в долларах за 1 млн токенов. */
export interface ModelPrice {
  input: number;
  cached: number;
  output: number;
}

export interface SpendLine {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** null — для модели нет цены. */
  costUsd: number | null;
  /** Доля вызовов с точными цифрами от провайдера (0…1). */
  exactShare: number;
  /** Вызовы моделей без цены — в сумму не вошли. */
  unpricedCalls: number;
}

export interface SpendReport {
  since: string;
  period: 'day' | 'week' | 'month';
  scope: 'all' | 'mine';
  total: SpendLine;
  agents: (SpendLine & {
    agentId: string | null;
    name: string;
    emoji: string;
    users: (SpendLine & { userId: string; name: string; email: string })[];
    models: (SpendLine & { model: string; provider: string; kind: string })[];
  })[];
  users: (SpendLine & { userId: string; name: string; email: string })[];
  keys: (SpendLine & {
    providerId: string | null;
    name: string;
    models: (SpendLine & {
      model: string;
      price: ModelPrice | null;
      kind: string;
    })[];
  })[];
}

/** Индикатор расхода (как в Codex): сколько процентов лимита за день и неделю. */
export interface UsageWindow {
  usedUsd: number;
  tokens: number;
  calls: number;
  /** null — лимит не задан. */
  limitUsd: number | null;
  /** 0…100+, null — без лимита. */
  percent: number | null;
  resetsAt: string;
}

export interface UsageMeter {
  day: UsageWindow;
  week: UsageWindow;
}

export interface KeyBalance {
  providerId: string;
  name: string;
  /** Что вернул сам провайдер по этому ключу. */
  supported: boolean;
  balance?: number;
  currency?: string;
  used?: number;
  limit?: number | null;
  note?: string;
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
  /** Включённые плагины (встроенные инструменты). null — все. */
  plugins?: string[] | null;
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
  plugins?: string[] | null;
}

/** Плагины — группы встроенных инструментов агента. */
export const AGENT_PLUGINS = [
  {
    id: 'web',
    emoji: '🌐',
    name: 'Интернет',
    description: 'Поиск, свежие новости и чтение страниц',
    tools: ['web_search', 'news_search', 'web_fetch'],
  },
  {
    id: 'stock',
    emoji: '📦',
    name: 'Склад',
    description: 'Наличие и цены из МойСклад (stock_lookup)',
    tools: ['stock_lookup'],
  },
  {
    id: 'images',
    emoji: '🎨',
    name: 'Картинки',
    description: 'Нарисовать или изменить картинку',
    tools: ['generate_image'],
  },
  {
    id: 'files',
    emoji: '🗂',
    name: 'Рабочая папка',
    description: 'Файлы, правки и терминал в папке пользователя',
    tools: [
      'workspace_list',
      'workspace_read',
      'workspace_write',
      'workspace_edit',
      'workspace_delete',
      'workspace_search',
      'workspace_glob',
      'workspace_download',
      'shell',
    ],
  },
  {
    id: 'github',
    emoji: '🐙',
    name: 'Код с GitHub',
    description:
      'Скачать репозиторий, писать код по нему, отдать архив или открыть pull request',
    tools: ['github_clone', 'github_changes', 'github_push'],
  },
  {
    id: 'code',
    emoji: '🧮',
    name: 'Код',
    description: 'Запустить Python или JavaScript в песочнице',
    tools: ['run_code'],
  },
  {
    id: 'memory',
    emoji: '🧠',
    name: 'Память',
    description: 'Запоминать факты между чатами',
    tools: ['memory_read', 'memory_write', 'remember', 'recall'],
  },
  {
    id: 'team',
    emoji: '🧭',
    name: 'Команда агентов',
    description: 'Раздать задачи другим агентам, фоновые задачи',
    tools: ['delegate', 'send_to_agent', 'task'],
  },
  {
    id: 'schedule',
    emoji: '⏰',
    name: 'Расписание',
    description: 'Задачи по расписанию (рутины)',
    tools: ['create_routine'],
  },
  {
    id: 'pages',
    emoji: '📄',
    name: 'Страницы',
    description: 'Отчёт или страница со ссылкой',
    tools: ['create_page'],
  },
  {
    id: 'skills',
    emoji: '🛠',
    name: 'Свои навыки',
    description: 'Агент сам пишет и правит навыки',
    tools: ['skill_manage'],
  },
  {
    id: 'github',
    emoji: '🐙',
    name: 'GitHub',
    description: 'Читать код в подключённых репозиториях',
    tools: ['github_list_repos', 'github_read_file', 'github_search_code'],
  },
] as const;

export type AgentPluginId = (typeof AGENT_PLUGINS)[number]['id'];

/** Инструмент разрешён плагинами агента? Инструменты вне плагинов (ask_user, todo, load_skill, MCP) — всегда. */
export function toolAllowedByPlugins(
  tool: string,
  plugins: string[] | null | undefined,
): boolean {
  if (!plugins) return true;
  const owner = AGENT_PLUGINS.find((plugin) =>
    (plugin.tools as readonly string[]).includes(tool),
  );
  return !owner || plugins.includes(owner.id);
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
  /** Навыки, которые включить. Не задано — все включённые. */
  skillNames?: string[];
  /** MCP-серверы по имени или префиксу (`avito-` — все кабинеты). Не задано — ни одного. */
  mcpNames?: string[];
  /** Включённые плагины. Не задано — все. */
  plugins?: string[];
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
  /** Итог хода под ответом: модель, время, шаги, токены, цена. */
  meta?: MessageMeta;
  createdAt: string;
}

export interface MessageMeta {
  model: string;
  provider?: string;
  /** Время хода, мс. */
  ms: number;
  /** Шагов агента (обращений к модели). */
  steps: number;
  tools: number;
  inputTokens: number;
  outputTokens: number;
  /** null — цена модели неизвестна. */
  costUsd: number | null;
  /** Токены посчитаны провайдером, а не оценены. */
  exact: boolean;
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
  /** Личный коннектор текущего пользователя. */
  owned?: boolean;
  /** Общий коннектор, который администратор открыл менеджерам. */
  forManagers?: boolean;
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
  | { type: 'done' }
  /** Запрос к папке на компьютере пользователя: выполняет браузер. */
  | {
      type: 'local_fs';
      id: string;
      op: string;
      args: Record<string, unknown>;
    }
  /** Сравнение моделей: какие колонки запущены. */
  | { type: 'lanes'; lanes: CompareLane[] }
  /** Событие одной колонки сравнения. */
  | { type: 'lane'; lane: number; event: LaneEvent };

export interface CompareLane {
  conversationId: string;
  providerId: string;
  model: string;
}

/** События колонки — те же, что у обычного чата, кроме вложенных колонок. */
export type LaneEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Инструменты, которые в режиме сравнения выключены: колонки не должны менять одни и те же файлы. */
export const COMPARE_BLOCKED_TOOLS = [
  'workspace_write',
  'workspace_edit',
  'workspace_delete',
  'shell',
  'run_code',
  'github_clone',
  'github_push',
  'skill_manage',
  'create_routine',
  'send_to_agent',
  'delegate',
  'task',
  'generate_image',
  'memory_write',
  'remember',
  'connector_call',
];

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

/** Провайдер с бесплатным доступом из каталога awesome-free-llm-apis (CC0). */
export interface FreeProvider {
  id: string;
  name: string;
  country: string;
  flag: string;
  /** Где получить ключ. */
  keyUrl: string;
  /** Адрес для QASTOM AGENT (OpenAI-совместимый или Gemini). */
  baseUrl: string;
  kind: ProviderKind;
  /** false — работает без ключа. */
  needsKey: boolean;
  description: string;
  /** Важное: логирование промптов, проверка личности, ограничения региона. */
  notes: string[];
  /** Через прокси QASTOM AGENT (провайдер закрыт из России). */
  viaProxy: boolean;
  models: {
    id: string;
    context?: string;
    rateLimit?: string;
    modality?: string;
  }[];
}

export interface FreeCatalog {
  lastUpdated: string;
  source: string;
  providers: FreeProvider[];
}

/** NVIDIA build.nvidia.com: бесплатный доступ для разработки, OpenAI-совместимый. */
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export function isNvidiaUrl(url: string): boolean {
  return /integrate\.api\.nvidia\.com/i.test(url);
}

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
  if (key.startsWith('hf_'))
    return [
      {
        kind: 'openai',
        baseUrl: 'https://router.huggingface.co/v1',
        name: 'Hugging Face',
      },
    ];
  if (key.startsWith('nvapi-'))
    return [{ kind: 'openai', baseUrl: NVIDIA_BASE_URL, name: 'NVIDIA' }];
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

/** Тариф: оплата за период, в цену входит лимит расходов на модели (в рублях по розничной цене). */
export interface BillingPlan {
  id: string;
  name: string;
  priceRub: number;
  /** Сколько рублей расходов на платные модели входит в тариф за период. */
  includedRub: number;
  days: number;
  description?: string;
}

export interface BillingPaymentRow {
  id: string;
  kind: 'topup' | 'plan' | 'renew' | 'manual' | string;
  amountRub: number;
  status: string;
  description: string | null;
  createdAt: string;
}

/** Что видит пользователь в разделе «Оплата». */
export interface BillingState {
  /** Оплата включена администратором и касается этого пользователя (клиент). */
  applies: boolean;
  enabled: boolean;
  trial: { limitUsd: number; usedUsd: number; providers: string };
  balanceRub: number;
  plan: { id: string; name: string; until: string; leftRub: number } | null;
  autorenew: boolean;
  canAutorenew: boolean;
  plans: BillingPlan[];
  topups: number[];
  payments: BillingPaymentRow[];
  /** Курс и наценка в одном числе: сколько ₽ стоит $1 расходов модели. */
  rubPerUsd: number;
  /** Платные модели сейчас недоступны (пробные исчерпаны, денег нет). */
  blocked: boolean;
}

/** Настройки оплаты для администратора (секретный ключ не возвращается). */
export interface BillingSettings {
  enabled: boolean;
  shopId: string;
  hasSecret: boolean;
  usdRub: number;
  markup: number;
  trialUsd: number;
  /** Хосты, на которые тратятся пробные доллары (по умолчанию api.openai.com). */
  trialHosts: string[];
  plans: BillingPlan[];
  topups: number[];
  receipts: boolean;
  vatCode: number;
  recurring: boolean;
  webhookUrl: string;
}
