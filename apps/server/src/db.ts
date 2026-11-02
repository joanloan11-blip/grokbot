import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChatMessage,
  Conversation,
  McpServerInput,
  ProviderInput,
  ProviderKind,
  ProviderPublic,
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
  provider_id: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageSql {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
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

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
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
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
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

  listConversations(): Conversation[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
      .all() as unknown as ConversationSql[];
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
    providerId: string | null;
    model: string | null;
  }): Conversation {
    const row: Conversation = {
      id: newId(),
      title: input.title,
      providerId: input.providerId,
      model: input.model,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, provider_id, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        row.providerId,
        row.model,
        row.createdAt,
        row.updatedAt,
      );
    return row;
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
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, tool_calls_json, tool_call_id, tool_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.conversationId,
        row.role,
        row.content,
        row.toolCalls ? JSON.stringify(row.toolCalls) : null,
        row.toolCallId ?? null,
        row.toolName ?? null,
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
    providerId: row.provider_id,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  return [];
}
