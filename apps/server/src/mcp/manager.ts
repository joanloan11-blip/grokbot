import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpStatus } from '@mayak/shared';
import type { McpRow } from '../db';
import { isRecord } from '../util';

export interface LiveTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface LiveConnection {
  status: McpStatus;
  error?: string;
  tools: LiveTool[];
  client?: Client;
  close?: () => Promise<void>;
}

export interface McpSnapshot {
  status: McpStatus;
  error?: string;
  tools: LiveTool[];
}

export class McpManager {
  private connections = new Map<string, LiveConnection>();

  snapshot(id: string): McpSnapshot {
    const live = this.connections.get(id);
    if (!live) return { status: 'disconnected', tools: [] };
    return { status: live.status, error: live.error, tools: live.tools };
  }

  private named = new Map<string, string>();

  async connect(row: McpRow): Promise<McpSnapshot> {
    await this.disconnect(row.id);
    const slot: LiveConnection = { status: 'connecting', tools: [] };
    this.connections.set(row.id, slot);
    this.named.set(row.id, row.name);
    let stderr = '';
    try {
      const client = new Client({ name: 'mayak', version: '0.1.0' });
      if (row.transport === 'http') {
        let url: URL;
        try {
          url = new URL(row.url);
        } catch {
          throw new Error('Некорректный URL MCP-сервера');
        }
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: row.headers },
        });
        slot.close = async () => {
          await client.close().catch(() => undefined);
        };
        await client.connect(transport);
      } else {
        if (!row.command) throw new Error('Не задана команда stdio-сервера');
        const transport = new StdioClientTransport({
          command: row.command,
          args: row.args,
          env: row.env,
          stderr: 'pipe',
        });
        if (transport.stderr instanceof Readable) {
          transport.stderr.on('data', (chunk: Buffer | string) => {
            stderr = `${stderr}${chunk.toString()}`.slice(-2000);
          });
        }
        slot.close = async () => {
          await client.close().catch(() => undefined);
        };
        await client.connect(transport);
      }
      const listed = await client.listTools();
      slot.client = client;
      slot.tools = listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      }));
      slot.status = 'connected';
      slot.error = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      slot.status = 'error';
      slot.error = [message, stderr.trim()]
        .filter(Boolean)
        .join('\n')
        .slice(0, 700);
      slot.tools = [];
      await slot.close?.().catch(() => undefined);
      slot.client = undefined;
      slot.close = undefined;
    }
    return this.snapshot(row.id);
  }

  async disconnect(id: string): Promise<void> {
    const live = this.connections.get(id);
    this.connections.delete(id);
    this.named.delete(id);
    await live?.close?.().catch(() => undefined);
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()];
    for (const id of ids) await this.disconnect(id);
  }

  listConnected(): { id: string; name: string; tools: LiveTool[] }[] {
    const out: { id: string; name: string; tools: LiveTool[] }[] = [];
    for (const [id, live] of this.connections) {
      if (live.status !== 'connected') continue;
      out.push({ id, name: this.named.get(id) ?? id, tools: live.tools });
    }
    return out;
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const live = this.connections.get(serverId);
    if (!live?.client || live.status !== 'connected') {
      throw new Error('MCP-сервер не подключён');
    }
    const result = await live.client.callTool({
      name: toolName,
      arguments: args,
    });
    return formatToolResult(result);
  }
}

export function encodeMcpToolName(
  serverName: string,
  toolName: string,
): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  const full = `mcp__${clean(serverName)}__${clean(toolName)}`;
  if (full.length <= 64) return full;
  const hash = createHash('sha256')
    .update(`${serverName}/${toolName}`)
    .digest('hex')
    .slice(0, 8);
  return `mcp__${hash}__${clean(toolName)}`.slice(0, 64);
}

function formatToolResult(result: unknown): string {
  if (!isRecord(result)) return String(result ?? '');
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item)) continue;
      if (item.type === 'text' && typeof item.text === 'string')
        parts.push(item.text);
      else if (item.type === 'image') parts.push('[изображение]');
      else if (item.type === 'audio') parts.push('[аудио]');
      else if (typeof item.type === 'string') parts.push(`[${item.type}]`);
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  const text = parts.join('\n').trim() || '(пустой результат)';
  return result.isError === true ? `Ошибка: ${text}` : text;
}
