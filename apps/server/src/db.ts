import { createPostgresSql, createSqliteSql, type Sql } from './sql';
import type {
  Agent,
  AgentInput,
  ChatMessage,
  Conversation,
  McpServerInput,
  MemoryNote,
  ProviderInput,
  ProviderKind,
  ProviderPublic,
  Routine,
  RoutineInput,
  ToolCall,
} from '@mayak/shared';
import { newId, nowIso } from './util';

export interface ProviderRow {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
  createdAt: string;
}

export interface McpRow {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: string;
}

interface ProviderSql {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  api_key: string;
  models_json: string;
  enabled: number;
  created_at: string;
}

interface McpSql {
  id: string;
  name: string;
  transport: string;
  command: string;
  args_json: string;
  env_json: string;
  url: string;
  headers_json: string;
  enabled: number;
  created_at: string;
}

interface ConversationSql {
  id: string;
  title: string;
  agent_id: string | null;
  user_id: string | null;
  provider_id: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentSql {
  id: string;
  name: string;
  emoji: string;
  description: string;
  system_prompt: string;
  provider_id: string | null;
  model: string | null;
  mcp_ids_json: string;
  skill_names_json: string;
  created_at: string;
  updated_at: string;
}

interface MemorySql {
  user_id: string | null;
  agent_id: string;
  note_key: string;
  content: string;
  updated_at: string;
}

interface RoutineSql {
  id: string;
  agent_id: string;
  user_id: string | null;
  name: string;
  cron: string;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
  webhook_token?: string | null;
}

interface MessageSql {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  reasoning: string | null;
  created_at: string;
}

function parseStringArray(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseRecord(json: string): Record<string, string> {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string') out[key] = item;
    }
    return out;
  } catch {
    return {};
  }
}

function parseToolCalls(json: string | null): ToolCall[] | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return undefined;
    const calls: ToolCall[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string' || typeof record.name !== 'string')
        continue;
      calls.push({
        id: record.id,
        name: record.name,
        arguments:
          typeof record.arguments === 'string' ? record.arguments : '{}',
      });
    }
    return calls.length ? calls : undefined;
  } catch {
    return undefined;
  }
}

export function toPublicProvider(row: ProviderRow): ProviderPublic {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    models: row.models,
    enabled: row.enabled,
    hasApiKey: row.apiKey.length > 0,
    managerModels: [],
  };
}

export class Store {
  private constructor(private readonly sql: Sql) {}

  static async open(config: {
    dataDir: string;
    databaseUrl?: string;
  }): Promise<Store> {
    const sql = config.databaseUrl
      ? await createPostgresSql(config.databaseUrl)
      : createSqliteSql(config.dataDir);
    const store = new Store(sql);
    await store.migrate();
    return store;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  private async migrate(): Promise<void> {
    await this.sql.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        models_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL,
        command TEXT NOT NULL DEFAULT '',
        args_json TEXT NOT NULL DEFAULT '[]',
        env_json TEXT NOT NULL DEFAULT '{}',
        url TEXT NOT NULL DEFAULT '',
        headers_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        provider_id TEXT,
        model TEXT,
        mcp_ids_json TEXT NOT NULL DEFAULT '[]',
        skill_names_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_memory (
        user_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL,
        note_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, agent_id, note_key)
      );

      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent_id TEXT,
        user_id TEXT,
        provider_id TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls_json TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        reasoning TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    if (!(await this.hasColumn('messages', 'reasoning'))) {
      await this.sql.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT');
    }
    if (!(await this.hasColumn('conversations', 'agent_id'))) {
      await this.sql.exec('ALTER TABLE conversations ADD COLUMN agent_id TEXT');
    }
    await this.ensureUserColumns();
    await this.ensurePlatform();
  }

  private async ensurePlatform(): Promise<void> {
    const add = async (table: string, column: string, ddl: string) => {
      if (!(await this.hasColumn(table, column))) await this.sql.exec(ddl);
    };
    await add(
      'routines',
      'webhook_token',
      'ALTER TABLE routines ADD COLUMN webhook_token TEXT',
    );
    await add(
      'usage_events',
      'input_tokens',
      'ALTER TABLE usage_events ADD COLUMN input_tokens INTEGER',
    );
    await add(
      'usage_events',
      'output_tokens',
      'ALTER TABLE usage_events ADD COLUMN output_tokens INTEGER',
    );
    await add(
      'users',
      'daily_token_limit',
      'ALTER TABLE users ADD COLUMN daily_token_limit INTEGER',
    );
    await this.sql.exec(`
      CREATE TABLE IF NOT EXISTS routine_runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        note_key TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_entries(user_id, kind);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation_id TEXT,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        share_token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        conversation_id TEXT,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        path TEXT NOT NULL,
        text_content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      );
      CREATE TABLE IF NOT EXISTS telegram_links (
        telegram_chat_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT
      );
    `);
  }

  private async hasColumn(table: string, column: string): Promise<boolean> {
    if (this.sql.dialect === 'postgres') {
      const row = await this.sql.get<{ ok: number }>(
        'SELECT 1 AS ok FROM information_schema.columns WHERE table_name = ? AND column_name = ?',
        [table, column],
      );
      return Boolean(row);
    }
    const columns = await this.sql.all<{ name: string }>(
      `PRAGMA table_info(${table})`,
      [],
    );
    return columns.some((item) => item.name === column);
  }

