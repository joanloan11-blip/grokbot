import type {
  BillingSettings,
  BillingState,
  Attachment,
  DiscoverResult,
  ProviderKind,
  ChatMessage,
  CheckpointInfo,
  RestoreCheckpointResult,
  TodoItem,
  UsageMeter,
  FreeCatalog,
  ClientEvent,
  PublicUser,
  UsageRow,
  SpendReport,
  KeyBalance,
  ModelPrice,
  GithubPreview,
  GithubRepoInfo,
  GithubStatus,
  Agent,
  AgentInput,
  AgentTemplate,
  Conversation,
  Locale,
  MemoryNote,
  MailAccountInput,
  MailAccountStatus,
  MailDigestState,
  TelegramBotInput,
  TelegramBotState,
  Routine,
  RoutineInput,
  McpServerInput,
  McpServerPublic,
  McpServersFile,
  Project,
  ProjectInput,
  ProviderInput,
  ProviderPublic,
  SearchHit,
  Skill,
  SkillSummary,
} from '@mayak/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (
    init?.body &&
    !(init.body instanceof FormData) &&
    !headers.has('content-type')
  )
    headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: 'include' });
  } catch {
    throw new Error('offline');
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new ApiError(
      data.error || `HTTP ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = {
  health: () => request<{ ok: boolean; auth?: boolean }>('/api/health'),
  usageMeter: () => request<UsageMeter>('/api/usage/meter'),
  billing: () => request<BillingState>('/api/billing'),
  localFsReply: (id: string, body: { result?: unknown; error?: string }) =>
    request<{ ok: boolean }>(`/api/local-fs/${id}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  billingRefresh: () =>
    request<BillingState>('/api/billing/refresh', { method: 'POST' }),
  billingPay: (
    body:
      | { kind: 'topup'; amountRub: number }
      | { kind: 'plan'; planId: string },
  ) =>
    request<{ id: string; url: string }>('/api/billing/pay', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  billingAutorenew: (on: boolean) =>
    request<BillingState>('/api/billing/autorenew', {
      method: 'POST',
      body: JSON.stringify({ on }),
    }),
  billingSettings: () => request<BillingSettings>('/api/admin/billing'),
  saveBillingSettings: (
    body: Partial<BillingSettings> & { secretKey?: string },
  ) =>
    request<BillingSettings>('/api/admin/billing', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  userBilling: (id: string) =>
    request<BillingState>(`/api/admin/billing/users/${id}`),
  creditUser: (
    id: string,
    body: { amountRub?: number; note?: string; resetTrial?: boolean },
  ) =>
    request<BillingState>(`/api/admin/billing/users/${id}/credit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  budgets: (userId: string) =>
    request<{ day: number | null; week: number | null }>(
      `/api/admin/budgets/${userId}`,
    ),
  saveBudgets: (
    userId: string,
    body: { day?: number | null; week?: number | null },
  ) =>
    request<{ ok: boolean }>(`/api/admin/budgets/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  checkAllModels: () =>
    request<{ started: number }>('/api/providers/check-all', {
      method: 'POST',
    }),
  checkModels: (id: string) =>
    request<{ started: boolean }>(`/api/providers/${id}/check`, {
      method: 'POST',
    }),
  freeProviders: () => request<FreeCatalog>('/api/free-providers'),
  refreshFreeProviders: () =>
    request<FreeCatalog>('/api/admin/free-providers/refresh', {
      method: 'POST',
    }),
  editMessage: (id: string, content: string) =>
    request<ChatMessage>(`/api/messages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),
  rewindMessage: (id: string) =>
    request<{ ok: boolean; attachments: string[] }>(
      `/api/messages/${id}/rewind`,
      { method: 'POST' },
    ),
  authConfig: () => request<{ required: boolean }>('/api/auth/config'),
  me: () => request<{ user: PublicUser }>('/api/auth/me'),
  register: (body: { email: string; password: string; name?: string }) =>
    request<{ user: PublicUser; pending: boolean }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  login: (body: { email: string; password: string }) =>
    request<{ user: PublicUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  acceptInvite: (body: { token: string; password: string; name?: string }) =>
    request<{ user: PublicUser }>('/api/auth/accept', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  logout: () =>
    request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  forgotPassword: (body: { email: string; locale: Locale }) =>
    request<{ ok: boolean; mail: boolean }>('/api/auth/forgot', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  resetPassword: (body: { token: string; password: string }) =>
    request<{ ok: boolean; user?: PublicUser; pending?: boolean }>(
      '/api/auth/reset',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  resetLink: (userId: string) =>
    request<{ link: string; expiresAt: string }>(
      `/api/admin/users/${userId}/reset-link`,
      {
        method: 'POST',
      },
    ),
  team: () => request<PublicUser[]>('/api/admin/users'),
  inviteUser: (body: {
    email: string;
    name?: string;
    agentIds?: string[];
    dailyRequestLimit?: number | null;
  }) =>
    request<{ user: PublicUser; inviteToken: string }>(
      '/api/admin/users/invite',
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  setSharedModels: (models: { providerId: string; model: string }[]) =>
    request<{ models: { providerId: string; model: string }[] }>(
      '/api/admin/models/shared',
      { method: 'PUT', body: JSON.stringify({ models }) },
    ),
  updateUser: (
    id: string,
    body: {
      name?: string;
      status?: PublicUser['status'];
      dailyRequestLimit?: number | null;
      agentIds?: string[];
      modelsRestricted?: boolean;
      models?: { providerId: string; model: string }[];
      client?: boolean;
    },
  ) =>
    request<PublicUser>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  usage: () => request<UsageRow[]>('/api/admin/usage'),
  spend: (period: SpendReport['period'], scope: SpendReport['scope']) =>
    request<SpendReport>(`/api/usage/report?period=${period}&scope=${scope}`),
  balances: () => request<KeyBalance[]>('/api/admin/usage/balances'),
  prices: () =>
    request<{
      defaults: Record<string, ModelPrice>;
      overrides: Record<string, ModelPrice>;
    }>('/api/admin/prices'),
  savePrices: (overrides: Record<string, ModelPrice>) =>
    request<{
      defaults: Record<string, ModelPrice>;
      overrides: Record<string, ModelPrice>;
    }>('/api/admin/prices', {
      method: 'PUT',
      body: JSON.stringify({ overrides }),
    }),
  githubStatus: () => request<GithubStatus>('/api/github/status'),
  saveGithubToken: (token: string) =>
    request<GithubStatus>('/api/github/token', {
      method: 'PUT',
      body: JSON.stringify({ token }),
    }),
  disconnectGithub: () =>
    request<GithubStatus>('/api/github/token', { method: 'DELETE' }),
  githubOauthUrl: () => request<{ url: string }>('/api/github/oauth/start'),
  githubRepos: () => request<GithubRepoInfo[]>('/api/github/repos'),
  previewGithub: (repo: string) =>
    request<GithubPreview>('/api/github/import/preview', {
      method: 'POST',
      body: JSON.stringify({ repo }),
    }),
  confirmGithub: (body: {
    id: string;
    confirm: true;
    command: string;
    args: string[];
    name?: string;
    enabled?: boolean;
    skillNames?: string[];
  }) =>
    request<{ server: McpServerPublic; skills: string[] }>(
      '/api/github/import/confirm',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  officialGithub: (mode: 'http' | 'docker') =>
    request<McpServerPublic>('/api/github/mcp/official', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  providers: () => request<ProviderPublic[]>('/api/providers'),
  discoverProvider: (body: {
    apiKey?: string;
    baseUrl?: string;
    kind?: ProviderKind;
    models?: string[];
    providerId?: string;
  }) =>
    request<DiscoverResult>('/api/providers/discover', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createProvider: (input: ProviderInput & { keyFromProviderId?: string }) =>
    request<ProviderPublic>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateProvider: (
    id: string,
    input: Partial<ProviderInput> & { keyFromProviderId?: string },
  ) =>
    request<ProviderPublic>(`/api/providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteProvider: (id: string) =>
    request<{ ok: boolean }>(`/api/providers/${id}`, { method: 'DELETE' }),
  testProvider: (id: string) =>
    request<{ ok: boolean; preview?: string; error?: string }>(
      `/api/providers/${id}/test`,
      { method: 'POST' },
    ),
  mcp: () => request<McpServerPublic[]>('/api/mcp'),
  mcpConfig: () => request<McpServersFile>('/api/mcp/config'),
  importMcp: (file: McpServersFile) =>
    request<McpServerPublic[]>('/api/mcp/import', {
      method: 'POST',
      body: JSON.stringify(file),
    }),
  createMcp: (input: McpServerInput) =>
    request<McpServerPublic>('/api/mcp', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateMcp: (id: string, input: Partial<McpServerInput>) =>
    request<McpServerPublic>(`/api/mcp/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteMcp: (id: string) =>
    request<{ ok: boolean }>(`/api/mcp/${id}`, { method: 'DELETE' }),
  skills: () =>
    request<{ directory: string; skills: SkillSummary[] }>('/api/skills'),
  skill: (name: string) =>
    request<Skill>(`/api/skills/${encodeURIComponent(name)}`),
  saveSkill: (skill: Skill) =>
    request<Skill>(`/api/skills/${encodeURIComponent(skill.name)}`, {
      method: 'PUT',
      body: JSON.stringify(skill),
    }),
  deleteSkill: (name: string) =>
    request<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  inbox: () =>
    request<{
      items: {
        id: string;
        toolName: string;
        preview: string;
        conversationId: string;
        conversationTitle: string;
        agentName: string;
        createdAt: string;
      }[];
    }>('/api/inbox'),
  servers: () =>
    request<{
      hosts: {
        id: string;
        name: string;
        host: string;
        port: number;
        user: string;
      }[];
    }>('/api/servers'),
  addServer: (input: {
    name?: string;
    host: string;
    port?: number;
    user: string;
    privateKey: string;
  }) =>
    request<{ host: { id: string; name: string }; probe: string }>(
      '/api/servers',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  testServer: (id: string) =>
    request<{ probe: string }>(`/api/servers/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
  deleteServer: (id: string) =>
    request<{ ok: boolean }>(`/api/servers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  avitoStatus: () =>
    request<{
      connected: boolean;
      clientId?: string;
      profileId?: string;
      name?: string;
      connectedAt?: string;
    }>('/api/avito'),
  saveAvito: (input: {
    clientId: string;
    clientSecret: string;
    profileId: string;
  }) =>
    request<{ connected: boolean; name?: string; profileId: string }>(
      '/api/avito',
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  deleteAvito: () =>
    request<{ ok: boolean; connected: boolean }>('/api/avito', {
      method: 'DELETE',
    }),
  /** Личная почта: подключение ящика и ежедневная выжимка. */
  mailStatus: () => request<MailAccountStatus>('/api/mail'),
  saveMail: (input: MailAccountInput) =>
    request<{ ok: boolean; messages?: number }>('/api/mail', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  testMail: (input: MailAccountInput) =>
    request<{ ok: boolean; messages?: number; error?: string }>(
      '/api/mail/test',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  deleteMail: () => request<{ ok: boolean }>('/api/mail', { method: 'DELETE' }),
  mailDigestNow: () =>
    request<{ ok: boolean; error?: string }>('/api/mail/digest', {
      method: 'POST',
    }),
  saveMailDigest: (input: { enabled?: boolean; cron?: string }) =>
    request<MailDigestState>('/api/mail/digest', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** Личный Telegram-бот агента «Джарвис». */
  telegramStatus: () => request<TelegramBotState>('/api/telegram'),
  saveTelegram: (input: TelegramBotInput) =>
    request<TelegramBotState>('/api/telegram', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  testTelegram: () =>
    request<{ ok: boolean; error?: string }>('/api/telegram/test', {
      method: 'POST',
    }),
  deleteTelegram: () =>
    request<{ ok: boolean }>('/api/telegram', { method: 'DELETE' }),
  templates: () => request<AgentTemplate[]>('/api/agent-templates'),
  agents: () => request<Agent[]>('/api/agents'),
  createAgent: (input: AgentInput) =>
    request<Agent>('/api/agents', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateAgent: (id: string, input: AgentInput & { shared?: boolean }) =>
    request<Agent>(`/api/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteAgent: (id: string) =>
    request<{ ok: boolean }>(`/api/agents/${id}`, { method: 'DELETE' }),
  memory: (agentId: string) =>
    request<MemoryNote[]>(`/api/agents/${agentId}/memory`),
  saveMemory: (agentId: string, key: string, content: string) =>
    request<MemoryNote>(
      `/api/agents/${agentId}/memory/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      },
    ),
  deleteMemory: (agentId: string, key: string) =>
    request<{ ok: boolean }>(
      `/api/agents/${agentId}/memory/${encodeURIComponent(key)}`,
      {
        method: 'DELETE',
      },
    ),
  routines: (agentId: string) =>
    request<Routine[]>(`/api/agents/${agentId}/routines`),
  createRoutine: (agentId: string, input: RoutineInput) =>
    request<Routine>(`/api/agents/${agentId}/routines`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateRoutine: (agentId: string, id: string, input: RoutineInput) =>
    request<Routine>(`/api/agents/${agentId}/routines/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteRoutine: (agentId: string, id: string) =>
    request<{ ok: boolean }>(`/api/agents/${agentId}/routines/${id}`, {
      method: 'DELETE',
    }),
  routineRuns: (agentId: string, id: string) =>
    request<import('@mayak/shared').RoutineRun[]>(
      `/api/agents/${agentId}/routines/${id}/runs`,
    ),
  runRoutine: (agentId: string, id: string) =>
    request<{ ok: boolean }>(`/api/agents/${agentId}/routines/${id}/run`, {
      method: 'POST',
      body: '{}',
    }),
  conversations: (agentId?: string) =>
    request<Conversation[]>(
      agentId
        ? `/api/conversations?agentId=${encodeURIComponent(agentId)}`
        : '/api/conversations',
    ),
  projects: () => request<Project[]>('/api/projects'),
  createProject: (input: ProjectInput & { name: string }) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateProject: (id: string, input: ProjectInput) =>
    request<Project>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  projectConversations: (projectId: string) =>
    request<Conversation[]>(
      `/api/conversations?projectId=${encodeURIComponent(projectId)}`,
    ),
  imageSettings: () =>
    request<{
      enabled: boolean;
      providerId: string | null;
      model: string;
      quality: string;
      dailyLimit: number;
      usedToday: number;
      providers: { id: string; name: string; baseUrl: string }[];
    }>('/api/admin/images'),
  saveImageSettings: (body: {
    enabled?: boolean;
    providerId?: string;
    model?: string;
    quality?: string;
    dailyLimit?: number;
  }) =>
    request<{ enabled: boolean }>('/api/admin/images', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  moysklad: () =>
    request<{ connected: boolean; account?: string; error?: string }>(
      '/api/admin/moysklad',
    ),
  saveMoysklad: (token: string) =>
    request<{ connected: boolean; account?: string }>('/api/admin/moysklad', {
      method: 'PUT',
      body: JSON.stringify({ token }),
    }),
  createConversation: (body: {
    locale: Locale;
    agentId?: string;
    providerId?: string;
    model?: string;
    projectId?: string | null;
  }) =>
    request<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  conversation: (id: string) =>
    request<{ conversation: Conversation; messages: ChatMessage[] }>(
      `/api/conversations/${id}`,
    ),
  updateConversation: (
    id: string,
    patch: Partial<Pick<Conversation, 'title' | 'providerId' | 'model'>>,
  ) =>
    request<Conversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteConversation: (id: string) =>
    request<{ ok: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),
  checkpoints: (conversationId: string) =>
    request<{ checkpoints: CheckpointInfo[] }>(
      `/api/conversations/${conversationId}/checkpoints`,
    ),
  restoreCheckpoint: (conversationId: string, checkpointId: string) =>
    request<RestoreCheckpointResult>(
      `/api/conversations/${conversationId}/checkpoints/${checkpointId}/restore`,
      { method: 'POST' },
    ),
  todos: (agentId: string) =>
    request<{ todos: TodoItem[] }>(`/api/agents/${agentId}/todos`),
  setTodo: (todoId: string, done: boolean) =>
    request<{ ok: boolean }>(`/api/todos/${todoId}`, {
      method: 'PATCH',
      body: JSON.stringify({ done }),
    }),
  uploadFile: async (
    conversationId: string,
    file: File,
  ): Promise<Attachment> => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<Attachment>(`/api/conversations/${conversationId}/files`, {
      method: 'POST',
      body: form,
    });
  },
  search: (query: string) =>
    request<SearchHit[]>(`/api/search?q=${encodeURIComponent(query)}`),
  transcribe: async (audio: Blob, locale: Locale): Promise<string> => {
    const form = new FormData();
    form.append('file', audio, 'voice.webm');
    const data = await request<{ text: string }>(
      `/api/transcribe?lang=${locale}`,
      {
        method: 'POST',
        body: form,
      },
    );
    return data.text;
  },
};

export async function streamMessage(
  id: string,
  body: {
    content: string;
    providerId?: string | null;
    model?: string | null;
    locale: Locale;
    attachments?: string[];
    /** Имя папки на компьютере: агент работает с файлами через браузер. */
    localFolder?: string;
  },
  onEvent: (event: ClientEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamSse(`/api/conversations/${id}/messages`, body, onEvent, signal);
}

/** Сравнение: тот же вопрос 2–3 моделям, события приходят с номером колонки. */
export async function streamCompare(
  id: string,
  body: {
    content: string;
    locale: Locale;
    lanes: { providerId: string; model: string }[];
    attachments?: string[];
  },
  onEvent: (event: ClientEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamSse(`/api/conversations/${id}/compare`, body, onEvent, signal);
}

export function adoptCompare(id: string, lane: string) {
  return request<{ conversation: Conversation; messages: ChatMessage[] }>(
    `/api/conversations/${id}/compare/adopt`,
    { method: 'POST', body: JSON.stringify({ lane }) },
  );
}

async function streamSse(
  url: string,
  body: unknown,
  onEvent: (event: ClientEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const line = block.split('\n').find((item) => item.startsWith('data:'));
      if (line) onEvent(JSON.parse(line.slice(5).trim()) as ClientEvent);
      split = buffer.indexOf('\n\n');
    }
  }
}
