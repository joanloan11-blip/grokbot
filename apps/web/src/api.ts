import type {
  Attachment,
  ChatMessage,
  ClientEvent,
  PublicUser,
  UsageRow,
  GithubPreview,
  GithubRepoInfo,
  GithubStatus,
  Agent,
  AgentInput,
  AgentTemplate,
  Conversation,
  Locale,
  MemoryNote,
  Routine,
  RoutineInput,
  McpServerInput,
  McpServerPublic,
  McpServersFile,
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
    },
  ) =>
    request<PublicUser>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  usage: () => request<UsageRow[]>('/api/admin/usage'),
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
  createProvider: (input: ProviderInput) =>
    request<ProviderPublic>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateProvider: (id: string, input: Partial<ProviderInput>) =>
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
  templates: () => request<AgentTemplate[]>('/api/agent-templates'),
  agents: () => request<Agent[]>('/api/agents'),
  createAgent: (input: AgentInput) =>
    request<Agent>('/api/agents', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateAgent: (id: string, input: AgentInput) =>
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
  createConversation: (body: {
    locale: Locale;
    agentId?: string;
    providerId?: string;
    model?: string;
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
  },
  onEvent: (event: ClientEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/conversations/${id}/messages`, {
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
