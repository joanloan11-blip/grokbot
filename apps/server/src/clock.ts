import type { Locale } from '@mayak/shared';
import type { ModelMessage } from './providers/types';

/**
 * Модели не знают, какое сейчас число: у них только дата обучения.
 * Дату (без времени) кладём в системный промпт — он не меняется в течение дня и не ломает кэш,
 * точное время — в начало последнего сообщения пользователя (только для модели, в чат не сохраняется).
 */
export function timeZone(): string {
  return process.env.TZ || 'Europe/Moscow';
}

function parts(now: Date, locale: Locale, zone: string) {
  const lang = locale === 'en' ? 'en-GB' : 'ru-RU';
  const date = new Intl.DateTimeFormat(lang, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: zone,
  }).format(now);
  const time = new Intl.DateTimeFormat(lang, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone,
    hour12: false,
  }).format(now);
  const offset =
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    })
      .formatToParts(now)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  return { date, time, offset: offset.replace('GMT', 'UTC') };
}

export function dateLine(
  locale: Locale,
  now = new Date(),
  zone = timeZone(),
): string {
  const { date, offset } = parts(now, locale, zone);
  return locale === 'en'
    ? `Today is ${date} (time zone ${zone}, ${offset}). The exact current time is given in square brackets at the start of the latest user message. Rely on this date, not on your training data; for recent events use search.`
    : `Сегодня ${date} (часовой пояс ${zone}, ${offset}). Точное текущее время — в квадратных скобках в начале последнего сообщения пользователя. Опирайся на эту дату, а не на свои знания из обучения; для свежих событий используй поиск.`;
}

export function withClock(
  messages: ModelMessage[],
  locale: Locale,
  now = new Date(),
  zone = timeZone(),
): ModelMessage[] {
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]!.role === 'user') {
      index = i;
      break;
    }
  if (index < 0) return messages;
  const { date, time } = parts(now, locale, zone);
  const stamp =
    locale === 'en' ? `[Now: ${date}, ${time}]` : `[Сейчас: ${date}, ${time}]`;
  const copy = [...messages];
  copy[index] = {
    ...copy[index]!,
    content: `${stamp}\n${copy[index]!.content}`,
  };
  return copy;
}