  private async ensureUserColumns(): Promise<void> {
    const add = async (table: string, column: string, ddl: string) => {
      if (!(await this.hasColumn(table, column))) await this.sql.exec(ddl);
    };
    await this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        daily_request_limit INTEGER,
        invite_token_hash TEXT,
        models_restricted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_repos (
        agent_id TEXT NOT NULL,
        full_name TEXT NOT NULL,
        PRIMARY KEY (agent_id, full_name)
      );
      CREATE TABLE IF NOT EXISTS model_access (
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (provider_id, model, user_id)
      );
      CREATE TABLE IF NOT EXISTS user_agents (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        PRIMARY KEY (user_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider_id TEXT,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events(user_id, created_at);
    `);
    await add(
      'conversations',
      'user_id',
      'ALTER TABLE conversations ADD COLUMN user_id TEXT',
    );
    await add(
      'routines',
      'user_id',
      'ALTER TABLE routines ADD COLUMN user_id TEXT',
    );
    await add(
      'users',
      'invite_token_hash',
      'ALTER TABLE users ADD COLUMN invite_token_hash TEXT',
    );
    await add(
      'users',
      'models_restricted',
      'ALTER TABLE users ADD COLUMN models_restricted INTEGER NOT NULL DEFAULT 0',
    );
    await this.rebuildMemoryTable();
  }

  private async rebuildMemoryTable(): Promise<void> {
    if (this.sql.dialect !== 'sqlite') return;
    const info = await this.sql.all<{ name: string; pk: number }>(
      'PRAGMA table_info(agent_memory)',
      [],
    );
    if (info.some((column) => column.name === 'user_id' && column.pk > 0))
      return;
    await this.sql.exec(`
      CREATE TABLE agent_memory_new (
        user_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL,
        note_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, agent_id, note_key)
      );
      INSERT INTO agent_memory_new (user_id, agent_id, note_key, content, updated_at)
        SELECT '', agent_id, note_key, content, updated_at FROM agent_memory;
      DROP TABLE agent_memory;
      ALTER TABLE agent_memory_new RENAME TO agent_memory;
    `);
  }

  async listProviders(): Promise<ProviderRow[]> {
    const rows = (await this.sql.all(
      'SELECT * FROM providers ORDER BY created_at ASC',
      [],
    )) as unknown as ProviderSql[];
    return rows.map(mapProvider);
  }

  async getProvider(id: string): Promise<ProviderRow | undefined> {
    const row = (await this.sql.get('SELECT * FROM providers WHERE id = ?', [
      id,
    ])) as ProviderSql | undefined;
    return row ? mapProvider(row) : undefined;
  }

  async insertProvider(
    input: ProviderInput & { apiKey?: string },
  ): Promise<ProviderRow> {
    const row: ProviderRow = {
      id: newId(),
      name: input.name.trim(),
      kind: input.kind,
      baseUrl: (input.baseUrl ?? '').trim(),
      apiKey: input.apiKey ?? '',
      models: normalizeModels(input.models, input.kind),
      enabled: input.enabled !== false,
      createdAt: nowIso(),
    };
    await this.sql.run(
      `INSERT INTO providers (id, name, kind, base_url, api_key, models_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.name,
        row.kind,
        row.baseUrl,
        row.apiKey,
        JSON.stringify(row.models),
        row.enabled ? 1 : 0,
        row.createdAt,
      ],
    );
    return row;
  }

  async updateProvider(
    id: string,
    patch: Partial<ProviderInput> & { apiKey?: string },
  ): Promise<ProviderRow | undefined> {
    const current = await this.getProvider(id);
    if (!current) return undefined;
    const next: ProviderRow = {
      ...current,
      name: patch.name !== undefined ? patch.name.trim() : current.name,
      kind: patch.kind ?? current.kind,
      baseUrl:
        patch.baseUrl !== undefined ? patch.baseUrl.trim() : current.baseUrl,
      apiKey:
        patch.apiKey !== undefined && patch.apiKey !== ''
          ? patch.apiKey
          : current.apiKey,
      models:
        patch.models !== undefined
          ? normalizeModels(patch.models, patch.kind ?? current.kind)
          : current.models,
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    };
    await this.sql.run(
      `UPDATE providers SET name = ?, kind = ?, base_url = ?, api_key = ?, models_json = ?, enabled = ? WHERE id = ?`,
      [
        next.name,
        next.kind,
        next.baseUrl,
        next.apiKey,
        JSON.stringify(next.models),
        next.enabled ? 1 : 0,
        id,
      ],
    );
    return next;
  }

  async deleteProvider(id: string): Promise<boolean> {
    const result = await this.sql.run('DELETE FROM providers WHERE id = ?', [
      id,
    ]);
    return result.changes > 0;
  }

  async listMcp(): Promise<McpRow[]> {
    const rows = (await this.sql.all(
      'SELECT * FROM mcp_servers ORDER BY created_at ASC',
      [],
    )) as unknown as McpSql[];
    return rows.map(mapMcp);
  }

  async getMcp(id: string): Promise<McpRow | undefined> {
    const row = (await this.sql.get('SELECT * FROM mcp_servers WHERE id = ?', [
      id,
    ])) as McpSql | undefined;
    return row ? mapMcp(row) : undefined;
  }

  async getMcpByName(name: string): Promise<McpRow | undefined> {
    const row = (await this.sql.get(
      'SELECT * FROM mcp_servers WHERE name = ?',
      [name],
    )) as McpSql | undefined;
    return row ? mapMcp(row) : undefined;
  }

  async upsertMcp(
    input: McpServerInput,
    options: { keepEnv?: boolean; keepHeaders?: boolean } = {},
  ): Promise<McpRow> {
    const existing = await this.getMcpByName(input.name);
    const env =
      options.keepEnv && existing
        ? existing.env
        : (input.env ?? existing?.env ?? {});
    const headers =
      options.keepHeaders && existing
        ? existing.headers
        : (input.headers ?? existing?.headers ?? {});
    const row: McpRow = {
      id: existing?.id ?? newId(),
      name: input.name.trim(),
      transport: input.transport,
      command: (input.command ?? '').trim(),
      args: input.args ?? [],
      env,
      url: (input.url ?? '').trim(),
      headers,
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? nowIso(),
    };
    await this.sql.run(
      `INSERT INTO mcp_servers (id, name, transport, command, args_json, env_json, url, headers_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           transport = excluded.transport,
           command = excluded.command,
           args_json = excluded.args_json,
           env_json = excluded.env_json,
           url = excluded.url,
           headers_json = excluded.headers_json,
           enabled = excluded.enabled`,
      [
        row.id,
        row.name,
        row.transport,
        row.command,
        JSON.stringify(row.args),
        JSON.stringify(row.env),
        row.url,
        JSON.stringify(row.headers),
        row.enabled ? 1 : 0,
        row.createdAt,
      ],
    );
    return (await this.getMcpByName(row.name)) ?? row;
  }

