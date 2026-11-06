import { fitBody, llmFetch, proxyFor } from './http';
import { isRecord } from '../util';
import { readErrorBody, readSse } from './sse';
import type {
  LLMClient,
  ModelMessage,
  ProviderEvent,
  ToolDefinition,
} from './types';

/** Модели, которые отказались от инструментов: сразу шлём им запрос без tools. */
const NO_TOOLS = new Set<string>();

export function toolsUnsupported(detail: string): boolean {
  return (
    /tool|function/i.test(detail) &&
    /not (currently )?supported|unsupported|does not support|doesn't support|not available|not enabled/i.test(
      detail,
    )
  );
}

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
    // Провайдер присылает в последнем чанке реальный расход токенов.
    stream_options: { include_usage: true },
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

  const send = () =>
    llmFetch(openAiChatUrl(options.baseUrl), {
      method: 'POST',
      headers: {
        ...(options.apiKey
          ? { authorization: `Bearer ${options.apiKey}` }
          : {}),
        'content-type': 'application/json',
      },
      // Через прокси большие тела не проходят — ужимаем историю.
      body: JSON.stringify(
        proxyFor(openAiChatUrl(options.baseUrl)) ? fitBody(body) : body,
      ),
      signal: options.signal,
    });
  const toolKey = `${options.baseUrl}|${options.model}`;
  let withoutTools = false;
  if (body.tools && NO_TOOLS.has(toolKey)) {
    delete body.tools;
    withoutTools = true;
  }
  let response = await send();
  // 429: бесплатные API режут частоту (OVHcloud — 2 запроса в минуту). Ждём и повторяем.
  for (let attempt = 0; attempt < 3 && response.status === 429; attempt++) {
    const header = Number(response.headers.get('retry-after'));
    const waitSec = Math.min(
      30,
      Number.isFinite(header) && header > 0
        ? Math.ceil(header)
        : 10 * (attempt + 1),
    );
    yield {
      type: 'reasoning',
      delta: `Провайдер ограничил частоту запросов — жду ${waitSec} с и повторяю…\n`,
    };
    await new Promise((resolve) =>
      setTimeout(resolve, process.env.VITEST ? 5 : waitSec * 1000),
    );
    if (options.signal?.aborted) break;
    response = await send();
  }
  // Совместимые API бывают неполными: повторяем без того, что они не знают.
  for (let attempt = 0; attempt < 2 && response.status === 400; attempt++) {
    const detail = await response
      .clone()
      .text()
      .catch(() => '');
    if (body.stream_options && /stream_options|include_usage/i.test(detail)) {
      delete body.stream_options;
    } else if (body.tools && toolsUnsupported(detail)) {
      // Модель не умеет вызывать инструменты (часто у Qwen 2.5, Llama 3 и т.п.).
      NO_TOOLS.add(toolKey);
      delete body.tools;
      withoutTools = true;
    } else break;
    response = await send();
  }
  if (withoutTools && response.ok)
    yield {
      type: 'reasoning',
      delta:
        'Эта модель не умеет вызывать инструменты (склад, поиск, MCP) — отвечаю без них. Для работы с инструментами выберите другую модель.\n',
    };

  if (!response.ok) {
    const detail = await readErrorBody(response);
    if (
      response.status === 404 &&
      /model_not_found|deprecated|does not exist/i.test(detail)
    ) {
      yield {
        type: 'error',
        message: `Модель «${options.model}» больше недоступна у провайдера. Выберите другую модель в поле ввода или нажмите «Загрузить модели» в Настройках → Модели.`,
      };
      return;
    }
    if (response.status === 401 || response.status === 403) {
      yield {
        type: 'error',
        message: options.apiKey
          ? `Провайдер не принял ключ (${response.status}). Проверьте ключ в настройках модели.`
          : `Модель «${options.model}» требует ключ: без ключа у этого провайдера работают не все модели. Выберите другую модель (с пометкой MCP ✓) или добавьте ключ провайдера.`,
      };
      return;
    }
    if (response.status === 429) {
      yield {
        type: 'error',
        message: `Провайдер ограничил частоту запросов (429)${/nvidia\.com/.test(options.baseUrl) ? ': у бесплатного NVIDIA около 40 запросов в минуту на ключ' : ''}. Подождите минуту или выберите другую модель.`,
      };
      return;
    }
    if (response.status === 451) {
      yield {
        type: 'error',
        message:
          'Провайдер недоступен из страны сервера (451). Нужен LLM_PROXY_URL, и хост провайдера должен быть в LLM_PROXY_HOSTS.',
      };
      return;
    }
    yield {
      type: 'error',
      message: `OpenAI-совместимый API ${response.status}: ${detail}`,
    };
    return;
  }

  let finishReason: string | undefined;
  let usageSent = false;
  for await (const message of readSse(response)) {
    if (message.data.trim() === '[DONE]') {
      yield { type: 'done', finishReason };
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
    const usage = readOpenAiUsage(json.usage);
    if (usage && !usageSent) {
      usageSent = true;
      yield usage;
    }
    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    if (!isRecord(choice)) {
      if (usageSent && finishReason) {
        yield { type: 'done', finishReason };
        return;
      }
      continue;
    }
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
      // Чанк с usage приходит после finish_reason — дочитываем поток.
      finishReason = choice.finish_reason;
      if (usageSent) {
        yield { type: 'done', finishReason };
        return;
      }
    }
  }
  yield { type: 'done', finishReason };
}

/** usage из OpenAI-совместимого ответа (OpenAI, DeepSeek, OpenRouter, xAI…). */
export function readOpenAiUsage(
  raw: unknown,
): Extract<ProviderEvent, { type: 'usage' }> | undefined {
  if (!isRecord(raw)) return undefined;
  const input = Number(raw.prompt_tokens ?? raw.input_tokens);
  const output = Number(raw.completion_tokens ?? raw.output_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  const details = isRecord(raw.prompt_tokens_details)
    ? raw.prompt_tokens_details
    : isRecord(raw.input_tokens_details)
      ? raw.input_tokens_details
      : undefined;
  const cached = Number(
    raw.prompt_cache_hit_tokens ?? details?.cached_tokens ?? 0,
  );
  return {
    type: 'usage',
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
    cachedTokens: Number.isFinite(cached) ? cached : 0,
  };
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
