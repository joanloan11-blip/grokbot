export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
  name?: string;
}

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string };

export interface LLMClient {
  stream(input: {
    model: string;
    messages: ModelMessage[];
    tools: ToolDefinition[];
    signal?: AbortSignal;
  }): AsyncIterable<ProviderEvent>;
}