  async deleteMcp(id: string): Promise<boolean> {
    const result = await this.sql.run('DELETE FROM mcp_servers WHERE id = ?', [
      id,
    ]);
    return result.changes > 0;
  }

  async listConversations(
    userId: string,
    agentId?: string,
  ): Promise<Conversation[]> {
    const rows = (agentId
      ? await this.sql.all(
          'SELECT * FROM conversations WHERE user_id = ? AND agent_id = ? ORDER BY updated_at DESC',
          [userId, agentId],
        )
      : await this.sql.all(
          'SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
          [userId],
        )) as unknown as ConversationSql[];
    return rows.map(mapConversation);
  }

  async getConversation(
    id: string,
    userId?: string,
  ): Promise<Conversation | undefined> {
    const row = (await this.sql.get(
      'SELECT * FROM conversations WHERE id = ?',
      [id],
    )) as ConversationSql | undefined;
    if (!row) return undefined;
    if (userId && row.user_id !== userId) return undefined;
    return mapConversation(row);
  }

  async insertConversation(input: {
    title: string;
    agentId: string | null;
    userId: string;
    providerId: string | null;
    model: string | null;
  }): Promise<Conversation> {
    const row: Conversation = {
      id: newId(),
      title: input.title,
      agentId: input.agentId,
      userId: input.userId,
      providerId: input.providerId,
      model: input.model,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.sql.run(
      `INSERT INTO conversations (id, title, agent_id, user_id, provider_id, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.title,
        row.agentId,
        row.userId,
        row.providerId,
        row.model,
        row.createdAt,
        row.updatedAt,
      ],
    );
    return row;
  }

  async findConversationByTitle(
    userId: string,
    agentId: string,
    title: string,
  ): Promise<Conversation | undefined> {
    const row = (await this.sql.get(
      'SELECT * FROM conversations WHERE user_id = ? AND agent_id = ? AND title = ? ORDER BY created_at ASC LIMIT 1',
      [userId, agentId, title],
    )) as ConversationSql | undefined;
    return row ? mapConversation(row) : undefined;
  }

  async assignOrphanConversations(agentId: string): Promise<void> {
    await this.sql.run(
      `UPDATE conversations SET agent_id = ? WHERE agent_id IS NULL OR agent_id = ''`,
      [agentId],
    );
  }

  async updateConversation(
    id: string,
    patch: Partial<Pick<Conversation, 'title' | 'providerId' | 'model'>>,
  ): Promise<Conversation | undefined> {
    const current = await this.getConversation(id);
    if (!current) return undefined;
    const next: Conversation = {
      ...current,
      title: patch.title ?? current.title,
      providerId:
        patch.providerId === undefined ? current.providerId : patch.providerId,
      model: patch.model === undefined ? current.model : patch.model,
      updatedAt: nowIso(),
    };
    await this.sql.run(
      'UPDATE conversations SET title = ?, provider_id = ?, model = ?, updated_at = ? WHERE id = ?',
      [next.title, next.providerId, next.model, next.updatedAt, id],
    );
    return next;
  }

  async deleteConversation(id: string): Promise<boolean> {
    const result = await this.sql.run(
      'DELETE FROM conversations WHERE id = ?',
      [id],
    );
    return result.changes > 0;
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const rows = (await this.sql.all(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
      [conversationId],
    )) as unknown as MessageSql[];
    return rows.map(mapMessage);
  }

  async insertMessage(
    input: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string },
  ): Promise<ChatMessage> {
    const row: ChatMessage = {
      id: input.id ?? newId(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      reasoning: input.reasoning?.trim() ? input.reasoning : undefined,
      createdAt: nowIso(),
    };
    await this.sql.run(
      `INSERT INTO messages (id, conversation_id, role, content, tool_calls_json, tool_call_id, tool_name, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.conversationId,
        row.role,
        row.content,
        row.toolCalls ? JSON.stringify(row.toolCalls) : null,
        row.toolCallId ?? null,
        row.toolName ?? null,
        row.reasoning ?? null,
        row.createdAt,
      ],
    );
    await this.sql.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [
      row.createdAt,
      row.conversationId,
    ]);
    return row;
  }

