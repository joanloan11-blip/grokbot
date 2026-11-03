import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  agent_id: string;
  note_key: string;
  content: string;
  updated_at: string;
}

interface RoutineSql {
  id: string;
  agent_id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
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
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'mayak.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
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
        agent_id TEXT NOT NULL,
        note_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, note_key)
      );

      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
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
    const columns = this.db
      .prepare('PRAGMA table_info(messages)')
      .all() as unknown as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === 'reasoning')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT');
    }
    const conversationColumns = this.db
      .prepare('PRAGMA table_info(conversations)')
      .all() as unknown as { name: string }[];
    if (!conversationColumns.some((column) => column.name === 'agent_id')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN agent_id TEXT');
    }
  }

  listProviders(): ProviderRow[] {
    const rows = this.db
      .prepare('SELECT * FROM providers ORDER BY created_at ASC')
      .all() as unknown as ProviderSql[];
    return rows.map(mapProvider);
  }

  getProvider(id: string): ProviderRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM providers WHERE id = ?')
      .get(id) as ProviderSql | undefined;
    return row ? mapProvider(row) : undefined;
  }

  insertProvider(input: ProviderInput & { apiKey?: string }): ProviderRow {
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
    this.db
      .prepare(
        `INSERT INTO providers (id, name, kind, base_url, api_key, models_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.kind,
        row.baseUrl,
        row.apiKey,
        JSON.stringify(row.models),
        row.enabled ? 1 : 0,
        row.createdAt,
      );
    return row;
  }

  updateProvider(
    id: string,
    patch: Partial<ProviderInput> & { apiKey?: string },
  ): ProviderRow | undefined {
    const current = this.getProvider(id);
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
    this.db
      .prepare(
        `UPDATE providers SET name = ?, kind = ?, base_url = ?, api_key = ?, models_json = ?, enabled = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.kind,
        next.baseUrl,
        next.apiKey,
        JSON.stringify(next.models),
        next.enabled ? 1 : 0,
        id,
      );
    return next;
  }

  deleteProvider(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM providers WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  listMcp(): McpRow[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC')
      .all() as unknown as McpSql[];
    return rows.map(mapMcp);
  }

  getMcp(id: string): McpRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_servers WHERE id = ?')
      .get(id) as McpSql | undefined;
    return row ? mapMcp(row) : undefined;
  }

  getMcpByName(name: string): McpRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_servers WHERE name = ?')
      .get(name) as McpSql | undefined;
    return row ? mapMcp(row) : undefined;
  }

  upsertMcp(
    input: McpServerInput,
    options: { keepEnv?: boolean; keepHeaders?: boolean } = {},
  ): McpRow {
    const existing = this.getMcpByName(input.name);
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
    this.db
      .prepare(
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
      )
      .run(
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
      );
    return this.getMcpByName(row.name) ?? row;
  }

  deleteMcp(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM mcp_servers WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  listConversations(agentId?: string): Conversation[] {
    const rows = (agentId
      ? this.db
          .prepare(
            'SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC',
          )
          .all(agentId)
      : this.db
          .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
          .all()) as unknown as ConversationSql[];
    return rows.map(mapConversation);
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as ConversationSql | undefined;
    return row ? mapConversation(row) : undefined;
  }

  insertConversation(input: {
    title: string;
    agentId: string | null;
    providerId: string | null;
    model: string | null;
  }): Conversation {
    const row: Conversation = {
      id: newId(),
      title: input.title,
      agentId: input.agentId,
      providerId: input.providerId,
      model: input.model,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, agent_id, provider_id, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        row.agentId,
        row.providerId,
        row.model,
        row.createdAt,
        row.updatedAt,
      );
    return row;
  }

  findConversationByTitle(
    agentId: string,
    title: string,
  ): Conversation | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM conversations WHERE agent_id = ? AND title = ? ORDER BY created_at ASC LIMIT 1',
      )
      .get(agentId, title) as ConversationSql | undefined;
    return row ? mapConversation(row) : undefined;
  }

  assignOrphanConversations(agentId: string): void {
    this.db
      .prepare(
        `UPDATE conversations SET agent_id = ? WHERE agent_id IS NULL OR agent_id = ''`,
      )
      .run(agentId);
  }

  updateConversation(
    id: string,
    patch: Partial<Pick<Conversation, 'title' | 'providerId' | 'model'>>,
  ): Conversation | undefined {
    const current = this.getConversation(id);
    if (!current) return undefined;
    const next: Conversation = {
      ...current,
      title: patch.title ?? current.title,
      providerId:
        patch.providerId === undefined ? current.providerId : patch.providerId,
      model: patch.model === undefined ? current.model : patch.model,
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        'UPDATE conversations SET title = ?, provider_id = ?, model = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.title, next.providerId, next.model, next.updatedAt, id);
    return next;
  }

  deleteConversation(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM conversations WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  listMessages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(conversationId) as unknown as MessageSql[];
    return rows.map(mapMessage);
  }

  insertMessage(
    input: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string },
  ): ChatMessage {
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
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, tool_calls_json, tool_call_id, tool_name, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.conversationId,
        row.role,
        row.content,
        row.toolCalls ? JSON.stringify(row.toolCalls) : null,
        row.toolCallId ?? null,
        row.toolName ?? null,
        row.reasoning ?? null,
        row.createdAt,
      );
    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(row.createdAt, row.conversationId);
    return row;
  }

  getSetting(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  listAgents(): Agent[] {
    const rows = this.db
      .prepare('SELECT * FROM agents ORDER BY created_at ASC')
      .all() as unknown as AgentSql[];
    return rows.map(mapAgent);
  }

  getAgent(id: string): Agent | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      | AgentSql
      | undefined;
    return row ? mapAgent(row) : undefined;
  }

  findAgentByName(name: string): Agent | undefined {
    const needle = name.trim().toLowerCase();
    return this.listAgents().find(
      (agent) => agent.name.toLowerCase() === needle || agent.id === name,
    );
  }

  insertAgent(input: AgentInput & { name: string }): Agent {
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
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO agents (
          id, name, emoji, description, system_prompt, provider_id, model,
          mcp_ids_json, skill_names_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
    return row;
  }

  updateAgent(id: string, patch: AgentInput): Agent | undefined {
    const current = this.getAgent(id);
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
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `UPDATE agents SET
          name = ?, emoji = ?, description = ?, system_prompt = ?, provider_id = ?,
          model = ?, mcp_ids_json = ?, skill_names_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
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
      );
    return next;
  }

  deleteAgent(id: string): boolean {
    this.db.exec('BEGIN');
    try {
      for (const conversation of this.listConversations(id)) {
        this.deleteConversation(conversation.id);
      }
      this.db.prepare('DELETE FROM agent_memory WHERE agent_id = ?').run(id);
      this.db.prepare('DELETE FROM routines WHERE agent_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listMemory(agentId: string): MemoryNote[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY note_key ASC',
      )
      .all(agentId) as unknown as MemorySql[];
    return rows.map((row) => ({
      agentId: row.agent_id,
      key: row.note_key,
      content: row.content,
      updatedAt: row.updated_at,
    }));
  }

  getMemory(agentId: string, key: string): MemoryNote | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_memory WHERE agent_id = ? AND note_key = ?')
      .get(agentId, key) as MemorySql | undefined;
    return row
      ? {
          agentId: row.agent_id,
          key: row.note_key,
          content: row.content,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  writeMemory(agentId: string, key: string, content: string): MemoryNote {
    const note: MemoryNote = {
      agentId,
      key,
      content,
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_memory (agent_id, note_key, content, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, note_key) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at`,
      )
      .run(agentId, key, content, note.updatedAt);
    return note;
  }

  deleteMemory(agentId: string, key: string): boolean {
    const result = this.db
      .prepare('DELETE FROM agent_memory WHERE agent_id = ? AND note_key = ?')
      .run(agentId, key);
    return result.changes > 0;
  }

  listRoutines(agentId?: string): Routine[] {
    const rows = (agentId
      ? this.db
          .prepare(
            'SELECT * FROM routines WHERE agent_id = ? ORDER BY created_at ASC',
          )
          .all(agentId)
      : this.db
          .prepare('SELECT * FROM routines ORDER BY created_at ASC')
          .all()) as unknown as RoutineSql[];
    return rows.map(mapRoutine);
  }

  getRoutine(id: string): Routine | undefined {
    const row = this.db
      .prepare('SELECT * FROM routines WHERE id = ?')
      .get(id) as RoutineSql | undefined;
    return row ? mapRoutine(row) : undefined;
  }

  insertRoutine(
    agentId: string,
    input: RoutineInput & { name: string; cron: string; prompt: string },
  ): Routine {
    const row: Routine = {
      id: newId(),
      agentId,
      name: input.name.trim(),
      cron: input.cron.trim(),
      prompt: input.prompt,
      enabled: input.enabled !== false,
      lastRunAt: null,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO routines (id, agent_id, name, cron, prompt, enabled, last_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.agentId,
        row.name,
        row.cron,
        row.prompt,
        row.enabled ? 1 : 0,
        null,
        row.createdAt,
      );
    return row;
  }

  updateRoutine(id: string, patch: RoutineInput): Routine | undefined {
    const current = this.getRoutine(id);
    if (!current) return undefined;
    const next: Routine = {
      ...current,
      name: patch.name !== undefined ? patch.name.trim() : current.name,
      cron: patch.cron !== undefined ? patch.cron.trim() : current.cron,
      prompt: patch.prompt ?? current.prompt,
      enabled: patch.enabled ?? current.enabled,
    };
    this.db
      .prepare(
        'UPDATE routines SET name = ?, cron = ?, prompt = ?, enabled = ? WHERE id = ?',
      )
      .run(next.name, next.cron, next.prompt, next.enabled ? 1 : 0, id);
    return next;
  }

  markRoutineRan(id: string, at: string): void {
    this.db
      .prepare('UPDATE routines SET last_run_at = ? WHERE id = ?')
      .run(at, id);
  }

  deleteRoutine(id: string): boolean {
    const result = this.db.prepare('DELETE FROM routines WHERE id = ?').run(id);
    return result.changes > 0;
  }
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoutine(row: RoutineSql): Routine {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    cron: row.cron,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
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
