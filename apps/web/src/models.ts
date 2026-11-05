import type { ProviderPublic } from '@mayak/shared';

/** Модели провайдера для выбора: без ключа и не отвечают — не показываем. */
export function visibleModels(provider: ProviderPublic): string[] {
  return provider.models.filter(
    (model) => !(provider.keyless && provider.caps?.[model]?.ok === false),
  );
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
