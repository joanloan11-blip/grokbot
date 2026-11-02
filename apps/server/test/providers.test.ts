import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anthropicMessagesUrl,
  streamAnthropic,
} from '../src/providers/anthropic';
import { geminiStreamUrl, streamGemini } from '../src/providers/gemini';
import { createMockClient } from '../src/providers/mock';
import { openAiChatUrl, streamOpenAI } from '../src/providers/openai';
import type { ProviderEvent } from '../src/providers/types';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sseResponse(blocks: string[], status = 200): Response {
  const payload = blocks
    .map((block) => (block.endsWith('\n\n') ? block : `${block}\n\n`))
    .join('');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect(
  events: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('provider urls', () => {
  it('normalizes OpenAI-compatible, Anthropic and Gemini endpoints', () => {
    expect(openAiChatUrl('http://localhost:11434/v1')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
    expect(openAiChatUrl('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(anthropicMessagesUrl('https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(anthropicMessagesUrl('https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(
      geminiStreamUrl(
        'https://generativelanguage.googleapis.com/v1beta',
        'gemini-2.5-flash',
      ),
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
  });
});

describe('OpenAI-compatible streaming', () => {
  it('parses text and split tool-call arguments', async () => {
    let request:
      | {
          url: string;
          auth: string;
          body: { tools?: unknown; stream: boolean };
        }
      | undefined;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      request = {
        url: String(url),
        auth: new Headers(init?.headers).get('authorization') ?? '',
        body: JSON.parse(String(init?.body)) as {
          tools?: unknown;
          stream: boolean;
        },
      };
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":' } }] } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] }, finish_reason: 'tool_calls' }] })}`,
      ]);
    }) as typeof fetch;

    const events = await collect(
      streamOpenAI({
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'secret-key',
        model: 'demo-model',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'echo',
            description: 'Echo',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    );

    expect(request?.url).toBe('http://127.0.0.1:9/v1/chat/completions');
    expect(request?.auth).toBe('Bearer secret-key');
    expect(request?.body.stream).toBe(true);
    expect(request?.body.tools).toBeTruthy();
    expect(events).toContainEqual({ type: 'text', delta: 'Hi' });
    expect(events).toContainEqual({
      type: 'tool_call_delta',
      index: 0,
      id: 'call_1',
      name: 'echo',
      argumentsDelta: '{"text":',
    });
    expect(events).toContainEqual({
      type: 'tool_call_delta',
      index: 0,
      argumentsDelta: '"hi"}',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      finishReason: 'tool_calls',
    });
  });

  it('omits tools when the model has none and surfaces HTTP errors', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown };
      expect(body.tools).toBeUndefined();
      return new Response('nope', { status: 401 });
    }) as typeof fetch;

    const events = await collect(
      streamOpenAI({
        baseUrl: 'https://example.test/v1',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    );
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') expect(events[0].message).toContain('401');
  });
});

describe('Anthropic streaming', () => {
  it('parses text deltas and tool input JSON', async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } })}`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo', input: {} } })}`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":"hi"}' } })}`,
        `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
      ]),
    ) as typeof fetch;

    const events = await collect(
      streamAnthropic({
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'k',
        model: 'claude',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    );
    expect(events).toContainEqual({ type: 'text', delta: 'Hi' });
    expect(events).toContainEqual({
      type: 'tool_call_delta',
      index: 1,
      id: 'toolu_1',
      name: 'echo',
      argumentsDelta: '',
    });
    expect(events).toContainEqual({
      type: 'tool_call_delta',
      index: 1,
      argumentsDelta: '{"text":"hi"}',
    });
  });
});

describe('Gemini streaming', () => {
  it('parses text and function calls', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain(
        'models/gemini-flash:streamGenerateContent?alt=sse',
      );
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('gem-key');
      return sseResponse([
        `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }, { functionCall: { name: 'echo', args: { text: 'hi' } } }] } }] })}`,
      ]);
    }) as typeof fetch;

    const events = await collect(
      streamGemini({
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'gem-key',
        model: 'gemini-flash',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'echo',
            description: 'Echo',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
    );
    expect(events).toContainEqual({ type: 'text', delta: 'Hi' });
    expect(events).toContainEqual({
      type: 'tool_call_delta',
      index: 0,
      id: 'call_gemini_0_echo',
      name: 'echo',
      argumentsDelta: '{"text":"hi"}',
    });
  });
});

describe('mock provider', () => {
  it('streams an echo of the user text without calling the network', async () => {
    const events = await collect(
      createMockClient().stream({
        model: 'mock',
        messages: [{ role: 'user', content: 'привет' }],
        tools: [],
      }),
    );
    const text = events
      .filter((event) => event.type === 'text')
      .map((event) => (event.type === 'text' ? event.delta : ''))
      .join('');
    expect(text).toContain('привет');
    expect(events.at(-1)?.type).toBe('done');
  });
});
