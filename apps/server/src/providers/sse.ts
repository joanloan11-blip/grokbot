export interface SseMessage {
  event?: string;
  data: string;
}

export async function* readSse(response: Response): AsyncGenerator<SseMessage> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let splitAt = buffer.indexOf('\n\n');
    while (splitAt !== -1) {
      const raw = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const parsed = parseBlock(raw);
      if (parsed) yield parsed;
      splitAt = buffer.indexOf('\n\n');
    }
  }
  const tail = parseBlock(buffer);
  if (tail) yield tail;
}

function parseBlock(raw: string): SseMessage | undefined {
  if (!raw.trim()) return undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:'))
      dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join('\n') };
}

export async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text();
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}
