import type { ProviderPublic } from '@mayak/shared';

/**
 * Модели для выбора в чате и у агентов: только проверенные и отвечающие.
 * Нет ключа там, где он нужен, не проверена или не отвечает — не показываем.
 * Демо-модель (mock) работает без сети и показывается всегда.
 */
export function visibleModels(provider: ProviderPublic): string[] {
  if (provider.kind === 'mock') return provider.models;
  if (provider.needsKey && !provider.hasApiKey) return [];
  return provider.models.filter((model) => provider.caps?.[model]?.ok === true);
}

/** Сколько моделей провайдера попадёт в выбор (для подсказки в настройках). */
export function availableCount(provider: ProviderPublic): number {
  return visibleModels(provider).length;
}

/** Подпись модели в списке: умеет ли MCP-инструменты, отвечает ли. */
export function modelLabel(
  provider: ProviderPublic,
  model: string,
  t: (key: 'capTools' | 'capNoTools' | 'capDown') => string,
): string {
  const caps = provider.caps?.[model];
  if (!caps) return model;
  if (caps.ok === false) return `${model} · ${t('capDown')}`;
  if (caps.tools === true) return `${model} · ${t('capTools')}`;
  if (caps.tools === false) return `${model} · ${t('capNoTools')}`;
  return model;
}

/** «providerId:model» → части. Модели бывают с двоеточием (gpt-oss:20b, …:free). */
export function splitModelRef(value: string): [string, string] {
  const index = value.indexOf(':');
  if (index < 0) return [value, ''];
  return [value.slice(0, index), value.slice(index + 1)];
}
