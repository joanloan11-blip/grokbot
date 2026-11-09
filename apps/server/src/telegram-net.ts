import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

/**
 * Telegram Bot API на российском VPS часто недоступен напрямую (TCP 443
 * к api.telegram.org не открывается). В этом случае запросы идут через
 * SOCKS5-прокси — у qastom это уже существующий SSH-туннель `llm-relay`.
 * Переменная окружения: `TELEGRAM_PROXY=socks5://llm-relay:1080`.
 * Без переменной используется обычный fetch.
 */
export interface Socks5Proxy {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseSocksProxy(
  value: string | undefined,
): Socks5Proxy | undefined {
  const raw = (value ?? '').trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw.includes('://') ? raw : `socks5://${raw}`);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'socks5:' && parsed.protocol !== 'socks5h:') {
    return undefined;
  }
  const port = Number(parsed.port || 1080);
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return {
    host: parsed.hostname,
    port,
    ...(parsed.username
      ? { username: decodeURIComponent(parsed.username) }
      : {}),
    ...(parsed.password
      ? { password: decodeURIComponent(parsed.password) }
      : {}),
  };
}

function isTelegramHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'telegram.org' || host.endsWith('.telegram.org');
}

export function telegramProxyUrl(): string | undefined {
  const raw = (process.env.TELEGRAM_PROXY ?? '').trim();
  return raw || undefined;
}

interface SocksReply {
  status: number;
  host?: string;
  port?: number;
}

/** Устанавливает SOCKS5-соединение до host:port и отдаёт готовый сокет. */
export async function connectSocks5(
  proxy: Socks5Proxy,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<net.Socket> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const connection = net.connect(proxy.port, proxy.host);
    const fail = (error: Error) => {
      connection.destroy();
      reject(error);
    };
    connection.setTimeout(15_000, () =>
      fail(new Error('SOCKS5: таймаут подключения')),
    );
    connection.once('error', fail);
    connection.once('connect', () => {
      connection.removeListener('error', fail);
      resolve(connection);
    });
  });
  try {
    await socksHandshake(socket, proxy, host, port, signal);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function socksHandshake(
  socket: net.Socket,
  proxy: Socks5Proxy,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<void> {
  const reader = new SocksReader(socket, signal);
  try {
    if (proxy.username) {
      socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      const method = await reader.bytes(2);
      if (method[1] !== 0x02)
        throw new Error('SOCKS5: прокси не принял пароль');
      const user = Buffer.from(proxy.username, 'utf8');
      const pass = Buffer.from(proxy.password ?? '', 'utf8');
      socket.write(
        Buffer.concat([
          Buffer.from([0x01, user.length]),
          user,
          Buffer.from([pass.length]),
          pass,
        ]),
      );
      const auth = await reader.bytes(2);
      if (auth[1] !== 0x00)
        throw new Error('SOCKS5: неверный логин или пароль');
    } else {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
      const method = await reader.bytes(2);
      if (method[1] !== 0x00)
        throw new Error('SOCKS5: прокси требует авторизацию');
    }

    const name = Buffer.from(host, 'utf8');
    if (name.length > 255) throw new Error('SOCKS5: слишком длинное имя хоста');
    const request = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
      name,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]);
    socket.write(request);

    const head = await reader.bytes(4);
    const reply: SocksReply = { status: head[1] ?? 0xff };
    if (reply.status !== 0x00) {
      throw new Error(
        `SOCKS5: прокси отказал в подключении (код ${reply.status})`,
      );
    }
    const addressType = head[3];
    if (addressType === 0x01) await reader.bytes(4 + 2);
    else if (addressType === 0x04) await reader.bytes(16 + 2);
    else if (addressType === 0x03) {
      const length = (await reader.bytes(1))[0] ?? 0;
      await reader.bytes(length + 2);
    } else {
      throw new Error('SOCKS5: неизвестный формат ответа прокси');
    }
  } finally {
    reader.dispose();
  }
}

