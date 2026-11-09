import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/**
 * IMAP-клиент для «почтового агента»: подключается к ящику владельца,
 * проверяет доступ и делает выжимку последних писем.
 *
 * Модуль самодостаточен: только стандартная библиотека Node, без npm-зависимостей.
 * Содержимое писем — недоверенные данные: мы разбираем его как MIME и никогда
 * не интерпретируем как команды. Пароль не попадает в тексты ошибок.
 */

export interface ImapAccount {
  host: string;
  port: number;
  /** true — TLS с первого байта (993). false — plain, при starttls=true и CAPABILITY STARTTLS — апгрейд. */
  secure: boolean;
  user: string;
  password: string;
  /** Папка, по умолчанию INBOX. */
  mailbox?: string;
  /** Запросить STARTTLS на plain-соединении. По умолчанию false. */
  starttls?: boolean;
  /** false — принимать самоподписанные сертификаты (только для тестов/локальных серверов). По умолчанию true. */
  rejectUnauthorized?: boolean;
}

export interface MailMessageSummary {
  uid: number;
  /** Декодированный From, например «Иван <ivan@example.ru>». */
  from: string;
  /** Декодированный Subject без encoded-word. */
  subject: string;
  /** ISO-строка, если дата распознана; иначе исходный Date header. */
  date: string;
  /** Текст письма, схлопнутые пробелы, обрезано до snippetChars. */
  snippet: string;
}

export interface ImapTestResult {
  ok: boolean;
  messages?: number;
  error?: string;
}

const CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_SNIPPET_CHARS = 600;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;
const MAX_MIME_DEPTH = 10;
const MAX_LITERAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAILBOX = 'INBOX';
const CRLF = '\r\n';

type ResponseSegment = string | Buffer;

interface ImapResponse {
  kind: 'tagged' | 'untagged' | 'continuation';
  tag?: string;
  status?: string;
  segments: ResponseSegment[];
}

