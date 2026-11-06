import type {
  LLMClient,
  ModelMessage,
  ProviderEvent,
  ToolDefinition,
} from './types';

/**
 * Локальная модель без сети. Нужна, чтобы чат, навыки и MCP можно было проверить
 * сразу после запуска. Команды описаны в README.
 */
export function createMockClient(): LLMClient {
  return {
    async *stream(input): AsyncGenerator<ProviderEvent> {
      const chunks = replyFor(input.messages, input.tools);
      // Похоже на реальный провайдер: перед done приходит расход токенов.
      const output = chunks.reduce(
        (sum, event) =>
          sum +
          (event.type === 'text'
            ? event.delta.length
            : event.type === 'tool_call_delta'
              ? (event.argumentsDelta ?? '').length
              : 0),
        0,
      );
      const input_ = input.messages.reduce(
        (sum, message) => sum + message.content.length,
        0,
      );
      chunks.splice(chunks.length - 1, 0, {
        type: 'usage',
        inputTokens: Math.ceil(input_ / 4),
        outputTokens: Math.ceil(output / 4),
        cachedTokens: 0,
      });
      for (const event of chunks) {
        yield event;
        if (event.type === 'text' && !process.env.VITEST) {
          await delay(12);
        }
        if (event.type === 'reasoning' && !process.env.VITEST) {
          await delay(250);
        }
      }
    },
  };
}

function replyFor(
  messages: ModelMessage[],
  tools: ToolDefinition[],
): ProviderEvent[] {
  const last = messages.at(-1);
  if (last?.role === 'tool') {
    const text =
      last.name === 'load_skill'
        ? `Навык загружен. Демо-модель не следует инструкциям сама — она показывает, что агентный цикл дошёл до результата.\n\n${clip(last.content, 700)}`
        : `Инструмент «${last.name ?? 'tool'}» вернул:\n\n${last.content}`;
    return textEvents(text);
  }

  const user = [...messages]
    .reverse()
    .find((message) => message.role === 'user');
  const text = (user?.content ?? '').trim();
  const toolCmd = text.match(/^tool\s+(\S+)\s*([\s\S]*)$/i);
  if (toolCmd?.[1]) {
    const found = findTool(tools, toolCmd[1]);
    const args = (toolCmd[2] ?? '').trim() || '{}';
    if (!found)
      return textEvents(
        `Инструмент «${toolCmd[1]}» не найден.\n\n${toolList(tools)}`,
      );
    return toolEvents(found.name, args);
  }

  // «think 5» — демо размышлений: модель «думает» 5 секунд, потом отвечает.
  const thinkCmd = text.match(/^(?:think|подумай)\s+(\d+)\s*$/i);
  if (thinkCmd?.[1]) {
    const seconds = Math.min(30, Number(thinkCmd[1]));
    const thoughts: ProviderEvent[] = [];
    const lines = [
      'Разбираю вопрос и что именно нужно пользователю.',
      'Проверяю, какие инструменты могут помочь.',
      'Сравниваю варианты ответа, отбрасываю слабые.',
      'Собираю ответ коротко и по делу.',
    ];
    const steps = process.env.VITEST ? 2 : seconds * 4;
    for (let i = 0; i < steps; i++)
      thoughts.push({
        type: 'reasoning',
        delta: `${lines[i % lines.length]} `,
      });
    return [...thoughts, ...textEvents('Подумал и готов ответить.')];
  }

  const skillCmd = text.match(/^(?:skill|навык)\s+(\S+)\s*$/i);
  if (skillCmd?.[1] && findTool(tools, 'load_skill')) {
    return toolEvents('load_skill', JSON.stringify({ name: skillCmd[1] }));
  }

  const echoCmd = text.match(/^echo\s+([\s\S]+)$/i);
  const echo = findTool(tools, 'echo');
  if (echoCmd?.[1] && echo)
    return toolEvents(echo.name, JSON.stringify({ text: echoCmd[1].trim() }));

  const addCmd = text.match(
    /^add\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/i,
  );
  const add = findTool(tools, 'add');
  if (addCmd?.[1] && addCmd[2] && add) {
    return toolEvents(
      add.name,
      JSON.stringify({ a: Number(addCmd[1]), b: Number(addCmd[2]) }),
    );
  }

  return textEvents(
    [
      'Я демо-модель QASTOM AGENT и работаю без внешнего API.',
      `Вы написали: «${text || '…'}».`,
      '',
      'Команды демо-модели:',
      '• skill summary — загрузить навык',
      '• echo <текст> — вызвать инструмент echo, если MCP-сервер подключён',
      '• add <a> <b> — сложить два числа',
      '• tool <имя> <json> — вызвать любой доступный инструмент',
      '',
      toolList(tools),
    ].join('\n'),
  );
}

function findTool(
  tools: ToolDefinition[],
  name: string,
): ToolDefinition | undefined {
  return (
    tools.find((tool) => tool.name === name) ??
    tools.find(
      (tool) =>
        tool.name.endsWith(`__${name}`) || tool.name.endsWith(`_${name}`),
    )
  );
}

function toolList(tools: ToolDefinition[]): string {
  if (tools.length === 0)
    return 'Сейчас модели не передано ни одного инструмента.';
  return `Доступные инструменты: ${tools.map((tool) => tool.name).join(', ')}.`;
}

function toolEvents(name: string, args: string): ProviderEvent[] {
  return [
    {
      type: 'tool_call_delta',
      index: 0,
      id: `call_mock_${name}`,
      name,
      argumentsDelta: args,
    },
    { type: 'done', finishReason: 'tool_calls' },
  ];
}

function textEvents(text: string): ProviderEvent[] {
  const size = 24;
  const events: ProviderEvent[] = [];
  for (let i = 0; i < text.length; i += size) {
    events.push({ type: 'text', delta: text.slice(i, i + size) });
  }
  events.push({ type: 'done', finishReason: 'stop' });
  return events;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
