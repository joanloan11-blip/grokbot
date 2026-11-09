import { describe, expect, it } from 'vitest';
import {
  addHost,
  hostSummaries,
  listHosts,
  quoteRemote,
  removeHost,
} from '../src/remote';

function fakeStore() {
  const values = new Map<string, string>();
  return {
    getSetting: async (key: string) => values.get(key),
    setSetting: async (key: string, value: string) => {
      values.set(key, value);
    },
    raw: values,
  };
}

const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';

describe('удалённые серверы: хранение', () => {
  it('шифрует ключ и не отдаёт его в списке', async () => {
    const store = fakeStore();
    const saved = await addHost(store as never, 'jwt-secret', {
      name: 'qastom',
      host: '217.197.114.108',
      port: 22,
      user: 'rus',
      privateKey: key,
    });
    const raw = store.raw.get('ssh_hosts') ?? '';
    expect(raw).not.toContain('OPENSSH PRIVATE KEY');
    expect(saved).toMatchObject({ name: 'qastom', user: 'rus', port: 22 });

    const summaries = await hostSummaries(store as never, 'jwt-secret');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty('privateKey');

    const hosts = await listHosts(store as never, 'jwt-secret');
    expect(hosts[0]?.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  it('не отдаёт серверы без ключа шифрования', async () => {
    const store = fakeStore();
    await addHost(store as never, 'jwt-secret', {
      name: 's',
      host: 'example.com',
      port: 22,
      user: 'root',
      privateKey: key,
    });
    expect(await listHosts(store as never, undefined)).toEqual([]);
    expect(await listHosts(store as never, 'other-secret')).toEqual([]);
  });

  it('удаляет сервер по id', async () => {
    const store = fakeStore();
    const saved = await addHost(store as never, 'jwt-secret', {
      name: 's',
      host: 'example.com',
      port: 2222,
      user: 'root',
      privateKey: key,
    });
    expect(await removeHost(store as never, saved.id)).toBe(true);
    expect(await removeHost(store as never, saved.id)).toBe(false);
    expect(await listHosts(store as never, 'jwt-secret')).toEqual([]);
  });
});

describe('удалённые серверы: экранирование', () => {
  it('заключает путь в кавычки и экранирует одинарные', () => {
    expect(quoteRemote('/var/log/app.log')).toBe("'/var/log/app.log'");
    expect(quoteRemote("/tmp/a'b")).toBe("'/tmp/a'\\''b'");
  });
});