interface PendingResponse {
  resolve: (response: ImapResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CommandResult {
  tagged: ImapResponse;
  untagged: ImapResponse[];
}

interface ParsedMime {
  headers: Map<string, string>;
  body: Buffer;
}

interface TextParts {
  plain: string[];
  html: string[];
}

// ------------------------------- Разбор ответов -------------------------------

function stringSegments(response: ImapResponse): string {
  return response.segments
    .filter((segment): segment is string => typeof segment === 'string')
    .join('');
}

/** Текст ответа из latin1-строк протокола в нормальный UTF-8. */
function decodeProtocolText(value: string): string {
  return Buffer.from(value, 'latin1').toString('utf8');
}

function parseResponse(segments: ResponseSegment[]): ImapResponse {
  const first = segments[0];
  const line = typeof first === 'string' ? first : '';
  if (line.startsWith('+')) {
    return { kind: 'continuation', segments };
  }
  if (!line.startsWith('*')) {
    const tagged = /^(\S+) (OK|NO|BAD|PREAUTH|BYE)\b/i.exec(line);
    if (tagged) {
      return {
        kind: 'tagged',
        tag: tagged[1],
        status: tagged[2]?.toUpperCase(),
        segments,
      };
    }
  }
  const untagged = /^\* (OK|NO|BAD|PREAUTH|BYE)\b/i.exec(line);
  return {
    kind: 'untagged',
    status: untagged?.[1]?.toUpperCase(),
    segments,
  };
}

function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[скрыто]');
}

function commandError(
  label: string,
  response: ImapResponse,
  password: string,
): Error {
  const detail = redactSecret(
    decodeProtocolText(stringSegments(response))
      .replace(/^\S+ (?:OK|NO|BAD|PREAUTH|BYE)\s*/i, '')
      .trim(),
    password,
  ).slice(0, 200);
  const status = response.status ?? 'NO';
  let base = 'Сервер почты отклонил запрос.';
  if (label === 'LOGIN') {
    base =
      'Не удалось войти в почтовый ящик: сервер отклонил логин или пароль.';
  } else if (label === 'SELECT') {
    base = 'Не удалось открыть папку: сервер отклонил запрос.';
  } else if (label === 'STARTTLS') {
    base = 'Сервер почты не смог включить защищённое соединение STARTTLS.';
  } else if (label === 'FETCH') {
    base = 'Не удалось получить письма из почтового ящика.';
  } else if (label === 'SEARCH') {
    base = 'Не удалось найти письма в почтовом ящике.';
  }
  return new Error(`${base} (${status}${detail ? `: ${detail}` : ''})`);
}

function mapNetworkError(error: Error, account: ImapAccount): Error {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (code === 'ECONNREFUSED') {
    return new Error(
      'Не удалось подключиться к почтовому серверу: соединение отклонено. Проверьте адрес и порт.',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error(
      'Не удалось подключиться к почтовому серверу: адрес не найден. Проверьте имя сервера.',
    );
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return new Error(
      'Соединение с почтовым сервером прервано. Попробуйте ещё раз.',
    );
  }
  const tlsCodes = [
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_SSL_WRONG_VERSION_NUMBER',
  ];
  if (code.startsWith('ERR_TLS') || tlsCodes.includes(code)) {
    return new Error(
      'Не удалось установить защищённое соединение: сертификат почтового сервера не прошёл проверку. Проверьте адрес и настройки TLS.',
    );
  }
  const message = redactSecret(error.message, account.password).trim();
  return new Error(
    `Ошибка соединения с почтовым сервером${message ? `: ${message}` : '.'}`,
  );
}

// ------------------------------- Соединение ----------------------------------

function tlsHostOptions(host: string): { servername?: string } {
  // Для IP-адреса SNI/проверка имени хоста не задаются.
  return isIP(host) ? {} : { servername: host };
}

function openSocket(account: ImapAccount): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: Socket;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('secureConnect', onConnect);
      socket.removeListener('error', onError);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      resolve(socket);
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(mapNetworkError(error, account));
    socket = account.secure
      ? tlsConnect({
          host: account.host,
          port: account.port,
          ...tlsHostOptions(account.host),
          rejectUnauthorized: account.rejectUnauthorized !== false,
        })
      : netConnect({ host: account.host, port: account.port });
    socket.once(account.secure ? 'secureConnect' : 'connect', onConnect);
    socket.once('error', onError);
    timer = setTimeout(
      () =>
        finish(
          new Error(
            'Не удалось подключиться к почтовому серверу за 15 секунд. Проверьте адрес и порт.',
          ),
        ),
      CONNECT_TIMEOUT_MS,
    );
  });
}

class ImapSession {
  private socket: Socket;
  private readonly account: ImapAccount;
  private buffer: Buffer = Buffer.alloc(0);
  private parts: ResponseSegment[] = [];
  private literalLength = -1;
  private queue: ImapResponse[] = [];
  private pending: PendingResponse[] = [];
  private failure?: Error;
  private closing = false;
  private tagCounter = 0;
  private greetingText = '';

  constructor(socket: Socket, account: ImapAccount) {
    this.socket = socket;
    this.account = account;
    this.attach(socket);
  }

