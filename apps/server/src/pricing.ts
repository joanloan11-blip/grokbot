import type { ModelPrice } from '@mayak/shared';
import type { Store } from './db';

/**
 * Цены по умолчанию, $ за 1 млн токенов (input / cached input / output).
 * Провайдеры меняют цены — администратор переопределяет их в Настройках → Расходы.
 * DeepSeek считаем по дневному (пиковому) тарифу: ночью реально в 2 раза дешевле.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.2': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.1': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5.1-codex-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
  'gpt-6.1-terra': { input: 1, cached: 0.05, output: 5 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
  'gpt-4.1': { input: 2, cached: 0.5, output: 8 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  'o4-mini': { input: 1.1, cached: 0.275, output: 4.4 },
  'gpt-image-1-mini': { input: 2, cached: 0.2, output: 8 },
  'gpt-image': { input: 5, cached: 1.25, output: 40 },
  // DeepSeek (старые имена deepseek-chat/reasoner идут по тарифу Flash)
  'deepseek-chat': { input: 0.3, cached: 0.006, output: 1.2 },
  'deepseek-reasoner': { input: 0.3, cached: 0.006, output: 1.2 },
  'deepseek-flash': { input: 0.3, cached: 0.006, output: 1.2 },
  'deepseek-v4-flash': { input: 0.3, cached: 0.006, output: 1.2 },
  'deepseek-v4-pro': { input: 1.32, cached: 0.044, output: 3.96 },
  // Anthropic
  'claude-opus-4-5': { input: 5, cached: 0.5, output: 25 },
  'claude-opus-4-6': { input: 5, cached: 0.5, output: 25 },
  'claude-opus-4': { input: 15, cached: 1.5, output: 75 },
  'claude-sonnet-4': { input: 3, cached: 0.3, output: 15 },
  'claude-haiku-4': { input: 1, cached: 0.1, output: 5 },
  // Новые поколения по умолчанию — по тарифу последних известных моделей.
  'claude-opus': { input: 5, cached: 0.5, output: 25 },
  'claude-sonnet': { input: 3, cached: 0.3, output: 15 },
  'claude-haiku': { input: 1, cached: 0.1, output: 5 },
  // Google
  'gemini-2.5-pro': { input: 1.25, cached: 0.31, output: 10 },
  'gemini-2.5-flash': { input: 0.3, cached: 0.075, output: 2.5 },
  // Демо
  mock: { input: 0, cached: 0, output: 0 },
};

function normalize(model: string): string {
  return model.toLowerCase().replace(/^.*\//, '').trim();
}

/** Цена для модели: точное имя или самый длинный префикс до «-» (gpt-5-mini-2025-08-07 → gpt-5-mini). */
export function priceFor(
  model: string,
  table: Record<string, ModelPrice>,
): ModelPrice | null {
  const name = normalize(model);
  if (table[name]) return table[name]!;
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    // Не путаем gpt-5 и gpt-5.6: после префикса должен идти «-», а не версия.
    if (name.startsWith(key) && /[-@:_]/.test(name[key.length] ?? ''))
      return table[key]!;
  }
  return null;
}

export function costUsd(
  price: ModelPrice | null,
  tokens: { inputTokens: number; outputTokens: number; cachedTokens: number },
): number | null {
  if (!price) return null;
  const cached = Math.min(tokens.cachedTokens, tokens.inputTokens);
  return (
    ((tokens.inputTokens - cached) * price.input +
      cached * price.cached +
      tokens.outputTokens * price.output) /
    1_000_000
  );
}

export function isPrice(value: unknown): value is ModelPrice {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return ['input', 'cached', 'output'].every(
    (key) =>
      typeof item[key] === 'number' &&
      Number.isFinite(item[key]) &&
      (item[key] as number) >= 0,
  );
}

/** Свои цены администратора поверх цен по умолчанию. */
export async function readPriceOverrides(
  store: Store,
): Promise<Record<string, ModelPrice>> {
  try {
    const raw = JSON.parse((await store.getSetting('model_prices')) ?? '{}');
    const out: Record<string, ModelPrice> = {};
    if (raw && typeof raw === 'object')
      for (const [key, value] of Object.entries(raw))
        if (isPrice(value)) out[normalize(key)] = value;
    return out;
  } catch {
    return {};
  }
}

export async function priceTable(
  store: Store,
): Promise<Record<string, ModelPrice>> {
  return { ...DEFAULT_PRICES, ...(await readPriceOverrides(store)) };
}
