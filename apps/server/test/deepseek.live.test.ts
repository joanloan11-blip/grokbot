import { DEEPSEEK_BASE_URL } from '@mayak/shared';
import { describe, expect, it } from 'vitest';
import { runAgentLoop } from '../src/agent/loop';
import { loadConfig, repoRoot } from '../src/config';
import { McpManager } from '../src/mcp/manager';
import { createOpenAIClient } from '../src/providers/openai';
import type { ProviderEvent } from '../src/providers/types';

// setup.ts moves the real key aside so other tests stay on the demo model.
const apiKey = process.env.MAYAK_TEST_STASH_DEEPSEEK_API_KEY?.trim() ?? '';
const live =
  apiKey && apiKey !== 'unit-deepseek-key' ? describe : describe.skip;

function redact(text: string): string {
  return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

async function collect(
  events: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

live('DeepSeek live', () => {
  it('chats, streams reasoner thoughts, and calls the demo echo tool', async () => {
    const client = createOpenAIClient({ baseUrl: DEEPSEEK_BASE_URL, apiKey });
    const chat = await collect(
      client.stream({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: 'Reply with the single word pong and nothing else.',
          },
        ],
        tools: [],
      }),
    );
    const chatError = chat.find((event) => event.type === 'error');
    if (chatError && chatError.type === 'error')
      throw new Error(redact(chatError.message));
    const answer = chat
      .filter((event) => event.type === 'text')
      .map((event) => (event.type === 'text' ? event.delta : ''))
      .join('');
    expect(redact(answer).toLowerCase()).toContain('pong');

    const reasoner = await collect(
      client.stream({
        model: 'deepseek-reasoner',
        messages: [
          { role: 'user', content: 'What is 2+2? Reply with just the number.' },
        ],
        tools: [],
      }),
    );
    const reasonerError = reasoner.find((event) => event.type === 'error');
    if (reasonerError && reasonerError.type === 'error') {
      throw new Error(redact(reasonerError.message));
    }
    const thoughts = reasoner
      .filter((event) => event.type === 'reasoning')
      .map((event) => (event.type === 'reasoning' ? event.delta : ''))
      .join('');
    const reasonerText = reasoner
      .filter((event) => event.type === 'text')
      .map((event) => (event.type === 'text' ? event.delta : ''))
      .join('');
    expect(
      redact(thoughts).length + redact(reasonerText).length,
    ).toBeGreaterThan(0);
    expect(redact(reasonerText)).toContain('4');

    const config = loadConfig({ repoRoot });
    const mcp = new McpManager();
    try {
      const snapshot = await mcp.connect({
        id: 'demo',
        name: 'demo',
        transport: 'stdio',
        command: process.execPath,
        args: [config.demoServerPath],
        env: {},
        url: '',
        headers: {},
        enabled: true,
        createdAt: new Date().toISOString(),
      });
      expect(snapshot.status).toBe('connected');
      const toolName = 'mcp__demo__echo';
      let toolResult = '';
      await runAgentLoop({
        client,
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content:
              'Call the tool mcp__demo__echo exactly once with {"text":"hello-mayak"}. Then reply with the tool result and nothing else.',
          },
        ],
        tools: [
          {
            name: toolName,
            description: 'Echoes the text argument.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
        executeTool: async (call) => {
          const args = JSON.parse(call.arguments || '{}') as Record<
            string,
            unknown
          >;
          toolResult = await mcp.callTool('demo', 'echo', args);
          return toolResult;
        },
        onEvent: () => undefined,
      });
      expect(redact(toolResult)).toContain('hello-mayak');
    } finally {
      await mcp.disconnectAll();
    }
  }, 120_000);
});