  /** Закрывает сокет и снимает ожидающие таймеры. */
  destroy(): void {
    this.closing = true;
    const pending = this.pending;
    this.pending = [];
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(new Error('Соединение с почтовым сервером закрыто.'));
    }
    try {
      this.socket.destroy();
    } catch {
      // Сокет уже мог быть закрыт — это нормально.
    }
  }

  async readGreeting(): Promise<boolean> {
    const response = await this.readResponse(CONNECT_TIMEOUT_MS);
    if (response.kind !== 'untagged') {
      throw new Error(
        'Сервер почты прислал неожиданный ответ при подключении.',
      );
    }
    this.greetingText = decodeProtocolText(stringSegments(response));
    if (response.status === 'BYE') {
      throw new Error('Сервер почты отказал в подключении.');
    }
    return response.status === 'PREAUTH';
  }

  async capability(): Promise<Set<string>> {
    const capabilities = new Set<string>();
    const greeting = /\[CAPABILITY ([^\]]+)\]/i.exec(this.greetingText);
    if (greeting?.[1]) {
      for (const token of greeting[1].split(/\s+/)) {
        if (token) capabilities.add(token.toUpperCase());
      }
    }
    const { untagged } = await this.command('CAPABILITY', 'CAPABILITY');
    for (const response of untagged) {
      const match = /^\*\s+CAPABILITY\b(.*)$/i.exec(
        decodeProtocolText(stringSegments(response)),
      );
      if (!match?.[1]) continue;
      for (const token of match[1].split(/\s+/)) {
        if (token) capabilities.add(token.toUpperCase());
      }
    }
    return capabilities;
  }

  async login(): Promise<void> {
    await this.command(
      'LOGIN',
      `LOGIN ${quoteImap(this.account.user, 'логин')} ${quoteImap(
        this.account.password,
        'пароль',
      )}`,
    );
  }

  async startTls(): Promise<void> {
    await this.command('STARTTLS', 'STARTTLS');
    await this.upgradeToTls();
  }

  async selectMailbox(mailbox: string): Promise<number> {
    const { untagged } = await this.command(
      'SELECT',
      `SELECT ${quoteImap(mailbox, 'папка')}`,
    );
    let exists = 0;
    for (const response of untagged) {
      const match = /^\*\s+(\d+)\s+EXISTS\b/i.exec(
        decodeProtocolText(stringSegments(response)),
      );
      if (match?.[1]) exists = Number(match[1]);
    }
    return exists;
  }

  async search(since: Date | null): Promise<number[]> {
    const criterion = since ? `SINCE ${formatImapDate(since)}` : 'ALL';
    const { untagged } = await this.command(
      'SEARCH',
      `UID SEARCH ${criterion}`,
    );
    const uids: number[] = [];
    for (const response of untagged) {
      const match = /^\*\s+SEARCH\b(.*)$/i.exec(
        decodeProtocolText(stringSegments(response)),
      );
      if (!match) continue;
      for (const token of (match[1] ?? '').split(/\s+/)) {
        if (/^\d+$/.test(token)) uids.push(Number(token));
      }
    }
    return uids;
  }

  async fetchMessages(
    uids: number[],
  ): Promise<Array<{ uid: number; raw: Buffer }>> {
    if (uids.length === 0) return [];
    const { untagged } = await this.command(
      'FETCH',
      `UID FETCH ${uids.join(',')} (UID BODY.PEEK[])`,
    );
    const messages: Array<{ uid: number; raw: Buffer }> = [];
    for (const response of untagged) {
      const text = decodeProtocolText(stringSegments(response));
      if (!/^\*\s+\d+\s+FETCH\b/i.test(text)) continue;
      const uid = /\bUID\s+(\d+)/i.exec(text);
      if (!uid?.[1]) continue;
      const raw = response.segments.find((segment): segment is Buffer =>
        Buffer.isBuffer(segment),
      );
      if (!raw) continue;
      messages.push({ uid: Number(uid[1]), raw });
    }
    return messages;
  }

  private async command(
    label: string,
    command: string,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
    const tag = `A${++this.tagCounter}`;
    this.write(`${tag} ${command}${CRLF}`);
    const deadline = Date.now() + timeoutMs;
    const untagged: ImapResponse[] = [];
    for (;;) {
      const remaining = deadline - Date.now();
      const response = await this.readResponse(remaining > 0 ? remaining : 1);
      if (response.kind === 'continuation') {
        // Данных для продолжения у нас нет: подтверждаем пустой строкой,
        // чтобы сервер не ждал до собственного таймаута.
        this.write(CRLF);
        continue;
      }
      if (response.kind === 'tagged') {
        if (response.tag !== tag) continue;
        if (response.status !== 'OK') {
          throw commandError(label, response, this.account.password);
        }
        return { tagged: response, untagged };
      }
      untagged.push(response);
    }
  }

  private attach(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error: Error) =>
      this.fail(mapNetworkError(error, this.account)),
    );
    socket.on('end', () => {
      if (!this.closing) {
        this.fail(new Error('Почтовый сервер закрыл соединение.'));
      }
    });
    socket.on('close', () => {
      if (!this.closing) {
        this.fail(new Error('Почтовый сервер закрыл соединение.'));
      }
    });
  }

  private onData(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer =
      this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      this.parseIncoming();
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error('Не удалось разобрать ответ почтового сервера.'),
      );
    }
  }

  private parseIncoming(): void {
    for (;;) {
      if (this.literalLength >= 0) {
        if (this.buffer.length < this.literalLength) return;
        const literal = this.buffer.subarray(0, this.literalLength);
        this.buffer = this.buffer.subarray(this.literalLength);
        this.parts.push(Buffer.from(literal));
        this.literalLength = -1;
        continue;
      }
      const end = this.buffer.indexOf(CRLF);
      if (end < 0) return;
      const line = this.buffer.subarray(0, end).toString('latin1');
      this.buffer = this.buffer.subarray(end + CRLF.length);
      const marker = /\{(\d+)\+?\}$/.exec(line);
      this.parts.push(line);
      if (marker?.[1]) {
        const length = Number(marker[1]);
        if (!Number.isSafeInteger(length) || length > MAX_LITERAL_BYTES) {
          throw new Error('Почтовый сервер прислал слишком большое письмо.');
        }
        this.literalLength = length;
        continue;
      }
      const segments = this.parts;
      this.parts = [];
      this.pushResponse(parseResponse(segments));
    }
  }

  private pushResponse(response: ImapResponse): void {
    this.queue.push(response);
    while (this.pending.length > 0 && this.queue.length > 0) {
      const pending = this.pending.shift();
      const next = this.queue.shift();
      if (!pending || !next) break;
      clearTimeout(pending.timer);
      pending.resolve(next);
    }
  }

  private readResponse(timeoutMs: number): Promise<ImapResponse> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<ImapResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.fail(new Error('Сервер почты не ответил вовремя.'));
        },
        Math.max(timeoutMs, 1),
      );
      this.pending.push({ resolve, reject, timer });
    });
  }

  private write(data: string | Buffer): void {
    if (this.failure) throw this.failure;
    if (this.socket.destroyed) {
      throw new Error('Соединение с почтовым сервером потеряно.');
    }
    this.socket.write(data);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.queue = [];
    const pending = this.pending;
    this.pending = [];
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    try {
      this.socket.destroy();
    } catch {
      // Сокет уже закрыт — ничего не делаем.
    }
  }

  private async upgradeToTls(): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('end');
    plain.removeAllListeners('close');
    // После STARTTLS старые данные протокола (кроме ответа на команду) не нужны.
    this.buffer = Buffer.alloc(0);
    this.parts = [];
    this.literalLength = -1;
    const secure = await new Promise<Socket>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const socket = tlsConnect({
        socket: plain,
        ...tlsHostOptions(this.account.host),
        rejectUnauthorized: this.account.rejectUnauthorized !== false,
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket.removeListener('secureConnect', onConnect);
        socket.removeListener('error', onError);
        if (error) {
          socket.destroy();
          reject(error);
          return;
        }
        resolve(socket);
      };
      const onConnect = () => finish();
      const onError = (error: Error) =>
        finish(mapNetworkError(error, this.account));
      socket.once('secureConnect', onConnect);
      socket.once('error', onError);
      timer = setTimeout(
        () =>
          finish(
            new Error(
              'Не удалось установить защищённое соединение с почтовым сервером STARTTLS.',
            ),
          ),
        CONNECT_TIMEOUT_MS,
      );
    });
    this.socket = secure;
    this.attach(secure);
  }
}

