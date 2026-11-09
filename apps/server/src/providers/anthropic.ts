import { fitBody, llmFetch, proxyFor } from './http';
import { isRecord, jsonObject } from '../util';
import { readErrorBody, readSse } from './sse';
import type {
  LLMClient,
  ModelMessage,
  ProviderEvent,
  ToolDefinition,
} from './types';

export function anthropicMessagesUrl(baseUrl: string): string {
  const base = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  if (base.endsWith('/messages')) return base;
  if (base.endsWith('/v1')) return `${base}/messages`;
  return `${base}/v1/messages`;
}

export function createAnthropicClient(options: {
  baseUrl: string;
  apiKey: string;
}): LLMClient {
  return {
    stream: (input) => streamAnthropic({ ...options, ...input }),
  };
}

export async function* streamAnthropic(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}): AsyncGenerator<ProviderEvent> {
  const { system, messages } = toAnthropicMessages(options.messages);
  const body: Record<string, unknown> = {
    model: options.model,
    // Файл целиком через workspace_write не помещается в 4096 токенов.
    max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS) || 16_000,
    messages,
    stream: true,
  };
  // Кэш промпта: системный промпт, схемы инструментов и история между шагами
  // читаются из кэша в 10 раз дешевле — в долгой работе с кодом это основная экономия.
  if (system)
    body.system = [
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
    ];
  if (options.tools.length > 0) {
    body.tools = options.tools.map((tool, index, all) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(index === all.length - 1
        ? { cache_control: { type: 'ephemeral' } }
        : {}),
    }));
  }
  markLastForCache(messages);

  const response = await llmFetch(anthropicMessagesUrl(options.baseUrl), {
    method: 'POST',
    headers: {
      'x-api-key': options.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(
      proxyFor(anthropicMessagesUrl(options.baseUrl)) ? fitBody(body) : body,
    ),
    signal: options.signal,
  });

  if (!response.ok) {
    yield {
      type: 'error',
      message: `Anthropic ${response.status}: ${await readErrorBody(response)}`,
    };
    return;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  for await (const message of readSse(response)) {
    let json: unknown;
    try {
      json = JSON.parse(message.data);
    } catch {
      continue;
    }
    if (!isRecord(json)) continue;
    if (json.type === 'error') {
      const error = isRecord(json.error) ? json.error : json;
      yield {
        type: 'error',
        message: String(error.message ?? 'Ошибка Anthropic'),
      };
      return;
    }
    if (json.type === 'content_block_start' && isRecord(json.content_block)) {
      const block = json.content_block;
      if (block.type === 'tool_use' && typeof json.index === 'number') {
        yield {
          type: 'tool_call_delta',
          index: json.index,
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
          argumentsDelta: '',
        };
      }
    }
    if (
      json.type === 'content_block_delta' &&
      isRecord(json.delta) &&
      typeof json.index === 'number'
    ) {
      const delta = json.delta;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        yield { type: 'text', delta: delta.text };
      }
      if (
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        yield {
          type: 'tool_call_delta',
          index: json.index,
          argumentsDelta: delta.partial_json,
        };
      }
    }
    if (json.type === 'message_start' && isRecord(json.message)) {
      const usage = isRecord(json.message.usage) ? json.message.usage : {};
      cachedTokens = Number(usage.cache_read_input_tokens ?? 0) || 0;
      inputTokens =
        (Number(usage.input_tokens ?? 0) || 0) +
        cachedTokens +
        (Number(usage.cache_creation_input_tokens ?? 0) || 0);
      outputTokens = Number(usage.output_tokens ?? 0) || 0;
    }
    if (json.type === 'message_delta' && isRecord(json.usage)) {
      outputTokens = Number(json.usage.output_tokens ?? outputTokens) || 0;
    }
    if (json.type === 'message_stop') {
      if (inputTokens || outputTokens)
        yield { type: 'usage', inputTokens, outputTokens, cachedTokens };
      yield { type: 'done' };
      return;
    }
  }
  yield { type: 'done' };
}

/** Метка кэша на последнем блоке последнего сообщения: следующий шаг прочитает всю историю из кэша. */
function markLastForCache(messages: Record<string, unknown>[]): void {
  const last = messages.at(-1);
  const content = last?.content;
  if (!Array.isArray(content) || content.length === 0) return;
  const block = content.at(-1) as Record<string, unknown>;
  if (block.type === 'text' && !block.text) return;
  block.cache_control = { type: 'ephemeral' };
}

function toAnthropicMessages(messages: ModelMessage[]): {
  system: string;
  messages: Record<string, unknown>[];
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const out: {
    role: 'user' | 'assistant';
    content: Record<string, unknown>[];
  }[] = [];

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      out.push({
        role: 'user',
        content: [
          ...(message.images ?? []).map((image) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mime,
              data: image.data,
            },
          })),
          // Anthropic не принимает пустые текстовые блоки.
          { type: 'text', text: message.content || '…' },
        ],
      });
      continue;
    }
    if (message.role === 'assistant') {
      const content: Record<string, unknown>[] = [];
      if (message.content)
        content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: jsonObject(call.arguments),
        });
      }
      if (content.length === 0) content.push({ type: 'text', text: '…' });
      out.push({ role: 'assistant', content });
      continue;
    }
    const block = {
      type: 'tool_result',
      tool_use_id: message.toolCallId,
      content: message.content || '(пусто)',
    };
    const prev = out.at(-1);
    if (
      prev &&
      prev.role === 'user' &&
      prev.content.every((item) => item.type === 'tool_result')
    ) {
      prev.content.push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }

  return { system, messages: out };
}
