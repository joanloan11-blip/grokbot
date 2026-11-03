import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractUploadText, readZipEntry } from '../src/files';
import { htmlToMarkdown, isBlockedAddress } from '../src/webtools';
import { runSandboxed, sandboxCommand } from '../src/sandbox';
import { toolNeedsApproval } from '../src/turn';
import type { Store } from '../src/db';

describe('platform guards', () => {
  it('blocks private and loopback addresses', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.1.2.3')).toBe(true);
    expect(isBlockedAddress('192.168.0.5')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
  });

  it('turns simple HTML into markdown', () => {
    const text = htmlToMarkdown(
      '<h1>Отчёт</h1><script>alert(1)</script><p>Цифра <b>2</b></p>',
    );
    expect(text).toContain('# Отчёт');
    expect(text).not.toContain('alert');
    expect(text).toContain('Цифра');
  });

  it('reads text, csv and a stored docx paragraph', () => {
    expect(
      extractUploadText('a.csv', 'text/csv', Buffer.from('a,b\n1,2')),
    ).toContain('1,2');
    const xml = '<w:t>Привет</w:t>';
    const name = Buffer.from('word/document.xml');
    const data = Buffer.from(xml);
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    expect(readZipEntry(local, 'word/document.xml')).toContain('Привет');
    const deflated = deflateRawSync(Buffer.from('<w:t>Сжато</w:t>'));
    const packed = Buffer.alloc(30 + name.length + deflated.length);
    packed.writeUInt32LE(0x04034b50, 0);
    packed.writeUInt16LE(8, 8);
    packed.writeUInt32LE(deflated.length, 18);
    packed.writeUInt16LE(name.length, 26);
    name.copy(packed, 30);
    deflated.copy(packed, 30 + name.length);
    expect(extractUploadText('note.docx', 'application/vnd', packed)).toContain(
      'Сжато',
    );
  });

  it('does not run code while the sandbox is off', async () => {
    let spawned = false;
    const text = await runSandboxed({
      enabled: false,
      language: 'python',
      code: 'print(1)',
      spawnImpl: (() => {
        spawned = true;
        throw new Error('no');
      }) as never,
    });
    expect(text).toContain('выключена');
    expect(spawned).toBe(false);
    expect(sandboxCommand('node', 'console.log(1)')?.args).toContain(
      '--network',
    );
  });

  it('asks for approval only when the admin enabled the gate', async () => {
    const values = new Map<string, string>();
    const store = {
      getSetting: async (key: string) => values.get(key),
    } as unknown as Store;
    expect(await toolNeedsApproval(store, 'send_to_agent')).toBe(false);
    values.set('approvals_enabled', '1');
    values.set('approval_auto', 'memory_write');
    expect(await toolNeedsApproval(store, 'send_to_agent')).toBe(true);
    expect(await toolNeedsApproval(store, 'mcp__demo__write')).toBe(true);
    expect(await toolNeedsApproval(store, 'memory_write')).toBe(false);
    values.set('approval_auto', 'send_to_agent');
    expect(await toolNeedsApproval(store, 'send_to_agent')).toBe(false);
  });

  it('converts HTML pages without executing markup', () => {
    const text = htmlToMarkdown('<p>1 &amp; 2</p>');
    expect(text).toContain('1 & 2');
  });
});