// ------------------------------- Публичный API --------------------------------

function quoteImap(value: string, label: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Недопустимые символы в поле «${label}».`);
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function mailboxOf(account: ImapAccount): string {
  const mailbox = (account.mailbox ?? '').trim();
  return mailbox || DEFAULT_MAILBOX;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** IMAP-дата: dd-Mon-yyyy (например, 08-Nov-2026). */
function formatImapDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  return `${day}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
}

function friendlyError(error: unknown, password: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactSecret(raw, password).trim();
  return message || 'Не удалось подключиться к почтовому серверу.';
}

async function openSession(account: ImapAccount): Promise<ImapSession> {
  const socket = await openSocket(account);
  const session = new ImapSession(socket, account);
  try {
    const preauth = await session.readGreeting();
    const capabilities = await session.capability();
    if (!account.secure && account.starttls && capabilities.has('STARTTLS')) {
      await session.startTls();
      // После STARTTLS набор возможностей сервера мог измениться.
      await session.capability();
    }
    if (!preauth) await session.login();
    return session;
  } catch (error) {
    session.destroy();
    throw error instanceof Error
      ? error
      : new Error('Не удалось подключиться к почтовому серверу.');
  }
}

/** Проверяет доступ к ящику и возвращает количество писем в папке. */
export async function testImapAccount(
  account: ImapAccount,
): Promise<ImapTestResult> {
  let session: ImapSession | undefined;
  try {
    session = await openSession(account);
    const messages = await session.selectMailbox(mailboxOf(account));
    return { ok: true, messages };
  } catch (error) {
    return { ok: false, error: friendlyError(error, account.password) };
  } finally {
    session?.destroy();
  }
}

