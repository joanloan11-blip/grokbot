import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listProviderModels, probeModels } from '../src/providers/discover';

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/models')) {
        res.end(
          JSON.stringify({
            data: [
              'gpt-5.3-chat-latest',
              'gpt-5.1-codex-mini',
              'gpt-4o-2024-08-06',
              'gpt-4o-mini',
              'gpt-5-mini',
              'gpt-4.1',
            ].map((id) => ({ id })),
          }),
        );
        return;
      }
      const model = (JSON.parse(raw || '{}') as { model?: string }).model;
      if (model === 'gpt-5.3-chat-latest') {
        res.statusCode = 404;
        res.end(
          '{"error":{"code":"model_not_found","message":"has been deprecated"}}',
        );
        return;
      }
      res.end('{"choices":[{"message":{"content":"hi"}}]}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`;
});

afterAll(() => {
  server.close();
});

describe('model probing', () => {
  it('drops codex and dated snapshots and ranks stable models first', async () => {
    const models = await listProviderModels({
      kind: 'openai',
      baseUrl: base,
      apiKey: 'k',
    });
    expect(models).not.toContain('gpt-5.1-codex-mini');
    expect(models).not.toContain('gpt-4o-2024-08-06');
    expect(models.slice(0, 3)).toEqual([
      'gpt-5-mini',
      'gpt-4o-mini',
      'gpt-4.1',
    ]);
    expect(models.at(-1)).toBe('gpt-5.3-chat-latest');
  });

  it('marks deprecated models as failed', async () => {
    const result = await probeModels(
      { kind: 'openai', baseUrl: base, apiKey: 'k' },
      ['gpt-5.3-chat-latest', 'gpt-4o-mini'],
    );
    expect(result.failed).toEqual(['gpt-5.3-chat-latest']);
    expect(result.working).toEqual(['gpt-4o-mini']);
  });
});
