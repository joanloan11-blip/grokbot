import type { KeyBalance } from '@mayak/shared';
import type { ProviderRow } from './db';
import { llmFetch } from './providers/http';
import { isRecord } from './util';

/**
 * Что провайдер сам сообщает о ключе: остаток и расход.
 * Отдают не все: у OpenAI, Anthropic и Google обычный ключ баланс не показывает.
 */
export async function keyBalance(
  provider: ProviderRow,
  fetchImpl: typeof llmFetch = llmFetch,
): Promise<KeyBalance> {
  const base: KeyBalance = {
    providerId: provider.id,
    name: provider.name,
    supported: false,
  };
  if (!provider.apiKey) return { ...base, note: 'Ключ не сохранён' };
  const url = (provider.baseUrl || '').replace(/\/$/, '');
  const get = async (target: string) => {
    const response = await fetchImpl(target, {
      headers: { authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json().catch(() => ({}))) as unknown;
    if (response.status === 401 || response.status === 403)
      throw new Error('Провайдер отклонил ключ');
    if (!response.ok) throw new Error(`Провайдер ответил ${response.status}`);
    return data;
  };
  try {
    if (provider.kind === 'deepseek' || /api\.deepseek\.com/.test(url)) {
      const data = await get(
        `${url.replace(/\/v1$/, '') || 'https://api.deepseek.com'}/user/balance`,
      );
      const infos =
        isRecord(data) && Array.isArray(data.balance_infos)
          ? data.balance_infos.filter(isRecord)
          : [];
      const main =
        infos.find((item) => item.currency === 'USD') ?? infos[0] ?? {};
      return {
        ...base,
        supported: true,
        balance: Number(main.total_balance ?? 0),
        currency: String(main.currency ?? 'USD'),
        note:
          isRecord(data) && data.is_available === false
            ? 'Баланса не хватает для запросов'
            : undefined,
      };
    }
    if (/openrouter\.ai/.test(url)) {
      const data = await get('https://openrouter.ai/api/v1/key');
      const info = isRecord(data) && isRecord(data.data) ? data.data : {};
      const limit = typeof info.limit === 'number' ? info.limit : null;
      return {
        ...base,
        supported: true,
        used: Number(info.usage ?? 0),
        limit,
        balance:
          typeof info.limit_remaining === 'number'
            ? info.limit_remaining
            : undefined,
        currency: 'USD',
      };
    }
    if (/api\.moonshot\.(ai|cn)/.test(url)) {
      const data = await get(`${url}/users/me/balance`);
      const info = isRecord(data) && isRecord(data.data) ? data.data : {};
      return {
        ...base,
        supported: true,
        balance: Number(info.available_balance ?? 0),
        currency: /\.cn/.test(url) ? 'CNY' : 'USD',
      };
    }
  } catch (error) {
    return {
      ...base,
      note: error instanceof Error ? error.message : 'Не удалось получить',
    };
  }
  if (/integrate\.api\.nvidia\.com/.test(url))
    return {
      ...base,
      note: 'Бесплатный доступ NVIDIA: баланс по API не отдаётся, лимит около 40 запросов в минуту на ключ. Кредиты смотрите на build.nvidia.com.',
    };
  const where = /api\.openai\.com/.test(url)
    ? 'platform.openai.com/usage'
    : provider.kind === 'anthropic'
      ? 'console.anthropic.com'
      : provider.kind === 'gemini'
        ? 'aistudio.google.com'
        : 'кабинете провайдера';
  return {
    ...base,
    note: `Провайдер не отдаёт баланс по этому ключу — смотрите в ${where}. Расход ниже посчитан Маяком по токенам из ответов.`,
  };
}
