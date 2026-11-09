import { isRecord } from './util';

/**
 * Авито напрямую по API: пользователь вводит Client_id, Client_secret и Profile_id,
 * приложение само получает OAuth-токен (client_credentials) и работает от его имени.
 *
 * Секрет хранится зашифрованным (JWT_SECRET) в настройках пользователя, ключ
 * `avito:<userId>`; в браузер после сохранения не возвращается.
 */
const API = 'https://api.avito.ru';

export interface AvitoAccount {
  clientId: string;
  profileId: string;
  name?: string;
  secret: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokens = new Map<string, CachedToken>();

function basicError(status: number, what: string): Error {
  if (status === 401 || status === 403)
    return new Error(
      `Авито отклонил ключи (${status}). Проверьте Client_id и Client_secret — доступ выдаётся в личном кабинете Авито в разделе API.`,
    );
  if (status === 429)
    return new Error('Авито ограничил частоту запросов — повторите через минуту.');
  return new Error(`${what}: Авито ответил ${status}`);
}

/** Токен на 24 часа; держим в памяти и переиспользуем. */
export async function avitoToken(account: {
  clientId: string;
  secret: string;
}): Promise<string> {
  const cached = tokens.get(account.clientId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: account.clientId,
    client_secret: account.secret,
  });
  const response = await fetch(`${API}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok) throw basicError(response.status, 'Не удалось войти');
  if (!data.access_token) {
    // Авито отвечает 200 с телом error вместо 401 — разбираем оба случая.
    const detail = `${data.error ?? ''} ${data.error_description ?? ''}`.toLowerCase();
    throw new Error(
      detail.includes('unauthorized_client') || data.error
        ? 'Авито отклонил ключи: проверьте Client_id и Client_secret и что доступ к API включён в кабинете Авито.'
        : 'Авито не выдал токен: проверьте Client_id и Client_secret.',
    );
  }
  const ttl = (data.expires_in ?? 86_400) * 1000;
  tokens.set(account.clientId, {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(ttl, 120_000),
  });
  return data.access_token;
}

async function call(
  account: { clientId: string; secret: string },
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const token = await avitoToken(account);
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw basicError(response.status, 'Запрос к Авито');
  if (response.status === 204) return {};
  return response.json();
}

/** Кто подключён — проверка ключей и имя аккаунта. */
export async function checkAvito(account: {
  clientId: string;
  secret: string;
}): Promise<{ id: number | null; name: string; email: string }> {
  const data = await call(account, '/core/v1/accounts/self');
  if (!isRecord(data)) return { id: null, name: 'подключено', email: '' };
  return {
    id: typeof data.id === 'number' ? data.id : null,
    name: String(data.name ?? 'подключено'),
    email: String(data.email ?? ''),
  };
}

export interface AvitoItem {
  id: number | null;
  title: string;
  price: number | null;
  status: string;
  category: string;
  url: string;
}

/** Свои объявления: активные, отклонённые, снятые. */
export async function listItems(
  account: AvitoAccount,
  options: { status?: string; limit?: number } = {},
): Promise<{ items: AvitoItem[]; total: number | null }> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const query = new URLSearchParams({ per_page: String(limit), page: '1' });
  if (options.status) query.set('status', options.status);
  const data = await call(account, `/core/v1/items?${query}`);
  const rows =
    isRecord(data) && Array.isArray(data.resources) ? data.resources : [];
  const items = rows.filter(isRecord).map((row) => ({
    id: typeof row.id === 'number' ? row.id : null,
    title: String(row.title ?? ''),
    price:
      isRecord(row.price) && typeof row.price.value === 'number'
        ? row.price.value
        : null,
    status: String(row.status ?? ''),
    category: String(
      (isRecord(row.category) && row.category.name) ?? row.category ?? '',
    ),
    url: String(row.url ?? (typeof row.id === 'number' ? `https://www.avito.ru/${row.id}` : '')),
  }));
  const total =
    isRecord(data) && isRecord(data.meta) && typeof data.meta.total === 'number'
      ? data.meta.total
      : null;
  return { items, total };
}

export interface AvitoStatsRow {
  itemId: number | null;
  views: number;
  contacts: number;
  favorites: number;
}

/**
 * Статистика по объявлениям за период: просмотры, контакты, избранное.
 * Сутки в формате YYYY-MM-DD, период не больше 30 дней (ограничение Авито).
 */
export async function itemStats(
  account: AvitoAccount,
  options: { from: string; to: string; itemIds?: number[]; limit?: number },
): Promise<AvitoStatsRow[]> {
  const body: Record<string, unknown> = {
    dateFrom: options.from,
    dateTo: options.to,
    fields: ['uniqViews', 'uniqContacts', 'uniqFavorites'],
    limit: Math.min(Math.max(options.limit ?? 20, 1), 100),
    offset: 0,
  };
  if (options.itemIds?.length) body.itemIds = options.itemIds.slice(0, 50);
  const data = await call(
    account,
    `/stats/v1/accounts/${encodeURIComponent(account.profileId)}/items`,
    { method: 'POST', body },
  );
  const rows =
    isRecord(data) && Array.isArray(data.items) ? data.items : [];
  return rows.filter(isRecord).map((row) => {
    const stats = isRecord(row.stats) ? row.stats : row;
    return {
      itemId: typeof row.itemId === 'number' ? row.itemId : null,
      views: Number(stats.uniqViews ?? stats.views ?? 0),
      contacts: Number(stats.uniqContacts ?? stats.contacts ?? 0),
      favorites: Number(stats.uniqFavorites ?? stats.favorites ?? 0),
    };
  });
}

/** Баланс кошелька: реальные деньги и бонусы. */
export async function balance(account: AvitoAccount): Promise<{
  real: number;
  bonus: number;
}> {
  const data = await call(
    account,
    `/core/v1/accounts/${encodeURIComponent(account.profileId)}/balance/`,
  );
  const read = (key: string) =>
    isRecord(data) && typeof data[key] === 'number' ? (data[key] as number) : 0;
  return { real: read('real'), bonus: read('bonus') };
}

// ─── текст для модели ────────────────────────────────────────────────────────

export function formatItems(
  result: { items: AvitoItem[]; total: number | null },
  status?: string,
): string {
  if (!result.items.length)
    return `Объявлений${status ? ` со статусом «${status}»` : ''} не нашлось.`;
  const lines = result.items.map((item, index) => {
    const price =
      item.price === null ? 'цена не указана' : `${item.price.toLocaleString('ru-RU')} ₽`;
    return `${index + 1}. ${item.title || `объявление ${item.id}`} — ${price} (${item.status})${item.url ? `\n   ${item.url}` : ''}`;
  });
  const total = result.total === null ? '' : `Всего: ${result.total}. `;
  return `${total}Объявления Авито:\n${lines.join('\n')}`;
}

export function formatStats(rows: AvitoStatsRow[], from: string, to: string): string {
  if (!rows.length) return `За период ${from}–${to} статистики нет.`;
  const lines = rows.map(
    (row, index) =>
      `${index + 1}. объявление ${row.itemId ?? '—'}: просмотры ${row.views}, контакты ${row.contacts}, в избранном ${row.favorites}`,
  );
  return `Статистика Авито за ${from}–${to}:\n${lines.join('\n')}`;
}

export function formatBalance(value: { real: number; bonus: number }): string {
  return `Баланс Авито: ${value.real.toLocaleString('ru-RU')} ₽, бонусов на ${value.bonus.toLocaleString('ru-RU')} ₽.`;
}
