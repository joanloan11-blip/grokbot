import { describe, expect, it } from 'vitest';
import { runAgentLoop, type AgentEvent } from '../src/agent/loop';
import type {
  LLMClient,
  ProviderEvent,
  ToolDefinition,
} from '../src/providers/types';

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

function scripted(steps: ProviderEvent[][]): LLMClient {
  let index = 0;
  return {
    async *stream() {
      const step = steps[index] ?? [
        { type: 'text', delta: 'fallback' },
        { type: 'done' },
      ];
      index += 1;
      for (const event of step) yield event;
    },
  };
}

describe('runAgentLoop', () => {
  it('calls a tool and then answers with its result', async () => {
    const executed: string[] = [];
    const events: AgentEvent[] = [];
    const messages = await runAgentLoop({
      client: scripted([
        [
          { type: 'text', delta: 'Сейчас' },
          {
            type: 'tool_call_delta',
            index: 0,
            id: 'call_1',
            name: 'echo',
            argumentsDelta: '{"text":',
          },
          { type: 'tool_call_delta', index: 0, argumentsDelta: '"hi"}' },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        [
          { type: 'text', delta: 'Готово: hi' },
          { type: 'done', finishReason: 'stop' },
        ],
      ]),
      model: 'mock',
      messages: [{ role: 'user', content: 'echo hi' }],
      tools: [echoTool],
      executeTool: async (call) => {
        executed.push(`${call.name}:${call.arguments}`);
        return 'hi';
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(executed).toEqual(['echo:{"text":"hi"}']);
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Готово: hi',
    });
    expect(
      messages.some(
        (message) => message.role === 'tool' && message.content === 'hi',
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === 'tool_start' && event.call.name === 'echo',
      ),
    ).toBe(true);
  });

  it('stops when the model does not call tools', async () => {
    let calls = 0;
    const messages = await runAgentLoop({
      client: scripted([[{ type: 'text', delta: 'Привет' }, { type: 'done' }]]),
      model: 'mock',
      messages: [{ role: 'user', content: 'привет' }],
      tools: [echoTool],
      executeTool: async () => {
        calls += 1;
        return 'nope';
      },
      onEvent: () => undefined,
    });
    expect(calls).toBe(0);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Привет' });
  });

  it('stops after the step limit when the model keeps calling tools', async () => {
    const messages = await runAgentLoop({
      client: scripted([
        [
          {
            type: 'tool_call_delta',
            index: 0,
            id: 'c1',
            name: 'echo',
            argumentsDelta: '{}',
          },
          { type: 'done' },
        ],
        [
          {
            type: 'tool_call_delta',
            index: 0,
            id: 'c2',
            name: 'echo',
            argumentsDelta: '{}',
          },
          { type: 'done' },
        ],
      ]),
      model: 'mock',
      messages: [{ role: 'user', content: 'loop' }],
      tools: [echoTool],
      executeTool: async () => 'ok',
      onEvent: () => undefined,
      maxSteps: 2,
      limitMessage: 'limit',
    });
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'limit',
    });
  });

  it('returns tool errors to the model instead of aborting the loop', async () => {
    const messages = await runAgentLoop({
      client: scripted([
        [
          {
            type: 'tool_call_delta',
            index: 0,
            id: 'c1',
            name: 'echo',
            argumentsDelta: '{}',
          },
          { type: 'done' },
        ],
        [{ type: 'text', delta: 'recovered' }, { type: 'done' }],
      ]),
      model: 'mock',
      messages: [{ role: 'user', content: 'x' }],
      tools: [echoTool],
      executeTool: async () => {
        throw new Error('boom');
      },
      onEvent: () => undefined,
    });
    const tool = messages.find((message) => message.role === 'tool');
    expect(tool?.content).toContain('boom');
    expect(messages.at(-1)?.content).toBe('recovered');
  });
});