/** Последние письма ящика: свежие первыми. Пустой ящик — пустой массив. */
export async function fetchRecentMessages(
  account: ImapAccount,
  options?: { since?: Date; limit?: number; snippetChars?: number },
): Promise<MailMessageSummary[]> {
  const limit = clampLimit(options?.limit);
  const snippetChars = clampSnippetChars(options?.snippetChars);
  const since = resolveSince(options?.since as Date | null | undefined);
  let session: ImapSession | undefined;
  try {
    session = await openSession(account);
    await session.selectMailbox(mailboxOf(account));
    const uids = (await session.search(since))
      .sort((left, right) => left - right)
      .slice(-limit);
    if (uids.length === 0) return [];
    const fetched = await session.fetchMessages(uids);
    const messages = fetched.map((message) =>
      summarizeMessage(message.uid, message.raw, snippetChars),
    );
    messages.sort(
      (left, right) =>
        dateRank(right.date) - dateRank(left.date) || right.uid - left.uid,
    );
    return messages;
  } catch (error) {
    throw new Error(friendlyError(error, account.password));
  } finally {
    session?.destroy();
  }
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

function clampSnippetChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SNIPPET_CHARS;
  }
  return Math.max(Math.trunc(value), 1);
}

/**
 * since по умолчанию — сутки назад (тогда SEARCH SINCE); null/невалидная дата
 * означают поиск без ограничения по дате (SEARCH ALL).
 */
function resolveSince(value: Date | null | undefined): Date | null {
  if (value === undefined) return new Date(Date.now() - DEFAULT_SINCE_MS);
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value;
}

function dateRank(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

// ------------------------------- MIME-разбор ---------------------------------

function splitHeaderAndBody(raw: Buffer): ParsedMime {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  let index = -1;
  let length = 0;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    index = crlf;
    length = 4;
  } else if (lf >= 0) {
    index = lf;
    length = 2;
  }
  if (index < 0) return { headers: parseHeaders(raw), body: Buffer.alloc(0) };
  return {
    headers: parseHeaders(raw.subarray(0, index)),
    body: raw.subarray(index + length),
  };
}

/** Разворачивает (unfold) заголовки и возвращает их в виде карты (первое значение). */
function parseHeaders(headerBytes: Buffer): Map<string, string> {
  const headers = new Map<string, string>();
  // latin1 сохраняет байты 1:1, чтобы не потерять 8-битные заголовки.
  const lines = headerBytes.toString('latin1').split(/\r?\n/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (
      (line.startsWith(' ') || line.startsWith('\t')) &&
      unfolded.length > 0
    ) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
      continue;
    }
    unfolded.push(line);
  }
  for (const line of unfolded) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!name || headers.has(name)) continue;
    headers.set(
      name,
      Buffer.from(line.slice(colon + 1).trim(), 'latin1').toString('utf8'),
    );
  }
  return headers;
}

function firstHeader(headers: Map<string, string>, name: string): string {
  return headers.get(name) ?? '';
}

interface ParsedContentType {
  type: string;
  params: Map<string, string>;
}

function parseContentType(value: string): ParsedContentType {
  if (!value.trim()) {
    return { type: 'text/plain', params: new Map() };
  }
  const segments = splitParameters(value);
  const type = (segments.shift() ?? 'text/plain').trim().toLowerCase();
  const params = new Map<string, string>();
  for (const segment of segments) {
    const equals = segment.indexOf('=');
    if (equals <= 0) continue;
    const key = segment.slice(0, equals).trim().toLowerCase();
    let parameter = segment.slice(equals + 1).trim();
    if (parameter.startsWith('"')) {
      parameter = parameter.slice(1);
      if (parameter.endsWith('"')) parameter = parameter.slice(0, -1);
    }
    parameter = parameter.replace(/\\(.)/g, '$1');
    if (key) params.set(key, parameter);
  }
  return { type, params };
}