  async getSetting(key: string): Promise<string | undefined> {
    const row = (await this.sql.get(
      'SELECT value FROM settings WHERE key = ?',
      [key],
    )) as { value: string } | undefined;
    return row?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.sql.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async listAgents(): Promise<Agent[]> {
    const rows = (await this.sql.all(
      'SELECT * FROM agents ORDER BY created_at ASC',
      [],
    )) as unknown as AgentSql[];
    const links = await this.sql.all<{ agent_id: string; full_name: string }>(
      'SELECT agent_id, full_name FROM agent_repos ORDER BY full_name',
      [],
    );
    const byAgent = new Map<string, string[]>();
    for (const link of links) {
      const list = byAgent.get(link.agent_id) ?? [];
      list.push(link.full_name);
      byAgent.set(link.agent_id, list);
    }
    return rows.map((row) => ({
      ...mapAgent(row),
      githubRepos: byAgent.get(row.id) ?? [],
    }));
  }

  async getAgent(id: string): Promise<Agent | undefined> {
    const row = (await this.sql.get('SELECT * FROM agents WHERE id = ?', [
      id,
    ])) as AgentSql | undefined;
    if (!row) return undefined;
    return {
      ...mapAgent(row),
      githubRepos: await this.listAgentRepos(id),
    };
  }

  async listAgentRepos(agentId: string): Promise<string[]> {
    const rows = await this.sql.all<{ full_name: string }>(
      'SELECT full_name FROM agent_repos WHERE agent_id = ? ORDER BY full_name',
      [agentId],
    );
    return rows.map((row) => row.full_name);
  }

  async setAgentRepos(agentId: string, repos: string[]): Promise<void> {
    await this.sql.run('DELETE FROM agent_repos WHERE agent_id = ?', [agentId]);
    const seen = new Set<string>();
    for (const repo of repos) {
      const fullName = repo.trim();
      if (!fullName || seen.has(fullName)) continue;
      seen.add(fullName);
      await this.sql.run(
        'INSERT INTO agent_repos (agent_id, full_name) VALUES (?, ?)',
        [agentId, fullName],
      );
    }
  }

  async findAgentByName(name: string): Promise<Agent | undefined> {
    const needle = name.trim().toLowerCase();
    return (await this.listAgents()).find(
      (agent) => agent.name.toLowerCase() === needle || agent.id === name,
    );
  }

  async insertAgent(input: AgentInput & { name: string }): Promise<Agent> {
    const now = nowIso();
    const row: Agent = {
      id: newId(),
      name: input.name.trim(),
      emoji: (input.emoji ?? '🤖').trim() || '🤖',
      description: (input.description ?? '').trim(),
      systemPrompt: input.systemPrompt ?? '',
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      mcpServerIds: input.mcpServerIds ?? [],
      skillNames: input.skillNames ?? [],
      githubRepos: input.githubRepos ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.sql.run(
      `INSERT INTO agents (
          id, name, emoji, description, system_prompt, provider_id, model,
          mcp_ids_json, skill_names_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.name,
        row.emoji,
        row.description,
        row.systemPrompt,
        row.providerId,
        row.model,
        JSON.stringify(row.mcpServerIds),
        JSON.stringify(row.skillNames),
        row.createdAt,
        row.updatedAt,
      ],
    );
    if (row.githubRepos.length > 0) {
      await this.setAgentRepos(row.id, row.githubRepos);
    }
    return row;
  }

  async updateAgent(id: string, patch: AgentInput): Promise<Agent | undefined> {
    const current = await this.getAgent(id);
    if (!current) return undefined;
    const next: Agent = {
      ...current,
      name: patch.name !== undefined ? patch.name.trim() : current.name,
      emoji:
        patch.emoji !== undefined
          ? patch.emoji.trim() || current.emoji
          : current.emoji,
      description:
        patch.description !== undefined
          ? patch.description.trim()
          : current.description,
      systemPrompt: patch.systemPrompt ?? current.systemPrompt,
      providerId:
        patch.providerId === undefined ? current.providerId : patch.providerId,
      model: patch.model === undefined ? current.model : patch.model,
      mcpServerIds: patch.mcpServerIds ?? current.mcpServerIds,
      skillNames: patch.skillNames ?? current.skillNames,
      githubRepos: patch.githubRepos ?? current.githubRepos,
      updatedAt: nowIso(),
    };
    if (patch.githubRepos !== undefined) {
      await this.setAgentRepos(id, patch.githubRepos);
    }
    await this.sql.run(
      `UPDATE agents SET
          name = ?, emoji = ?, description = ?, system_prompt = ?, provider_id = ?,
          model = ?, mcp_ids_json = ?, skill_names_json = ?, updated_at = ?
         WHERE id = ?`,
      [
        next.name,
        next.emoji,
        next.description,
        next.systemPrompt,
        next.providerId,
        next.model,
        JSON.stringify(next.mcpServerIds),
        JSON.stringify(next.skillNames),
        next.updatedAt,
        id,
      ],
    );
    return next;
  }

  async deleteAgent(id: string): Promise<boolean> {
    const conversations = await this.sql.all<{ id: string }>(
      'SELECT id FROM conversations WHERE agent_id = ?',
      [id],
    );
    for (const conversation of conversations) {
      await this.deleteConversation(conversation.id);
    }
    await this.sql.run('DELETE FROM agent_memory WHERE agent_id = ?', [id]);
    await this.sql.run('DELETE FROM routines WHERE agent_id = ?', [id]);
    await this.sql.run('DELETE FROM user_agents WHERE agent_id = ?', [id]);
    await this.sql.run('DELETE FROM agent_repos WHERE agent_id = ?', [id]);
    const result = await this.sql.run('DELETE FROM agents WHERE id = ?', [id]);
    return result.changes > 0;
  }

  async listMemory(userId: string, agentId: string): Promise<MemoryNote[]> {
    const rows = (await this.sql.all(
      'SELECT * FROM agent_memory WHERE user_id = ? AND agent_id = ? ORDER BY note_key ASC',
      [userId, agentId],
    )) as unknown as MemorySql[];
    return rows.map((row) => ({
      agentId: row.agent_id,
      key: row.note_key,
      content: row.content,
      updatedAt: row.updated_at,
    }));
  }

  async getMemory(
    userId: string,
    agentId: string,
    key: string,
  ): Promise<MemoryNote | undefined> {
    const row = (await this.sql.get(
      'SELECT * FROM agent_memory WHERE user_id = ? AND agent_id = ? AND note_key = ?',
      [userId, agentId, key],
    )) as MemorySql | undefined;
    return row
      ? {
          agentId: row.agent_id,
          key: row.note_key,
          content: row.content,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async writeMemory(
    userId: string,
    agentId: string,
    key: string,
    content: string,
  ): Promise<MemoryNote> {
    const note: MemoryNote = {
      agentId,
      key,
      content,
      updatedAt: nowIso(),
    };
    await this.sql.run(
      `INSERT INTO agent_memory (user_id, agent_id, note_key, content, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, agent_id, note_key) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at`,
      [userId, agentId, key, content, note.updatedAt],
    );
    return note;
  }

  async deleteMemory(
    userId: string,
    agentId: string,
    key: string,
  ): Promise<boolean> {
    const result = await this.sql.run(
      'DELETE FROM agent_memory WHERE user_id = ? AND agent_id = ? AND note_key = ?',
      [userId, agentId, key],
    );
    return result.changes > 0;
  }

  async listRoutines(userId: string, agentId?: string): Promise<Routine[]> {
    const rows = (agentId
      ? await this.sql.all(
          'SELECT * FROM routines WHERE user_id = ? AND agent_id = ? ORDER BY created_at ASC',
          [userId, agentId],
        )
      : await this.sql.all(
          'SELECT * FROM routines WHERE user_id = ? ORDER BY created_at ASC',
          [userId],
        )) as unknown as RoutineSql[];
    return rows.map(mapRoutine);
  }

  async listAllRoutines(): Promise<Routine[]> {
    const rows = await this.sql.all<RoutineSql>(
      'SELECT * FROM routines ORDER BY created_at ASC',
      [],
    );
    return rows.map(mapRoutine);
  }

  async getRoutine(id: string): Promise<Routine | undefined> {
    const row = (await this.sql.get('SELECT * FROM routines WHERE id = ?', [
      id,
    ])) as RoutineSql | undefined;
    if (!row) return undefined;
    if (!row.webhook_token) {
      row.webhook_token = newId().replace(/-/g, '');
      await this.sql.run('UPDATE routines SET webhook_token = ? WHERE id = ?', [
        row.webhook_token,
        id,
      ]);
    }
    return mapRoutine(row);
  }

  async getRoutineByWebhook(token: string): Promise<Routine | undefined> {
    const row = (await this.sql.get(
      'SELECT * FROM routines WHERE webhook_token = ?',
      [token],
    )) as RoutineSql | undefined;
    return row ? mapRoutine(row) : undefined;
  }

  async startRoutineRun(routineId: string): Promise<string> {
    const id = newId();
    await this.sql.run(
      `INSERT INTO routine_runs (id, routine_id, status, output, error, started_at, finished_at)
       VALUES (?, ?, 'running', '', NULL, ?, NULL)`,
      [id, routineId, nowIso()],
    );
    return id;
  }

  async finishRoutineRun(
    id: string,
    status: 'ok' | 'error',
    output: string,
    error: string | null,
  ): Promise<void> {
    await this.sql.run(
      `UPDATE routine_runs SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?`,
      [status, output.slice(0, 20_000), error, nowIso(), id],
    );
  }

  async listRoutineRuns(routineId: string): Promise<
    {
      id: string;
      routineId: string;
      status: 'running' | 'ok' | 'error';
      output: string;
      error: string | null;
      startedAt: string;
      finishedAt: string | null;
    }[]
  > {
    const rows = await this.sql.all<{
      id: string;
      routine_id: string;
      status: string;
      output: string;
      error: string | null;
      started_at: string;
      finished_at: string | null;
    }>(
      'SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT 20',
      [routineId],
    );
    return rows.map((row) => ({
      id: row.id,
      routineId: row.routine_id,
      status:
        row.status === 'ok' || row.status === 'error' ? row.status : 'running',
      output: row.output,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
  }

  async insertRoutine(
    userId: string,
    agentId: string,
    input: RoutineInput & { name: string; cron: string; prompt: string },
  ): Promise<Routine> {
    const row: Routine = {
      id: newId(),
      agentId,
      userId,
      name: input.name.trim(),
      cron: input.cron.trim(),
      prompt: input.prompt,
      enabled: input.enabled !== false,
      lastRunAt: null,
      createdAt: nowIso(),
      webhookToken: newId().replace(/-/g, ''),
    };
    await this.sql.run(
      `INSERT INTO routines (id, agent_id, user_id, name, cron, prompt, enabled, last_run_at, created_at, webhook_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.agentId,
        userId,
        row.name,
        row.cron,
        row.prompt,
        row.enabled ? 1 : 0,
        null,
        row.createdAt,
        row.webhookToken,
      ],
    );
    return row;
  }

  async updateRoutine(
    id: string,
    patch: RoutineInput,
  ): Promise<Routine | undefined> {
    const current = await this.getRoutine(id);
    if (!current) return undefined;
    const next: Routine = {
      ...current,
      name: patch.name !== undefined ? patch.name.trim() : current.name,
      cron: patch.cron !== undefined ? patch.cron.trim() : current.cron,
      prompt: patch.prompt ?? current.prompt,
      enabled: patch.enabled ?? current.enabled,
    };
    await this.sql.run(
      'UPDATE routines SET name = ?, cron = ?, prompt = ?, enabled = ? WHERE id = ?',
      [next.name, next.cron, next.prompt, next.enabled ? 1 : 0, id],
    );
    return next;
  }

  async markRoutineRan(id: string, at: string): Promise<void> {
    await this.sql.run('UPDATE routines SET last_run_at = ? WHERE id = ?', [
      at,
      id,
    ]);
  }

  async deleteRoutine(id: string): Promise<boolean> {
    const result = await this.sql.run('DELETE FROM routines WHERE id = ?', [
      id,
    ]);
    return result.changes > 0;
  }

  async countUsers(): Promise<number> {
    const row = await this.sql.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM users',
      [],
    );
    return Number(row?.n ?? 0);
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    const row = await this.sql.get<UserSql>(
      'SELECT * FROM users WHERE email = ?',
      [email.toLowerCase()],
    );
    return row ? mapUser(row) : undefined;
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const row = await this.sql.get<UserSql>(
      'SELECT * FROM users WHERE id = ?',
      [id],
    );
    return row ? mapUser(row) : undefined;
  }

  async listUsers(): Promise<UserRecord[]> {
    const rows = await this.sql.all<UserSql>(
      'SELECT * FROM users ORDER BY created_at ASC',
      [],
    );
    return rows.map(mapUser);
  }

  async insertUser(input: {
    id?: string;
    email: string;
    name: string;
    passwordHash: string;
    role: 'admin' | 'manager';
    status: 'active' | 'pending' | 'disabled';
    dailyRequestLimit: number | null;
  }): Promise<UserRecord> {
    const row: UserRecord = {
      id: input.id ?? newId(),
      email: input.email.toLowerCase(),
      name: input.name.trim(),
      passwordHash: input.passwordHash,
      role: input.role,
      status: input.status,
      dailyRequestLimit: input.dailyRequestLimit,
      modelsRestricted: false,
      createdAt: nowIso(),
    };
    await this.sql.run(
      `INSERT INTO users (id, email, name, password_hash, role, status, daily_request_limit, invite_token_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.email,
        row.name,
        row.passwordHash,
        row.role,
        row.status,
        row.dailyRequestLimit,
        null,
        row.createdAt,
      ],
    );
    return row;
  }

  async updateUser(
    id: string,
    patch: Partial<
      Pick<
        UserRecord,
        | 'name'
        | 'passwordHash'
        | 'role'
        | 'status'
        | 'dailyRequestLimit'
        | 'modelsRestricted'
      >
    >,
  ): Promise<UserRecord | undefined> {
    const current = await this.getUser(id);
    if (!current) return undefined;
    const next = {
      ...current,
      name: patch.name ?? current.name,
      passwordHash: patch.passwordHash ?? current.passwordHash,
      role: patch.role ?? current.role,
      status: patch.status ?? current.status,
      dailyRequestLimit:
        patch.dailyRequestLimit === undefined
          ? current.dailyRequestLimit
          : patch.dailyRequestLimit,
      modelsRestricted:
        patch.modelsRestricted === undefined
          ? current.modelsRestricted
          : patch.modelsRestricted,
    };
    await this.sql.run(
      `UPDATE users SET name = ?, password_hash = ?, role = ?, status = ?, daily_request_limit = ?, models_restricted = ? WHERE id = ?`,
      [
        next.name,
        next.passwordHash,
        next.role,
        next.status,
        next.dailyRequestLimit,
        next.modelsRestricted ? 1 : 0,
        id,
      ],
    );
    return next;
  }

  async listUserAgentIds(userId: string): Promise<string[]> {
    const rows = await this.sql.all<{ agent_id: string }>(
      'SELECT agent_id FROM user_agents WHERE user_id = ? ORDER BY agent_id',
      [userId],
    );
    return rows.map((row) => row.agent_id);
  }

  async setUserAgents(userId: string, agentIds: string[]): Promise<void> {
    await this.sql.run('DELETE FROM user_agents WHERE user_id = ?', [userId]);
    for (const agentId of agentIds) {
      await this.sql.run(
        'INSERT INTO user_agents (user_id, agent_id) VALUES (?, ?)',
        [userId, agentId],
      );
    }
  }

  async countUsageSince(userId: string, sinceIso: string): Promise<number> {
    const row = await this.sql.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ? AND created_at >= ?',
      [userId, sinceIso],
    );
    return Number(row?.n ?? 0);
  }

  async insertUsage(input: {
    userId: string;
    providerId: string | null;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<void> {
    await this.sql.run(
      `INSERT INTO usage_events (id, user_id, provider_id, model, created_at, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        input.userId,
        input.providerId,
        input.model,
        nowIso(),
        input.inputTokens ?? null,
        input.outputTokens ?? null,
      ],
    );
  }

  async tokenSumSince(userId: string, sinceIso: string): Promise<number> {
    const row = await this.sql.get<{ n: number }>(
      `SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS n
       FROM usage_events WHERE user_id = ? AND created_at >= ?`,
      [userId, sinceIso],
    );
    return Number(row?.n ?? 0);
  }

  async usageSummary(
    sinceIso: string,
  ): Promise<{ userId: string; calls: number }[]> {
    const rows = await this.sql.all<{ user_id: string; n: number }>(
      'SELECT user_id, COUNT(*) AS n FROM usage_events WHERE created_at >= ? GROUP BY user_id',
      [sinceIso],
    );
    return rows.map((row) => ({ userId: row.user_id, calls: Number(row.n) }));
  }

  async usageByModel(
    sinceIso: string,
  ): Promise<{ userId: string; model: string; calls: number }[]> {
    const rows = await this.sql.all<{
      user_id: string;
      model: string;
      n: number;
    }>(
      `SELECT user_id, model, COUNT(*) AS n FROM usage_events
       WHERE created_at >= ? GROUP BY user_id, model ORDER BY model`,
      [sinceIso],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      model: row.model,
      calls: Number(row.n),
    }));
  }

  async listModelAccess(
    userId = '',
  ): Promise<{ providerId: string; model: string }[]> {
    const rows = await this.sql.all<{ provider_id: string; model: string }>(
      'SELECT provider_id, model FROM model_access WHERE user_id = ? ORDER BY model',
      [userId],
    );
    return rows.map((row) => ({
      providerId: row.provider_id,
      model: row.model,
    }));
  }

  async setModelAccess(
    userId: string,
    models: { providerId: string; model: string }[],
  ): Promise<void> {
    await this.sql.run('DELETE FROM model_access WHERE user_id = ?', [userId]);
    const seen = new Set<string>();
    for (const item of models) {
      const providerId = item.providerId.trim();
      const model = item.model.trim();
      if (!providerId || !model) continue;
      const key = `${providerId}\n${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.sql.run(
        'INSERT INTO model_access (provider_id, model, user_id) VALUES (?, ?, ?)',
        [providerId, model, userId],
      );
    }
  }

  async allowedModels(
    user: UserRecord,
  ): Promise<{ providerId: string; model: string }[]> {
    const shared = await this.listModelAccess('');
    if (!user.modelsRestricted) return shared;
    const personal = await this.listModelAccess(user.id);
    return personal.filter((item) =>
      shared.some(
        (grant) =>
          grant.providerId === item.providerId && grant.model === item.model,
      ),
    );
  }

  async isModelAllowed(
    user: UserRecord,
    providerId: string,
    model: string,
  ): Promise<boolean> {
    if (user.role !== 'manager') return true;
    const allowed = await this.allowedModels(user);
    return allowed.some(
      (item) => item.providerId === providerId && item.model === model,
    );
  }

  async claimOrphans(userId: string): Promise<void> {
    await this.sql.run(
      `UPDATE conversations SET user_id = ? WHERE user_id IS NULL OR user_id = ''`,
      [userId],
    );
    await this.sql.run(
      `UPDATE routines SET user_id = ? WHERE user_id IS NULL OR user_id = ''`,
      [userId],
    );
    await this.sql.run(
      `UPDATE agent_memory SET user_id = ? WHERE user_id = ''`,
      [userId],
    );
  }

  async setInviteToken(
    userId: string,
    tokenHash: string | null,
  ): Promise<void> {
    await this.sql.run('UPDATE users SET invite_token_hash = ? WHERE id = ?', [
      tokenHash,
      userId,
    ]);
  }

  async getUserByInviteToken(
    tokenHash: string,
  ): Promise<UserRecord | undefined> {
    const row = await this.sql.get<UserSql>(
      'SELECT * FROM users WHERE invite_token_hash = ?',
      [tokenHash],
    );
    return row ? mapUser(row) : undefined;
  }

  async remember(input: {
    userId: string;
    agentId: string;
    kind: string;
    key: string;
    content: string;
  }): Promise<void> {
    const kind =
      input.kind === 'profile' || input.kind === 'shared'
        ? input.kind
        : 'journal';
    const agentId = kind === 'shared' ? '' : input.agentId;
    if (kind === 'journal') {
      await this.sql.run(
        `INSERT INTO memory_entries (id, user_id, agent_id, kind, note_key, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          input.userId,
          agentId,
          kind,
          input.key,
          input.content,
          nowIso(),
        ],
      );
      return;
    }
    await this.sql.run(
      `DELETE FROM memory_entries WHERE user_id = ? AND agent_id = ? AND kind = ? AND note_key = ?`,
      [input.userId, agentId, kind, input.key],
    );
    await this.sql.run(
      `INSERT INTO memory_entries (id, user_id, agent_id, kind, note_key, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        input.userId,
        agentId,
        kind,
        input.key,
        input.content,
        nowIso(),
      ],
    );
  }

  async recall(
    userId: string,
    agentId: string,
    query: string,
  ): Promise<
    { kind: string; key: string; content: string; createdAt: string }[]
  > {
    const needle = `%${query.trim().replace(/[%_]/g, '')}%`;
    const rows = await this.sql.all<{
      kind: string;
      note_key: string;
      content: string;
      created_at: string;
    }>(
      `SELECT kind, note_key, content, created_at FROM memory_entries
       WHERE user_id = ? AND (agent_id = ? OR agent_id = '' OR kind = 'shared')
         AND (content LIKE ? OR note_key LIKE ?)
       ORDER BY created_at DESC LIMIT 20`,
      [userId, agentId, needle, needle],
    );
    return rows.map((row) => ({
      kind: row.kind,
      key: row.note_key,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  async createTask(input: {
    userId: string;
    agentId: string;
    conversationId: string | null;
    title: string;
    prompt: string;
  }): Promise<string> {
    const id = newId();
    await this.sql.run(
      `INSERT INTO tasks (id, user_id, agent_id, conversation_id, title, prompt, status, result, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', '', ?, NULL)`,
      [
        id,
        input.userId,
        input.agentId,
        input.conversationId,
        input.title,
        input.prompt,
        nowIso(),
      ],
    );
    return id;
  }

  async finishTask(
    id: string,
    status: 'done' | 'error',
    result: string,
  ): Promise<void> {
    await this.sql.run(
      `UPDATE tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?`,
      [status, result.slice(0, 20_000), nowIso(), id],
    );
  }

  async listTasks(
    userId: string,
    conversationId?: string,
  ): Promise<
    {
      id: string;
      title: string;
      status: string;
      result: string;
      createdAt: string;
    }[]
  > {
    const rows = conversationId
      ? await this.sql.all<{
          id: string;
          title: string;
          status: string;
          result: string;
          created_at: string;
        }>(
          'SELECT id, title, status, result, created_at FROM tasks WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT 20',
          [userId, conversationId],
        )
      : await this.sql.all<{
          id: string;
          title: string;
          status: string;
          result: string;
          created_at: string;
        }>(
          'SELECT id, title, status, result, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
          [userId],
        );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      result: row.result,
      createdAt: row.created_at,
    }));
  }

  async addTodo(
    userId: string,
    agentId: string,
    text: string,
  ): Promise<string> {
    const id = newId();
    await this.sql.run(
      `INSERT INTO todos (id, user_id, agent_id, text, done, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
      [id, userId, agentId, text, nowIso()],
    );
    return id;
  }

  async listTodos(
    userId: string,
    agentId: string,
  ): Promise<{ id: string; text: string; done: boolean }[]> {
    const rows = await this.sql.all<{ id: string; text: string; done: number }>(
      'SELECT id, text, done FROM todos WHERE user_id = ? AND agent_id = ? ORDER BY created_at ASC',
      [userId, agentId],
    );
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      done: row.done === 1,
    }));
  }

  async setTodoDone(id: string, userId: string, done: boolean): Promise<void> {
    await this.sql.run(
      'UPDATE todos SET done = ? WHERE id = ? AND user_id = ?',
      [done ? 1 : 0, id, userId],
    );
  }

  async createPage(input: {
    userId: string;
    agentId: string | null;
    title: string;
    body: string;
  }): Promise<{ id: string; shareToken: string }> {
    const id = newId();
    const shareToken = newId().replace(/-/g, '');
    await this.sql.run(
      `INSERT INTO pages (id, user_id, agent_id, title, body, share_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.agentId,
        input.title,
        input.body,
        shareToken,
        nowIso(),
      ],
    );
    return { id, shareToken };
  }

  async listPages(
    userId: string,
  ): Promise<
    { id: string; title: string; shareToken: string; createdAt: string }[]
  > {
    const rows = await this.sql.all<{
      id: string;
      title: string;
      share_token: string;
      created_at: string;
    }>(
      'SELECT id, title, share_token, created_at FROM pages WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      shareToken: row.share_token,
      createdAt: row.created_at,
    }));
  }

  async getPageByToken(
    token: string,
  ): Promise<{ title: string; body: string } | undefined> {
    const row = await this.sql.get<{ title: string; body: string }>(
      'SELECT title, body FROM pages WHERE share_token = ?',
      [token],
    );
    return row;
  }

  async insertUpload(input: {
    userId: string;
    conversationId: string | null;
    name: string;
    mime: string;
    path: string;
    text: string;
  }): Promise<string> {
    const id = newId();
    await this.sql.run(
      `INSERT INTO uploads (id, user_id, conversation_id, name, mime, path, text_content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.conversationId,
        input.name,
        input.mime,
        input.path,
        input.text,
        nowIso(),
      ],
    );
    return id;
  }

  async getUpload(
    id: string,
    userId?: string,
  ): Promise<
    | {
        id: string;
        userId: string;
        name: string;
        mime: string;
        path: string;
        text: string;
      }
    | undefined
  > {
    const row = await this.sql.get<{
      id: string;
      user_id: string;
      name: string;
      mime: string;
      path: string;
      text_content: string;
    }>('SELECT * FROM uploads WHERE id = ?', [id]);
    if (!row) return undefined;
    if (userId && row.user_id !== userId) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      mime: row.mime,
      path: row.path,
      text: row.text_content,
    };
  }

  async createApproval(input: {
    userId: string;
    conversationId: string;
    toolName: string;
    arguments: string;
  }): Promise<string> {
    const id = newId();
    await this.sql.run(
      `INSERT INTO approvals (id, user_id, conversation_id, tool_name, arguments, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [
        id,
        input.userId,
        input.conversationId,
        input.toolName,
        input.arguments,
        nowIso(),
      ],
    );
    return id;
  }

  async getApproval(id: string): Promise<
    | {
        id: string;
        userId: string;
        conversationId: string;
        toolName: string;
        arguments: string;
        status: string;
      }
    | undefined
  > {
    const row = await this.sql.get<{
      id: string;
      user_id: string;
      conversation_id: string;
      tool_name: string;
      arguments: string;
      status: string;
    }>('SELECT * FROM approvals WHERE id = ?', [id]);
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      conversationId: row.conversation_id,
      toolName: row.tool_name,
      arguments: row.arguments,
      status: row.status,
    };
  }

  async setApprovalStatus(id: string, status: string): Promise<void> {
    await this.sql.run('UPDATE approvals SET status = ? WHERE id = ?', [
      status,
      id,
    ]);
  }

  async setReaction(
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<void> {
    await this.sql.run(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
       ON CONFLICT(message_id, user_id, emoji) DO NOTHING`,
      [messageId, userId, emoji],
    );
  }

  async linkTelegram(
    chatId: string,
    userId: string,
    agentId: string | null,
  ): Promise<void> {
    await this.sql.run(
      `INSERT INTO telegram_links (telegram_chat_id, user_id, agent_id) VALUES (?, ?, ?)
       ON CONFLICT(telegram_chat_id) DO UPDATE SET user_id = excluded.user_id, agent_id = excluded.agent_id`,
      [chatId, userId, agentId],
    );
  }

  async telegramLink(
    chatId: string,
  ): Promise<{ userId: string; agentId: string | null } | undefined> {
    const row = await this.sql.get<{
      user_id: string;
      agent_id: string | null;
    }>(
      'SELECT user_id, agent_id FROM telegram_links WHERE telegram_chat_id = ?',
      [chatId],
    );
    if (!row) return undefined;
    return { userId: row.user_id, agentId: row.agent_id };
  }

  async telegramChats(userId: string): Promise<string[]> {
    const rows = await this.sql.all<{ telegram_chat_id: string }>(
      'SELECT telegram_chat_id FROM telegram_links WHERE user_id = ?',
      [userId],
    );
    return rows.map((row) => row.telegram_chat_id);
  }
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'admin' | 'manager';
  status: 'active' | 'pending' | 'disabled';
  dailyRequestLimit: number | null;
  modelsRestricted: boolean;
  createdAt: string;
}

interface UserSql {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: string;
  status: string;
  daily_request_limit: number | null;
  models_restricted: number | null;
  created_at: string;
}

function mapUser(row: UserSql): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    role: row.role === 'admin' ? 'admin' : 'manager',
    status:
      row.status === 'pending' || row.status === 'disabled'
        ? row.status
        : 'active',
    dailyRequestLimit:
      row.daily_request_limit === null ? null : Number(row.daily_request_limit),
    modelsRestricted: Number(row.models_restricted) === 1,
    createdAt: row.created_at,
  };
}

function mapProvider(row: ProviderSql): ProviderRow {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ProviderKind,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    models: parseStringArray(row.models_json),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function mapMcp(row: McpSql): McpRow {
  const transport = row.transport === 'http' ? 'http' : 'stdio';
  return {
    id: row.id,
    name: row.name,
    transport,
    command: row.command,
    args: parseStringArray(row.args_json),
    env: parseRecord(row.env_json),
    url: row.url,
    headers: parseRecord(row.headers_json),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function mapConversation(row: ConversationSql): Conversation {
  return {
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    userId: row.user_id,
    providerId: row.provider_id,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAgent(row: AgentSql): Agent {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    description: row.description,
    systemPrompt: row.system_prompt,
    providerId: row.provider_id,
    model: row.model,
    mcpServerIds: parseStringArray(row.mcp_ids_json),
    skillNames: parseStringArray(row.skill_names_json),
    githubRepos: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoutine(row: RoutineSql): Routine {
  return {
    id: row.id,
    agentId: row.agent_id,
    userId: row.user_id ?? '',
    name: row.name,
    cron: row.cron,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    webhookToken: row.webhook_token ?? null,
  };
}

function mapMessage(row: MessageSql): ChatMessage {
  const role =
    row.role === 'assistant' || row.role === 'tool' ? row.role : 'user';
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role,
    content: row.content,
    toolCalls: parseToolCalls(row.tool_calls_json),
    toolCallId: row.tool_call_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    reasoning: row.reasoning?.trim() ? row.reasoning : undefined,
    createdAt: row.created_at,
  };
}

function normalizeModels(
  models: string[] | undefined,
  kind: ProviderKind,
): string[] {
  const cleaned = (models ?? []).map((item) => item.trim()).filter(Boolean);
  if (cleaned.length > 0) return cleaned;
  if (kind === 'mock') return ['mock'];
  if (kind === 'deepseek') return ['deepseek-chat', 'deepseek-reasoner'];
  return [];
}
