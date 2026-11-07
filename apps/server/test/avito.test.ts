import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  avitoToken,
  balance,
  checkAvito,
  formatBalance,
  formatItems,
  formatStats,
  itemStats,
  listItems,
} from '../src/avito';
import {
  avitoStatus,
  clearAvitoAccount,
  readAvitoAccount,
  saveAvitoAccount,
} from '../src/avito-account';

const account = {
  clientId: 'client-1',
  profileId: '777',
  name: 'Кабинет',
  secret: 'secret-1',
};

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Авито: OAuth и запросы', () => {
  it('получает токен client_credentials и кэширует его', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return jsonResponse({ access_token: 'tok-1', expires_in: 3600 });
      }),
    );
    const first = await avitoToken({ clientId: 'fresh-client', secret: 's' });
    const second = await avitoToken({ clientId: 'fresh-client', secret: 's' });
    expect(first).toBe('tok-1');
    expect(second).toBe('tok-1');
    expect(calls).toHaveLength(1);
  });

  it('понимает ответ Авито 200 с телом error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          error: 'unauthorized_client',
          error_description: 'The client is not authorized',
        }),
      ),
    );
    await expect(
      avitoToken({ clientId: 'probe-client', secret: 'probe' }),
    ).rejects.toThrow(/отклонил ключи/);
  });

  it('объясняет отказ по ключам', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'invalid_client' }, 401)),
    );
    await expect(
      avitoToken({ clientId: 'bad-client', secret: 'bad' }),
    ).rejects.toThrow(/отклонил ключи/);
  });

  it('читает аккаунт через /core/v1/accounts/self', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/token'))
          return jsonResponse({ access_token: 'tok', expires_in: 3600 });
        return jsonResponse({ id: 42, name: 'Рулевое управление', email: 'a@b.ru' });
      }),
    );
    const who = await checkAvito({ clientId: 'c2', secret: 's2' });
    expect(who).toEqual({ id: 42, name: 'Рулевое управление', email: 'a@b.ru' });
  });

  it('разбирает объявления и баланс', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/token'))
          return jsonResponse({ access_token: 'tok', expires_in: 3600 });
        if (String(url).includes('/items'))
          return jsonResponse({
            resources: [
              {
                id: 5,
                title: 'Рейка рулевая',
                price: { value: 12000 },
                status: 'active',
                url: 'https://www.avito.ru/5',
              },
            ],
            meta: { total: 1 },
          });
        return jsonResponse({ real: 1500, bonus: 200 });
      }),
    );
    const items = await listItems(account, { status: 'active', limit: 5 });
    expect(items.total).toBe(1);
    expect(items.items[0]).toMatchObject({
      id: 5,
      title: 'Рейка рулевая',
      price: 12000,
      status: 'active',
    });
    const money = await balance(account);
    expect(money).toEqual({ real: 1500, bonus: 200 });
  });

  it('считает статистику по полям uniqViews/uniqContacts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).endsWith('/token'))
          return jsonResponse({ access_token: 'tok', expires_in: 3600 });
        return jsonResponse({
          items: [
            { itemId: 5, stats: { uniqViews: 100, uniqContacts: 7, uniqFavorites: 3 } },
          ],
        });
      }),
    );
    const rows = await itemStats(account, { from: '2026-11-01', to: '2026-11-07' });
    expect(rows).toEqual([
      { itemId: 5, views: 100, contacts: 7, favorites: 3 },
    ]);
  });
});

describe('Авито: текст для модели', () => {
  it('перечисляет объявления с ценой', () => {
    const text = formatItems(
      {
        items: [
          {
            id: 5,
            title: 'Рейка',
            price: 12000,
            status: 'active',
            category: '',
            url: 'https://www.avito.ru/5',
          },
        ],
        total: 1,
      },
      'active',
    );
    expect(text).toContain('Рейка');
    expect(text).toContain('12');
    expect(text).toContain('active');
  });

  it('пишет «статистики нет», когда строк нет', () => {
    expect(formatStats([], '2026-11-01', '2026-11-07')).toContain('статистики нет');
  });

  it('форматирует баланс', () => {
    expect(formatBalance({ real: 1500, bonus: 200 })).toContain('Баланс Авито');
  });
});

describe('Авито: хранение кабинета', () => {
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

  it('шифрует секрет и возвращает кабинет', async () => {
    const store = fakeStore();
    await saveAvitoAccount(
      store as never,
      'jwt-secret',
      'user-1',
      { clientId: 'cid', clientSecret: 'very-secret', profileId: '777' },
      'Кабинет',
    );
    const raw = store.raw.get('avito:user-1') ?? '';
    expect(raw).not.toContain('very-secret');
    const account = await readAvitoAccount(
      store as never,
      'jwt-secret',
      'user-1',
    );
    expect(account).toMatchObject({ clientId: 'cid', secret: 'very-secret', profileId: '777' });
  });

  it('не отдаёт секрет в статусе', async () => {
    const store = fakeStore();
    await saveAvitoAccount(store as never, 'jwt-secret', 'user-2', {
      clientId: 'cid',
      clientSecret: 'hidden',
      profileId: '1',
    });
    const status = await avitoStatus(store as never, 'jwt-secret', 'user-2');
    expect(status.connected).toBe(true);
    expect(JSON.stringify(status)).not.toContain('hidden');
  });

  it('после отключения кабинета нет', async () => {
    const store = fakeStore();
    await saveAvitoAccount(store as never, 'jwt-secret', 'user-3', {
      clientId: 'cid',
      clientSecret: 'x',
      profileId: '1',
    });
    await clearAvitoAccount(store as never, 'user-3');
    const status = await avitoStatus(store as never, 'jwt-secret', 'user-3');
    expect(status.connected).toBe(false);
  });
});