/** Делит строку параметров по «;», не трогая точки с запятой внутри кавычек. */
function splitParameters(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"' && value[index - 1] !== '\\') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === ';' && !quoted) {
      result.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  result.push(current);
  return result;
}

function splitMultipartBody(body: Buffer, boundary: string): Buffer[] {
  const lines = body.toString('latin1').split(/\r?\n/);
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === delimiter || line === `${delimiter}--`) {
      if (current) parts.push(current.join('\r\n'));
      if (line === `${delimiter}--`) {
        current = null;
        break;
      }
      current = [];
      continue;
    }
    current?.push(line);
  }
  if (current && current.length > 0) parts.push(current.join('\r\n'));
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Buffer.from(part, 'latin1'));
}

function decodeQuotedPrintable(input: Buffer): Buffer {
  const text = input.toString('latin1');
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== '=') {
      bytes.push(char.charCodeAt(0) & 0xff);
      continue;
    }
    const next = text[index + 1];
    if (next === '\r' && text[index + 2] === '\n') {
      index += 2;
      continue;
    }
    if (next === '\n') {
      index += 1;
      continue;
    }
    const hex = text.slice(index + 1, index + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(0x3d);
  }
  return Buffer.from(bytes);
}

function decodeTransferEncoding(body: Buffer, encoding: string): Buffer {
  if (encoding.includes('base64')) {
    const clean = body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(clean, 'base64');
  }
  if (encoding.includes('quoted-printable')) {
    return decodeQuotedPrintable(body);
  }
  return body;
}

const CHARSET_ALIASES: Record<string, string> = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  latin1: 'iso-8859-1',
  'latin-1': 'iso-8859-1',
  'iso-8859-1': 'iso-8859-1',
  ascii: 'windows-1252',
  'us-ascii': 'windows-1252',
  cp1251: 'windows-1251',
  windows1251: 'windows-1251',
  'win-1251': 'windows-1251',
  'windows-1251': 'windows-1251',
  koi8r: 'koi8-r',
  'koi8-r': 'koi8-r',
  cp866: 'ibm866',
  ibm866: 'ibm866',
  'iso-8859-5': 'iso-8859-5',
};

function normalizeCharset(charset: string | undefined): string | undefined {
  if (!charset) return undefined;
  const clean = charset
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '');
  if (!clean) return undefined;
  return CHARSET_ALIASES[clean] ?? clean;
}