/** Читает ровно N байт из сокета, уважая сигнал отмены. */
class SocksReader {
  private buffer = Buffer.alloc(0);
  private pending: {
    bytes: number;
    resolve: (value: Buffer) => void;
    reject: (error: Error) => void;
  }[] = [];
  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.flush();
  };
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onEnd = () =>
    this.fail(new Error('SOCKS5: прокси закрыл соединение'));
  private readonly onAbort = () =>
    this.fail(new Error('SOCKS5: запрос отменён'));

  constructor(
    private readonly socket: net.Socket,
    private readonly signal?: AbortSignal,
  ) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('end', this.onEnd);
    signal?.addEventListener('abort', this.onAbort);
  }

  bytes(count: number): Promise<Buffer> {
    if (this.signal?.aborted) {
      return Promise.reject(new Error('SOCKS5: запрос отменён'));
    }
    if (this.buffer.length >= count) {
      const value = this.buffer.subarray(0, count);
      this.buffer = this.buffer.subarray(count);
      return Promise.resolve(value);
    }
    return new Promise<Buffer>((resolve, reject) => {
      this.pending.push({ bytes: count, resolve, reject });
    });
  }

  dispose(): void {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('end', this.onEnd);
    this.signal?.removeEventListener('abort', this.onAbort);
  }

  private flush(): void {
    while (this.pending.length > 0) {
      const next = this.pending[0];
      if (!next || this.buffer.length < next.bytes) return;
      this.pending.shift();
      const value = this.buffer.subarray(0, next.bytes);
      this.buffer = this.buffer.subarray(next.bytes);
      next.resolve(value);
    }
  }

  private fail(error: Error): void {
    this.dispose();
    for (const item of this.pending.splice(0)) item.reject(error);
  }
}

interface SocksResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * fetch-совместимый запрос через SOCKS5. Возвращает обычный Response,
 * поэтому остальной код Telegram-клиента не меняется.
 */
export function createTelegramFetch(
  proxyUrl: string,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  const proxy = parseSocksProxy(proxyUrl);
  if (!proxy) return baseFetch;
  const impl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('SOCKS5: поддерживаются только http(s)-адреса');
    }
    // Через туннель ходим только к Telegram: внутренние адреса (whisper,
    // runner, egress) остаются в своей сети.
    if (!isTelegramHost(url.hostname)) {
      return (
        baseFetch as (
          input: string | URL | Request,
          init?: RequestInit,
        ) => Promise<Response>
      )(input, init);
    }
    let target = url;
    let method = (init?.method ?? 'GET').toUpperCase();
    let body = await bodyToBuffer(init?.body);
    let headers = normalizeHeaders(init?.headers);
    for (let redirect = 0; redirect < 4; redirect += 1) {
      const response = await requestViaProxy(proxy, target, {
        method,
        headers,
        body,
        signal: init?.signal ?? undefined,
      });
      if (
        response.status >= 300 &&
        response.status < 400 &&
        typeof response.headers.location === 'string'
      ) {
        target = new URL(response.headers.location, target);
        if (method === 'POST') {
          method = 'GET';
          body = undefined;
          headers = {};
        }
        continue;
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) responseHeaders.set(name, value.join(', '));
        else if (typeof value === 'string') responseHeaders.set(name, value);
      }
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    }
    throw new Error('SOCKS5: слишком много перенаправлений');
  };
  return impl as typeof fetch;
}

async function bodyToBuffer(
  body: RequestInit['body'] | null | undefined,
): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams)
    return Buffer.from(body.toString(), 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  throw new Error('SOCKS5: неподдерживаемое тело запроса');
}

function normalizeHeaders(
  headers: RequestInit['headers'],
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      result[name] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) result[name] = value;
    return result;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name] = String(value);
  }
  return result;
}

async function requestViaProxy(
  proxy: Socks5Proxy,
  url: URL,
  options: {
    method: string;
    headers: Record<string, string>;
    body: Buffer | undefined;
    signal?: AbortSignal;
  },
): Promise<SocksResponse> {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const host = url.hostname;
  const socket = await connectSocks5(proxy, host, port, options.signal);
  const timeout = setTimeout(() => socket.destroy(), 25_000);
  try {
    if (url.protocol === 'https:') {
      const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const secure = tls.connect(
          { socket, servername: host, ALPNProtocols: ['http/1.1'] },
          () => resolve(secure),
        );
        secure.once('error', reject);
      });
      return await sendRequest(tlsSocket, url, options);
    }
    return await sendRequest(socket, url, options);
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}

function sendRequest(
  socket: net.Socket,
  url: URL,
  options: {
    method: string;
    headers: Record<string, string>;
    body: Buffer | undefined;
  },
): Promise<SocksResponse> {
  return new Promise<SocksResponse>((resolve, reject) => {
    const headers: Record<string, string> = {
      host: url.host,
      connection: 'close',
      ...options.headers,
    };
    if (options.body)
      headers['content-length'] = String(options.body.byteLength);
    const transport = url.protocol === 'https:' ? https : http;
    // Сокет уже соединён через SOCKS5: подменяем createConnection у агента,
    // иначе Node попытается открыть прямое соединение и проигнорирует туннель.
    const agent =
      url.protocol === 'https:'
        ? new https.Agent({ keepAlive: false })
        : new http.Agent({ keepAlive: false });
    Object.defineProperty(agent, 'createConnection', {
      value: () => socket,
    });
    const request = transport.request(
      {
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers,
        agent,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}
