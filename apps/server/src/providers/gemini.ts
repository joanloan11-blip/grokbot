import { fitBody, llmFetch, proxyFor } from './http';
import { isRecord, jsonObject } from '../util';
import { readErrorBody, readSse } from './sse';
import type {
  LLMClient,
  ModelMessage,
  ProviderEvent,
  ToolDefinition,
} from './types';

export function geminiStreamUrl(baseUrl: string, model: string): string {
  const base = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta')
    .replace(/\/$/, '')
    .replace(/\/models$/, '');
  return `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

export function createGeminiClient(options: {
  baseUrl: string;
  apiKey: string;
}): LLMClient {
  return {
    stream: (input) => streamGemini({ ...options, ...input }),
  };
}

export async function* streamGemini(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}): AsyncGenerator<ProviderEvent> {
  const { system, contents } = toGeminiContents(options.messages);
  const body: Record<string, unknown> = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (options.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: sanitizeSchema(tool.inputSchema),
        })),
      },
    ];
  }

  const response = await llmFetch(
    geminiStreamUrl(options.baseUrl, options.model),
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': options.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        proxyFor(geminiStreamUrl(options.baseUrl, options.model))
          ? fitBody(body)
          : body,
      ),
      signal: options.signal,
    },
  );

  if (!response.ok) {
    yield {
      type: 'error',
      message: `Gemini ${response.status}: ${await readErrorBody(response)}`,
    };
    return;
  }

  let toolIndex = 0;
  let usage: Extract<ProviderEvent, { type: 'usage' }> | undefined;
  for await (const message of readSse(response)) {
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
        message: String(json.error.message ?? 'Ошибка Gemini'),
      };
      return;
    }
    if (isRecord(json.usageMetadata)) {
      const meta = json.usageMetadata;
      usage = {
        type: 'usage',
        inputTokens: Number(meta.promptTokenCount ?? 0) || 0,
        outputTokens:
          (Number(meta.candidatesTokenCount ?? 0) || 0) +
          (Number(meta.thoughtsTokenCount ?? 0) || 0),
        cachedTokens: Number(meta.cachedContentTokenCount ?? 0) || 0,
      };
    }
    const candidate = Array.isArray(json.candidates)
      ? json.candidates[0]
      : undefined;
    if (!isRecord(candidate)) continue;
    const content = isRecord(candidate.content) ? candidate.content : undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (typeof part.text === 'string' && part.text)
        yield { type: 'text', delta: part.text };
      if (
        isRecord(part.functionCall) &&
        typeof part.functionCall.name === 'string'
      ) {
        const args = part.functionCall.args;
        yield {
          type: 'tool_call_delta',
          index: toolIndex,
          id: `call_gemini_${toolIndex}_${part.functionCall.name}`,
          name: part.functionCall.name,
          argumentsDelta: JSON.stringify(isRecord(args) ? args : {}),
        };
        toolIndex += 1;
      }
    }
  }
  if (usage) yield usage;
  yield { type: 'done' };
}

function toGeminiContents(messages: ModelMessage[]): {
  system: string;
  contents: Record<string, unknown>[];
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const contents: {
    role: 'user' | 'model';
    parts: Record<string, unknown>[];
  }[] = [];

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      contents.push({
        role: 'user',
        parts: [
          ...(message.images ?? []).map((image) => ({
            inlineData: { mimeType: image.mime, data: image.data },
          })),
          { text: message.content },
        ],
      });
      continue;
    }
    if (message.role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: { name: call.name, args: jsonObject(call.arguments) },
        });
      }
      if (parts.length === 0) parts.push({ text: '' });
      contents.push({ role: 'model', parts });
      continue;
    }
    const part = {
      functionResponse: {
        name: message.name ?? 'tool',
        response: { result: message.content },
      },
    };
    const prev = contents.at(-1);
    if (
      prev &&
      prev.role === 'user' &&
      prev.parts.every((item) => 'functionResponse' in item)
    ) {
      prev.parts.push(part);
    } else {
      contents.push({ role: 'user', parts: [part] });
    }
  }
  return { system, contents };
}

function sanitizeSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema' || key === 'additionalProperties') continue;
    if (Array.isArray(value)) {
      next[key] = value.map((item) =>
        isRecord(item) ? sanitizeSchema(item) : item,
      );
    } else if (isRecord(value)) {
      next[key] = sanitizeSchema(value);
    } else {
      next[key] = value;
    }
  }
  if (!next.type) next.type = 'object';
  return next;
}