/** Декодирует байты в строку: указанный charset, иначе UTF-8, иначе latin1. */
function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const name = normalizeCharset(charset);
  if (name) {
    try {
      return new TextDecoder(name, { fatal: false }).decode(bytes);
    } catch {
      // Неизвестная кодировка — пробуем UTF-8.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/** RFC 2047: декодирует encoded-word (=?charset?B?...?= и ?Q?...?=). */
function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value;
  const pattern = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let result = '';
  let cursor = 0;
  let previousWasEncoded = false;
  for (
    let match = pattern.exec(value);
    match !== null;
    match = pattern.exec(value)
  ) {
    const index = match.index;
    const gap = value.slice(cursor, index);
    // Пробелы только между двумя encoded-word по RFC 2047 отбрасываются.
    if (!previousWasEncoded || gap.trim().length > 0) result += gap;
    const charset = (match[1] ?? '').replace(/\*.*$/, '');
    const encoding = (match[2] ?? 'B').toUpperCase();
    const payload = match[3] ?? '';
    result += decodeEncodedWordPayload(payload, encoding, charset);
    cursor = index + match[0].length;
    previousWasEncoded = true;
  }
  result += value.slice(cursor);
  return result;
}

function decodeEncodedWordPayload(
  payload: string,
  encoding: string,
  charset: string,
): string {
  if (encoding === 'B') {
    const bytes = Buffer.from(payload.replace(/\s+/g, ''), 'base64');
    return decodeCharset(bytes, charset);
  }
  return decodeCharset(decodeQEncoding(payload), charset);
}

function decodeQEncoding(payload: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < payload.length; index++) {
    const char = payload[index];
    if (char === '_') {
      bytes.push(0x20);
      continue;
    }
    if (char === '=' && index + 2 < payload.length) {
      const hex = payload.slice(index + 1, index + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeHeaderValue(value: string): string {
  return decodeEncodedWords(value).trim();
}

function collectTextParts(
  headers: Map<string, string>,
  body: Buffer,
  depth: number,
): TextParts {
  if (depth > MAX_MIME_DEPTH) return { plain: [], html: [] };
  const contentType = parseContentType(firstHeader(headers, 'content-type'));
  if (contentType.type.startsWith('multipart/')) {
    const boundary = contentType.params.get('boundary');
    if (!boundary) return { plain: [], html: [] };
    const parts: TextParts = { plain: [], html: [] };
    for (const partBytes of splitMultipartBody(body, boundary)) {
      const part = splitHeaderAndBody(partBytes);
      const nested = collectTextParts(part.headers, part.body, depth + 1);
      parts.plain.push(...nested.plain);
      parts.html.push(...nested.html);
    }
    return parts;
  }
  const encoding = firstHeader(headers, 'content-transfer-encoding')
    .trim()
    .toLowerCase();
  const decoded = decodeTransferEncoding(body, encoding);
  const charset = contentType.params.get('charset');
  if (contentType.type === 'text/plain') {
    return { plain: [decodeCharset(decoded, charset)], html: [] };
  }
  if (contentType.type === 'text/html') {
    return { plain: [], html: [decodeCharset(decoded, charset)] };
  }
  if (contentType.type === 'message/rfc822') {
    const nestedPart = splitHeaderAndBody(decoded);
    return collectTextParts(nestedPart.headers, nestedPart.body, depth + 1);
  }
  return { plain: [], html: [] };
}

function extractMessageText(
  headers: Map<string, string>,
  body: Buffer,
): string {
  const parts = collectTextParts(headers, body, 0);
  // Приоритет — text/plain; HTML разбираем, только если текстовой части нет.
  for (const plain of parts.plain) {
    const clean = plain.trim();
    if (clean) return clean;
  }
  for (const html of parts.html) {
    const clean = htmlToText(html).trim();
    if (clean) return clean;
  }
  return '';
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  plusmn: '±',
  deg: '°',
  middot: '·',
  bull: '•',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function codePointToString(code: number): string | undefined {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined;
  try {
    return String.fromCodePoint(code);
  } catch {
    return undefined;
  }
}

function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (whole: string, decimal?: string, hexadecimal?: string, named?: string) => {
      if (decimal) return codePointToString(Number(decimal)) ?? whole;
      if (hexadecimal) {
        return codePointToString(parseInt(hexadecimal, 16)) ?? whole;
      }
      if (named) return HTML_ENTITIES[named.toLowerCase()] ?? whole;
      return whole;
    },
  );
}

/** HTML → читаемый текст: без script/style, тегов и с раскрытыми сущностями. */
function htmlToText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(
    /<(script|style|head|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' ',
  );
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(
    /<\/(p|div|li|tr|h[1-6]|table|blockquote|section|article)\s*>/gi,
    '\n',
  );
  text = text.replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(text);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function formatMailDate(raw: string): string {
  const header = decodeEncodedWords(raw).trim();
  if (!header) return '';
  const withoutComments = header
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parsed = new Date(withoutComments);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return header;
}

function summarizeMessage(
  uid: number,
  raw: Buffer,
  snippetChars: number,
): MailMessageSummary {
  const parsed = splitHeaderAndBody(raw);
  const text = extractMessageText(parsed.headers, parsed.body);
  const snippet = collapseWhitespace(text).slice(0, snippetChars).trimEnd();
  return {
    uid,
    from: decodeHeaderValue(firstHeader(parsed.headers, 'from')),
    subject: decodeHeaderValue(firstHeader(parsed.headers, 'subject')),
    date: formatMailDate(firstHeader(parsed.headers, 'date')),
    snippet,
  };
}
