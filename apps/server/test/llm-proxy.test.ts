import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { llmFetch, proxyFor } from '../src/providers/http';

afterEach(() => {
  delete process.env.LLM_PROXY_URL;
  delete process.env.LLM_PROXY_HOSTS;
});

describe('LLM proxy', () => {
  it('only proxies listed provider hosts', () => {
    expect(
      proxyFor('https://api.openai.com/v1/chat/completions'),
    ).toBeUndefined();
    process.env.LLM_PROXY_URL = 'http://u:p@127.0.0.1:1';
    expect(proxyFor('https://api.openai.com/v1/chat/completions')).toBe(
      'http://u:p@127.0.0.1:1',
    );
    expect(
      proxyFor('https://api.deepseek.com/chat/completions'),
    ).toBeUndefined();
    expect(
      proxyFor('https://integrate.api.nvidia.com/v1/chat/completions'),
    ).toBeDefined();
    process.env.LLM_PROXY_HOSTS = 'api.deepseek.com';
    expect(proxyFor('https://api.deepseek.com/x')).toBeDefined();
    expect(proxyFor('https://api.openai.com/x')).toBeUndefined();
  });

  it('sends requests through the proxy with credentials', async () => {
    const target = http.createServer((_req, res) => res.end('ok-from-target'));
    await new Promise<void>((resolve) =>
      target.listen(0, '127.0.0.1', resolve),
    );
    const targetPort = (target.address() as net.AddressInfo).port;
    let auth = '';
    const proxy = http.createServer();
    // undici ходит через прокси методом CONNECT и для http-адресов.
    proxy.on('connect', (req, socket) => {
      auth = String(req.headers['proxy-authorization'] ?? '');
      const [host, port] = String(req.url).split(':');
      const upstream = net.connect(Number(port), host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as net.AddressInfo).port;
    process.env.LLM_PROXY_URL = `http://user:secret@127.0.0.1:${proxyPort}`;
    process.env.LLM_PROXY_HOSTS = '127.0.0.1';
    try {
      const response = await llmFetch(
        `http://127.0.0.1:${targetPort}/v1/models`,
        { method: 'GET' },
      );
      expect(await response.text()).toBe('ok-from-target');
      expect(auth).toBe(
        `Basic ${Buffer.from('user:secret').toString('base64')}`,
      );
    } finally {
      proxy.close();
      target.close();
    }
  });
});
