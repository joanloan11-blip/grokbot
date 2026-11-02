import type { ToolCall } from '@mayak/shared';
import type {
  LLMClient,
  ModelMessage,
  ProviderEvent,
  ToolDefinition,
} from '../providers/types';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_result'; call: ToolCall; content: string }
  | { type: 'error'; message: string };

export interface AgentLoopInput {
  client: LLMClient;
  model: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  executeTool: (call: ToolCall) => Promise<string>;
  onEvent: (event: AgentEvent) => void | Promise<void>;
  maxSteps?: number;
  signal?: AbortSignal;
  limitMessage?: string;
}

export async function runAgentLoop(
  input: AgentLoopInput,
): Promise<ModelMessage[]> {
  const history = [...input.messages];
  const maxSteps = input.maxSteps ?? 8;

  for (let step = 0; step < maxSteps; step += 1) {
    throwIfAborted(input.signal);
    const turn = await collectTurn(
      input.client,
      input.model,
      history,
      input.tools,
      input.signal,
      input.onEvent,
    );
    if (turn.toolCalls.length === 0) {
      const assistant: ModelMessage = { role: 'assistant', content: turn.text };
      history.push(assistant);
      await input.onEvent({ type: 'assistant', content: turn.text });
      return history;
    }

    const assistant: ModelMessage = {
      role: 'assistant',
      content: turn.text,
      toolCalls: turn.toolCalls,
    };
    history.push(assistant);
    await input.onEvent({
      type: 'assistant',
      content: turn.text,
      toolCalls: turn.toolCalls,
    });

    for (const call of turn.toolCalls) {
      throwIfAborted(input.signal);
      await input.onEvent({ type: 'tool_start', call });
      let content: string;
      try {
        content = await input.executeTool(call);
      } catch (error) {
        content = `Ошибка инструмента: ${error instanceof Error ? error.message : String(error)}`;
      }
      const toolMessage: ModelMessage = {
        role: 'tool',
        content,
        toolCallId: call.id,
        name: call.name,
      };
      history.push(toolMessage);
      await input.onEvent({ type: 'tool_result', call, content });
    }
  }

  const limit =
    input.limitMessage ?? 'Остановлено: исчерпан лимит шагов агента.';
  history.push({ role: 'assistant', content: limit });
  await input.onEvent({ type: 'assistant', content: limit });
  return history;
}

async function collectTurn(
  client: LLMClient,
  model: string,
  messages: ModelMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal | undefined,
  onEvent: AgentLoopInput['onEvent'],
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  let text = '';
  const acc = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const event of client.stream({ model, messages, tools, signal })) {
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'text') {
      text += event.delta;
      await onEvent({ type: 'text', delta: event.delta });
    } else if (event.type === 'tool_call_delta') {
      applyToolDelta(acc, event);
    }
  }

  const toolCalls = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call)
    .filter((call) => call.name)
    .map((call) => ({
      id: call.id || `call_${call.name}`,
      name: call.name,
      arguments: call.arguments || '{}',
    }));

  return { text, toolCalls };
}

function applyToolDelta(
  acc: Map<number, { id: string; name: string; arguments: string }>,
  event: Extract<ProviderEvent, { type: 'tool_call_delta' }>,
): void {
  const current = acc.get(event.index) ?? { id: '', name: '', arguments: '' };
  if (event.id) current.id = event.id;
  if (event.name) current.name = event.name;
  if (event.argumentsDelta) current.arguments += event.argumentsDelta;
  acc.set(event.index, current);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Запрос отменён');
    error.name = 'AbortError';
    throw error;
  }
}
