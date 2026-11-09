import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchRecentMessages,
  testImapAccount,
  type ImapAccount,
} from '../src/imap';

interface FakeMessage {
  uid: number;
  raw: Buffer;
}

interface FakeServerOptions {
  messages: FakeMessage[];
  /** Явное число EXISTS (для пустого ящика). По умолчанию — messages.length. */
  exists?: number;
  password?: string;
}

interface FakeServer {
  port: number;
  commands: string[];
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  // Закрываем серверы и сокеты, чтобы vitest не ждал открытых хэндлов.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function account(
  port: number,
  overrides: Partial<ImapAccount> = {},
): ImapAccount {
  return {
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'owner@example.ru',
    password: 'secret',
    ...overrides,
  };
}

/** Простой токенизатор IMAP-строк: атомы и quoted strings с escape. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (command[index] === ' ') index++;
    if (index >= command.length) break;
    if (command[index] === '"') {
      index++;
      let token = '';
      while (index < command.length) {
        const char = command[index];
        if (char === '\\') {
          token += command[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (char === '"') {
          index++;
          break;
        }
        token += char;
        index++;
      }
      tokens.push(token);
      continue;
    }
    let token = '';
    while (index < command.length && command[index] !== ' ') {
      token += command[index];
      index++;
    }
    tokens.push(token);
  }
  return tokens;
}

function startFakeServer(options: FakeServerOptions): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const expectedPassword = options.password ?? 'secret';
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {
      // Обрыв на стороне теста — штатная ситуация.
    });
    socket.write('* OK [CAPABILITY IMAP4rev1] Тестовый IMAP-сервер готов\r\n');

    let input = '';
    const send = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };

    const handle = (line: string) => {
      commands.push(line);
      const space = line.indexOf(' ');
      if (space < 0) return;
      const tag = line.slice(0, space);
      const tokens = tokenize(line.slice(space + 1));
      const command = (tokens[0] ?? '').toUpperCase();

      if (command === 'CAPABILITY') {
        send('* CAPABILITY IMAP4rev1');
        send(`${tag} OK CAPABILITY completed`);
        return;
      }
      if (command === 'LOGIN') {
        if ((tokens[2] ?? '') === expectedPassword) {
          send(`${tag} OK [CAPABILITY IMAP4rev1] LOGIN completed`);
        } else {
          send(`${tag} NO [AUTHENTICATIONFAILED] Неверный логин или пароль`);
        }
        return;
      }
      if (command === 'SELECT' || command === 'EXAMINE') {
        const exists = options.exists ?? options.messages.length;
        send(`* ${exists} EXISTS`);
        send('* 0 RECENT');
        send('* OK [UIDVALIDITY 1] UID valid');
        send(`${tag} OK [READ-WRITE] SELECT completed`);
        return;
      }
      if (command === 'UID' && (tokens[1] ?? '').toUpperCase() === 'SEARCH') {
        const uids = options.messages.map((message) => message.uid);
        send(`* SEARCH${uids.length > 0 ? ` ${uids.join(' ')}` : ''}`);
        send(`${tag} OK SEARCH completed`);
        return;
      }
      if (command === 'UID' && (tokens[1] ?? '').toUpperCase() === 'FETCH') {
        const requested = (tokens[2] ?? '')
          .split(',')
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value));
        for (const uid of requested) {
          const message = options.messages.find((item) => item.uid === uid);
          if (!message || socket.destroyed) continue;
          const sequence = options.messages.indexOf(message) + 1;
          socket.write(
            `* ${sequence} FETCH (UID ${uid} BODY[] {${message.raw.length}}\r\n`,
          );
          socket.write(message.raw);
          socket.write(')\r\n');
        }
        send(`${tag} OK FETCH completed`);
        return;
      }
      if (command === 'LOGOUT') {
        send('* BYE');
        send(`${tag} OK LOGOUT completed`);
        socket.end();
        return;
      }
      if (command === 'NOOP') {
        send(`${tag} OK NOOP completed`);
        return;
      }
      send(`${tag} BAD неизвестная команда`);
    };

    socket.on('data', (chunk) => {
      input += chunk.toString('latin1');
      for (;;) {
        const index = input.indexOf('\r\n');
        if (index < 0) break;
        const line = input.slice(0, index);
        input = input.slice(index + 2);
        handle(line);
      }
    });
  });

  return new Promise<FakeServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      let closed = false;
      const close = () => {
        if (closed) return Promise.resolve();
        closed = true;
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        return new Promise<void>((done) => server.close(() => done()));
      };
      cleanups.push(close);
      resolve({ port, commands, close });
    });
  });
}

// --------------------------- Сборка тестовых писем ---------------------------

function encodedWordUtf8(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** Кириллица в windows-1251 без внешних зависимостей. */
function cp1251Bytes(text: string): Buffer {
  const bytes: number[] = [];
  for (const symbol of text) {
    const code = symbol.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    if (symbol === 'Ё') {
      bytes.push(0xa8);
      continue;
    }
    if (symbol === 'ё') {
      bytes.push(0xb8);
      continue;
    }
    if (code >= 0x410 && code <= 0x42f) {
      bytes.push(0xc0 + (code - 0x410));
      continue;
    }
    if (code >= 0x430 && code <= 0x44f) {
      bytes.push(0xe0 + (code - 0x430));
      continue;
    }
    bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

function quotedPrintable(bytes: Buffer): string {
  let result = '';
  for (const byte of bytes) {
    if (byte >= 33 && byte <= 126 && byte !== 0x3d) {
      result += String.fromCharCode(byte);
      continue;
    }
    result += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return result;
}

interface MessageInput {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  contentType: string;
  transferEncoding?: string;
  body: Buffer | string;
}

function buildMessage(input: MessageInput): FakeMessage {
  const lines = [
    `From: ${input.from}`,
    'To: owner@example.ru',
    `Subject: ${input.subject}`,
    `Date: ${input.date.toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: ${input.contentType}`,
  ];
  if (input.transferEncoding) {
    lines.push(`Content-Transfer-Encoding: ${input.transferEncoding}`);
  }
  const headers = `${lines.join('\r\n')}\r\n\r\n`;
  const body =
    typeof input.body === 'string'
      ? Buffer.from(input.body, 'utf8')
      : input.body;
  return {
    uid: input.uid,
    raw: Buffer.concat([Buffer.from(headers, 'utf8'), body]),
  };
}

function primaryMessages(): FakeMessage[] {
  const now = Date.now();
  const base64Text = buildMessage({
    uid: 1,
    from: `${encodedWordUtf8('Иван Петров')} <ivan@example.ru>`,
    subject: encodedWordUtf8('Привет из теста'),
    date: new Date(now - 3 * 60 * 60 * 1000),
    contentType: 'text/plain; charset="UTF-8"',
    transferEncoding: 'base64',
    body: Buffer.from(
      'Здравствуйте! Это первое письмо для проверки.',
      'utf8',
    ).toString('base64'),
  });

  const windowsSubject = quotedPrintable(cp1251Bytes('Письмо в windows-1251'));
  const windowsBody = cp1251Bytes(
    'Это письмо в кодировке windows-1251. Проверяем декодирование.',
  );
  const windowsText = buildMessage({
    uid: 2,
    from: 'Пётр <petr@example.ru>',
    subject: `=?windows-1251?Q?${windowsSubject}?=`,
    date: new Date(now - 2 * 60 * 60 * 1000),
    contentType: 'text/plain; charset=windows-1251',
    transferEncoding: '8bit',
    body: windowsBody,
  });

  const multipartBody = [
    '--ALT-BOUNDARY',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Текстовая версия письма',
    '--ALT-BOUNDARY',
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<p>HTML =D0=B2=D0=B5=D1=80=D1=81=D0=B8=D1=8F</p>',
    '--ALT-BOUNDARY--',
    '',
  ].join('\r\n');
  const multipart = buildMessage({
    uid: 3,
    from: 'Мария <maria@example.ru>',
    subject: encodedWordUtf8('Мультиписьмо'),
    date: new Date(now - 60 * 60 * 1000),
    contentType: 'multipart/alternative; boundary="ALT-BOUNDARY"',
    body: multipartBody,
  });

  return [base64Text, windowsText, multipart];
}

// ---------------------------------- Тесты ------------------------------------

describe('IMAP: подключение и проверка ящика', () => {
  it('подключается, логинится и возвращает количество писем', async () => {
    const server = await startFakeServer({ messages: primaryMessages() });
    const result = await testImapAccount(account(server.port));
    expect(result).toEqual({ ok: true, messages: 3 });
    expect(
      server.commands.some((line) =>
        /LOGIN "owner@example\.ru" "secret"/.test(line),
      ),
    ).toBe(true);
    expect(server.commands.some((line) => /SELECT "INBOX"/.test(line))).toBe(
      true,
    );
  });

  it('возвращает ok:false при неверном пароле и не раскрывает пароль', async () => {
    const server = await startFakeServer({ messages: primaryMessages() });
    const password = 'SuperSecret42';
    const result = await testImapAccount(account(server.port, { password }));
    expect(result.ok).toBe(false);
    expect(result.messages).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('парол');
    expect(result.error).not.toContain(password);
  });

  it('экранирует кавычки и бэкслеши в логине и пароле', async () => {
    const password = 'p"a\\ss"word';
    const server = await startFakeServer({
      messages: [],
      exists: 0,
      password,
    });
    const result = await testImapAccount(
      account(server.port, { user: 'own"er', password }),
    );
    expect(result).toEqual({ ok: true, messages: 0 });
  });

  it('продолжает без TLS, если STARTTLS запрошен, но сервер его не предлагает', async () => {
    const server = await startFakeServer({ messages: [], exists: 0 });
    const result = await testImapAccount(
      account(server.port, { starttls: true }),
    );
    expect(result).toEqual({ ok: true, messages: 0 });
  });

  it('объясняет отказ в соединении по-русски', async () => {
    const server = await startFakeServer({ messages: [] });
    const port = server.port;
    await server.close();
    const result = await testImapAccount(account(port));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/подключ|соединен/i);
  });
});

describe('IMAP: выжимка писем', () => {
  it('читает письма, декодирует MIME и сортирует свежие первыми', async () => {
    const server = await startFakeServer({ messages: primaryMessages() });
    const messages = await fetchRecentMessages(account(server.port));

    expect(messages.map((message) => message.uid)).toEqual([3, 2, 1]);
    expect(
      server.commands.some((line) =>
        /UID SEARCH SINCE \d{1,2}-[A-Z][a-z]{2}-\d{4}/.test(line),
      ),
    ).toBe(true);

    // UID 3: multipart/alternative, приоритет у text/plain.
    expect(messages[0]?.subject).toBe('Мультиписьмо');
    expect(messages[0]?.from).toBe('Мария <maria@example.ru>');
    expect(messages[0]?.snippet).toBe('Текстовая версия письма');

    // UID 2: windows-1251 и encoded-word в теме.
    expect(messages[1]?.subject).toBe('Письмо в windows-1251');
    expect(messages[1]?.from).toBe('Пётр <petr@example.ru>');
    expect(messages[1]?.snippet).toContain('windows-1251');
    expect(messages[1]?.snippet).toContain('Проверяем декодирование');

    // UID 1: base64 UTF-8 и encoded-word в From/Subject.
    expect(messages[2]?.from).toBe('Иван Петров <ivan@example.ru>');
    expect(messages[2]?.subject).toBe('Привет из теста');
    expect(messages[2]?.snippet).toBe(
      'Здравствуйте! Это первое письмо для проверки.',
    );

    // Дата — ISO-строка, порядок действительно по дате.
    expect(Number.isNaN(Date.parse(messages[0]?.date ?? ''))).toBe(false);
    expect(Date.parse(messages[0]?.date ?? '')).toBeGreaterThan(
      Date.parse(messages[1]?.date ?? ''),
    );
  });

  it('учитывает limit и snippetChars', async () => {
    const server = await startFakeServer({ messages: primaryMessages() });
    const limited = await fetchRecentMessages(account(server.port), {
      limit: 2,
    });
    expect(limited.map((message) => message.uid)).toEqual([3, 2]);

    const short = await fetchRecentMessages(account(server.port), {
      limit: 1,
      snippetChars: 10,
    });
    expect(short).toHaveLength(1);
    expect(short[0]?.snippet.length).toBeLessThanOrEqual(10);
    expect(short[0]?.snippet.length).toBeGreaterThan(0);
  });

  it('возвращает пустой массив для пустого ящика', async () => {
    const server = await startFakeServer({ messages: [], exists: 0 });
    await expect(fetchRecentMessages(account(server.port))).resolves.toEqual(
      [],
    );
  });

  it('преобразует HTML в читаемый текст, если text/plain нет', async () => {
    const html = [
      '<html><head><style>p{color:red}</style></head><body>',
      '<p>Скидка&nbsp;&laquo;Осень&raquo; &amp; подарок</p>',
      '<script>alert("x")</script>',
      '</body></html>',
    ].join('');
    const message = buildMessage({
      uid: 7,
      from: 'Магазин <shop@example.ru>',
      subject: 'Акция',
      date: new Date(),
      contentType: 'text/html; charset="UTF-8"',
      transferEncoding: 'quoted-printable',
      body: quotedPrintable(Buffer.from(html, 'utf8')),
    });
    const server = await startFakeServer({ messages: [message] });
    const [summary] = await fetchRecentMessages(account(server.port));
    expect(summary?.snippet).toBe('Скидка «Осень» & подарок');
  });

  it('сообщает о неверном пароле понятной ошибкой', async () => {
    const server = await startFakeServer({ messages: primaryMessages() });
    const password = 'WrongPassword77';
    let caught: unknown;
    try {
      await fetchRecentMessages(account(server.port, { password }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('парол');
    expect(message).not.toContain(password);
  });
});
