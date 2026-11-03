import { isRecord } from './util';

/**
 * Интеграция с МойСклад только на чтение: наличие, резерв и цены по складам.
 * Токен хранит администратор (в настройках, зашифрован ключом JWT_SECRET).
 */
const API = 'https://api.moysklad.ru/api/remap/1.2';

export interface StockItem {
  name: string;
  article: string;
  code: string;
  price: number | null;
  stock: number;
  reserve: number;
  available: number;
  stores: { name: string; stock: number; reserve: number }[];
}

async function get(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'accept-encoding': 'gzip',
      accept: 'application/json;charset=utf-8',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403)
    throw new Error('МойСклад отклонил токен');
  if (!response.ok) throw new Error(`МойСклад ответил ${response.status}`);
  return response.json();
}

const money = (value: unknown) =>
  typeof value === 'number' ? Math.round(value) / 100 : null;

/** Поиск товаров по названию, артикулу или коду с остатками по складам. */
export async function searchStock(
  token: string,
  query: string,
  limit = 8,
): Promise<StockItem[]> {
  const q = query.trim().slice(0, 100);
  if (!q) return [];
  const search = encodeURIComponent(q);
  const [assortment, byStore] = await Promise.all([
    get(token, `/entity/assortment?search=${search}&limit=${limit}`),
    get(
      token,
      `/report/stock/bystore?filter=search=${search}&limit=${limit * 2}`,
    ).catch(() => undefined),
  ]);
  const stores = new Map<string, StockItem['stores']>();
  if (isRecord(byStore) && Array.isArray(byStore.rows)) {
    for (const row of byStore.rows) {
      if (
        !isRecord(row) ||
        !isRecord(row.meta) ||
        typeof row.meta.href !== 'string'
      )
        continue;
      const id = row.meta.href.split('?')[0]?.split('/').pop() ?? '';
      const list = Array.isArray(row.stockByStore) ? row.stockByStore : [];
      stores.set(
        id,
        list
          .filter(isRecord)
          .map((item) => ({
            name: String(item.name ?? ''),
            stock: Number(item.stock ?? 0),
            reserve: Number(item.reserve ?? 0),
          }))
          .filter((item) => item.stock !== 0 || item.reserve !== 0),
      );
    }
  }
  const rows =
    isRecord(assortment) && Array.isArray(assortment.rows)
      ? assortment.rows
      : [];
  return rows.filter(isRecord).map((row) => {
    const prices = Array.isArray(row.salePrices)
      ? row.salePrices.filter(isRecord)
      : [];
    const stock = Number(row.stock ?? 0);
    const reserve = Number(row.reserve ?? 0);
    return {
      name: String(row.name ?? ''),
      article: String(row.article ?? ''),
      code: String(row.code ?? ''),
      price: money(prices[0]?.value),
      stock,
      reserve,
      available: Number(row.quantity ?? stock - reserve),
      stores: stores.get(String(row.id ?? '')) ?? [],
    };
  });
}

/** Текст для модели: коротко и без лишних полей. */
export function formatStock(query: string, items: StockItem[]): string {
  if (items.length === 0)
    return `По запросу «${query}» в МойСклад ничего не найдено. Уточните артикул, OEM или название.`;
  const lines = items.map((item, index) => {
    const ids = [
      item.article && `арт. ${item.article}`,
      item.code && `код ${item.code}`,
    ]
      .filter(Boolean)
      .join(', ');
    const where = item.stores.length
      ? item.stores
          .map(
            (store) =>
              `${store.name}: ${store.stock}${store.reserve ? ` (резерв ${store.reserve})` : ''}`,
          )
          .join('; ')
      : '';
    return [
      `${index + 1}. ${item.name}${ids ? ` (${ids})` : ''}`,
      `   цена: ${item.price === null ? 'не указана' : `${item.price.toLocaleString('ru-RU')} ₽`}`,
      `   доступно: ${item.available} шт. (остаток ${item.stock}, резерв ${item.reserve})`,
      where && `   по складам: ${where}`,
    ]
      .filter(Boolean)
      .join('\n');
  });
  return `МойСклад, данные на ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' })} (Екб):\n${lines.join('\n')}`;
}

export async function checkMoyskladToken(token: string): Promise<string> {
  const data = await get(token, '/context/employee');
  const name = isRecord(data) ? String(data.name ?? data.fullName ?? '') : '';
  return name || 'подключено';
}
