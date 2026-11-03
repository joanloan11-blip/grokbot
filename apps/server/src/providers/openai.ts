import { llmFetch } from './http';
import { isRecord } from '../util';
import { readErrorBody, readSse } from './sse';
import type {
  LLMClient,
  ModelMessage,
  ProviderEvent,
  ToolDefinition,
} from './types';

export function openAiChatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

export function createOpenAIClient(options: {
  baseUrl: string;
  apiKey: string;
}): LLMClient {
  return {
    stream: (input) => streamOpenAI({ ...options, ...input }),
  };
}

export async function* streamOpenAI(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}): AsyncGenerator<ProviderEvent> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages.map(toOpenAIMessage),
    stream: true,
  };
  if (options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  const response = await llmFetch(openAiChatUrl(options.baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    yield {
      type: 'error',
      message: `OpenAI-совместимый API ${response.status}: ${await readErrorBody(response)}`,
    };
    return;
  }

  for await (const message of readSse(response)) {
    if (message.data.trim() === '[DONE]') {
      yield { type: 'done' };
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(message.data);
    } catch {
      continue;
    }
    if (!isRecord(json)) continue;
    if (isRecord(json.error)) {
      yield {
        type: 'error',
        message: String(json.error.message ?? 'Ошибка провайдера'),
      };
      return;
    }
    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    if (delta && typeof delta.content === 'string' && delta.content) {
      yield { type: 'text', delta: delta.content };
    }
    if (
      delta &&
      typeof delta.reasoning_content === 'string' &&
      delta.reasoning_content
    ) {
      yield { type: 'reasoning', delta: delta.reasoning_content };
    }
    if (delta && Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (!isRecord(call) || typeof call.index !== 'number') continue;
        const fn = isRecord(call.function) ? call.function : undefined;
        yield {
          type: 'tool_call_delta',
          index: call.index,
          id: typeof call.id === 'string' ? call.id : undefined,
          name: fn && typeof fn.name === 'string' ? fn.name : undefined,
          argumentsDelta:
            fn && typeof fn.arguments === 'string' ? fn.arguments : undefined,
        };
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      yield { type: 'done', finishReason: choice.finish_reason };
      return;
    }
  }
  yield { type: 'done' };
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      })),
    };
  }
  if (message.role === 'user' && message.images?.length) {
    return {
      role: 'user',
      content: [
        { type: 'text', text: message.content },
        ...message.images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mime};base64,${image.data}` },
        })),
      ],
    };
  }
  return { role: message.role, content: message.content };
}
