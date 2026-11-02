import type {
  ChatMessage,
  ClientEvent,
  Conversation,
  Locale,
  McpServerInput,
  McpServerPublic,
  McpServersFile,
  ProviderInput,
  ProviderPublic,
  Skill,
  SkillSummary,
} from '@mayak/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new Error('offline');
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean }>('/api/health'),
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
  conversations: () => request<Conversation[]>('/api/conversations'),
  createConversation: (body: {
    locale: Locale;
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
};

export async function streamMessage(
  id: string,
  body: {
    content: string;
    providerId?: string | null;
    model?: string | null;
    locale: Locale;
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
