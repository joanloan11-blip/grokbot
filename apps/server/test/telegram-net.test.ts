import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramFetch, parseSocksProxy } from '../src/telegram-net';

interface FakeProxy {
  port: number;
  close: () => Promise<void>;
}

/**
 * Минимальный SOCKS5-сервер для тестов: принимает CONNECT с доменом и
 * подключает его к заданному локальному порту (api.telegram.org → 127.0.0.1).
 */
function fakeSocksProxy(targetPort: number): Promise<FakeProxy> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let pending = Buffer.alloc(0);
      let upstreamReady = false;
      let stage: 'greeting' | 'connect' | 'pipe' = 'greeting';
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        if (stage === 'pipe') {
          if (!upstreamReady) pending = Buffer.concat([pending, chunk]);
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const methodCount = buffer[1] ?? 0;
          if (buffer.length < 2 + methodCount) return;
          buffer = buffer.subarray(2 + methodCount);
          socket.write(Buffer.from([0x05, 0x00]));
          stage = 'connect';
        }
        if (stage !== 'connect' || buffer.length < 5) return;
        const addressType = buffer[3];
        let host = '';
        let offset = 4;
        if (addressType === 0x03) {
          const length = buffer[4] ?? 0;
          if (buffer.length < 5 + length + 2) return;
          host = buffer.subarray(5, 5 + length).toString('utf8');
          offset = 5 + length;
        } else if (addressType === 0x01) {
          if (buffer.length < 4 + 4 + 2) return;
          host = [...buffer.subarray(4, 8)].join('.');
          offset = 8;
        } else {
          socket.destroy();
          return;
        }
        const port = (buffer[offset] << 8) | (buffer[offset + 1] ?? 0);
        buffer = buffer.subarray(offset + 2);
        stage = 'pipe';
        const rest = buffer;
        buffer = Buffer.alloc(0);
        const upstream = net.connect(
          host === 'api.telegram.org' ? targetPort : port,
          host === 'api.telegram.org' ? '127.0.0.1' : host,
          () => {
            socket.write(
              Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
            );
            const early = Buffer.concat([rest, pending]);
            if (early.length) upstream.write(early);
            pending = Buffer.alloc(0);
            upstreamReady = true;
            socket.pipe(upstream).pipe(socket);
          },
        );
        upstream.on('error', () => socket.destroy());
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('parseSocksProxy', () => {
  it('разбирает socks5-адрес и отклоняет мусор', () => {
    expect(parseSocksProxy('socks5://llm-relay:1080')).toEqual({
      host: 'llm-relay',
      port: 1080,
    });
    expect(parseSocksProxy('llm-relay:1081')).toEqual({
      host: 'llm-relay',
      port: 1081,
    });
    expect(parseSocksProxy('http://proxy:8080')).toBeUndefined();
    expect(parseSocksProxy('')).toBeUndefined();
  });
});

describe('createTelegramFetch', () => {
  it('идёт к api.telegram.org через SOCKS5 и возвращает Response', async () => {
    const api = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
    });
    await new Promise<void>((done) => api.listen(0, '127.0.0.1', done));
    const apiPort = (api.address() as net.AddressInfo).port;
    const proxy = await fakeSocksProxy(apiPort);
    cleanups.push(() => new Promise<void>((done) => api.close(() => done())));
    cleanups.push(proxy.close);

    const telegramFetch = createTelegramFetch(
      `socks5://127.0.0.1:${proxy.port}`,
    );
    const response = await telegramFetch(
      `http://api.telegram.org:${apiPort}/bot123:abc/getMe`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; url: string };
    expect(body.ok).toBe(true);
    expect(body.url).toBe('/bot123:abc/getMe');
  });

  it('отправляет POST с телом через прокси', async () => {
    const api = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(Buffer.concat(chunks));
      });
    });
    await new Promise<void>((done) => api.listen(0, '127.0.0.1', done));
    const apiPort = (api.address() as net.AddressInfo).port;
    const proxy = await fakeSocksProxy(apiPort);
    cleanups.push(() => new Promise<void>((done) => api.close(() => done())));
    cleanups.push(proxy.close);

    const telegramFetch = createTelegramFetch(
      `socks5://127.0.0.1:${proxy.port}`,
    );
    const response = await telegramFetch(
      `http://api.telegram.org:${apiPort}/bot123:abc/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: '1', text: 'привет' }),
      },
    );
    expect(await response.json()).toEqual({ chat_id: '1', text: 'привет' });
  });

  it('не проксирует внутренние адреса', async () => {
    const calls: string[] = [];
    const baseFetch = (async (input: string | URL) => {
      calls.push(String(input));
      return new Response('internal', { status: 200 });
    }) as typeof fetch;
    const telegramFetch = createTelegramFetch(
      'socks5://127.0.0.1:1',
      baseFetch,
    );
    const response = await telegramFetch('http://whisper:8080/inference');
    expect(await response.text()).toBe('internal');
    expect(calls).toEqual(['http://whisper:8080/inference']);
  });

  it('возвращает ошибку, если прокси недоступен', async () => {
    const telegramFetch = createTelegramFetch('socks5://127.0.0.1:1');
    await expect(
      telegramFetch('http://api.telegram.org/bot1:x/getMe'),
    ).rejects.toThrow();
  });
});
