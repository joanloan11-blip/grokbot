import type { ToolCall } from '@mayak/shared';
import type {
  LLMClient,
  ModelMessage,
  ProviderEvent,
  ToolDefinition,
} from '../providers/types';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | {
      type: 'assistant';
      content: string;
      reasoning?: string;
      toolCalls?: ToolCall[];
    }
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
    shrinkToolResults(history, input.messages.length);
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
      await input.onEvent({
        type: 'assistant',
        content: turn.text,
        reasoning: nonempty(turn.reasoning),
      });
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
      reasoning: nonempty(turn.reasoning),
      toolCalls: turn.toolCalls,
    });

    // Независимые read-only инструменты (поиск, чтение файлов, память) запускаем
    // параллельно — это ускоряет ход, не меняя порядок ответов в истории.
    const safeNames = new Set(
      input.tools.filter((tool) => tool.parallelSafe).map((tool) => tool.name),
    );
    const parallel =
      turn.toolCalls.length > 1 &&
      turn.toolCalls.every((call) => safeNames.has(call.name));
    const runTool = async (call: ToolCall): Promise<string> => {
      try {
        return await input.executeTool(call);
      } catch (error) {
        return `Ошибка инструмента: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    if (parallel) {
      for (const call of turn.toolCalls) {
        throwIfAborted(input.signal);
        await input.onEvent({ type: 'tool_start', call });
      }
      const results = await Promise.all(
        turn.toolCalls.map((call) => runTool(call)),
      );
      for (const [index, call] of turn.toolCalls.entries()) {
        const content = results[index] ?? '';
        history.push({
          role: 'tool',
          content,
          toolCallId: call.id,
          name: call.name,
        });
        await input.onEvent({ type: 'tool_result', call, content });
      }
    } else {
      for (const call of turn.toolCalls) {
        throwIfAborted(input.signal);
        await input.onEvent({ type: 'tool_start', call });
        const content = await runTool(call);
        history.push({
          role: 'tool',
          content,
          toolCallId: call.id,
          name: call.name,
        });
        await input.onEvent({ type: 'tool_result', call, content });
      }
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
): Promise<{ text: string; reasoning: string; toolCalls: ToolCall[] }> {
  let text = '';
  let reasoning = '';
  const acc = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const event of client.stream({ model, messages, tools, signal })) {
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'text') {
      text += event.delta;
      await onEvent({ type: 'text', delta: event.delta });
    } else if (event.type === 'reasoning') {
      reasoning += event.delta;
      await onEvent({ type: 'reasoning', delta: event.delta });
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

  return { text, reasoning, toolCalls };
}

/** Сколько символов истории держим в долгом цикле (≈60–80 тыс. токенов). */
export const LOOP_HISTORY_CHARS = 240_000;
const KEEP_RECENT_TOOLS = 6;

/**
 * Долгая работа (код: десятки чтений файлов) раздувает контекст. Если история
 * больше лимита, старые результаты инструментов этого хода сокращаем —
 * свежие оставляем целиком. Модель при нужде перечитает файл.
 */
export function shrinkToolResults(
  history: ModelMessage[],
  from: number,
  limit = LOOP_HISTORY_CHARS,
): void {
  const size = () =>
    history.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
  if (size() <= limit) return;
  const toolIndexes = history
    .map((message, index) =>
      message.role === 'tool' && index >= from ? index : -1,
    )
    .filter((index) => index >= 0);
  for (const index of toolIndexes.slice(0, -KEEP_RECENT_TOOLS)) {
    const message = history[index]!;
    if (message.content.length > 600)
      history[index] = {
        ...message,
        content: `${message.content.slice(0, 400)}\n… [сокращено ради экономии контекста, было ${message.content.length} символов — при необходимости вызови инструмент снова]`,
      };
    if (size() <= limit) return;
  }
}

function nonempty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? value : undefined;
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
