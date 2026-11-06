import type { UsageMeter, UsageWindow } from '@mayak/shared';
import type { Store } from './db';
import { HttpError } from './errors';
import { buildSpendReport } from './spend';

/**
 * Лимиты расхода в долларах на пользователя: за день и за неделю (как в Codex).
 * Время — местное время сервера (TZ, у нас Екатеринбург): день с 00:00, неделя с понедельника.
 */
export function dayStart(now = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

export function weekStart(now = new Date()): Date {
  const start = dayStart(now);
  const shift = (start.getDay() + 6) % 7; // понедельник = 0
  start.setDate(start.getDate() - shift);
  return start;
}

function parseBudget(raw: string | undefined): number | null {
  const value = Number(raw);
  return raw && Number.isFinite(value) && value > 0 ? value : null;
}

/** Лимит пользователя, иначе общий по умолчанию, иначе без лимита. */
export async function readBudgets(
  store: Store,
  userId: string,
): Promise<{ day: number | null; week: number | null }> {
  const [day, week, dayDefault, weekDefault] = await Promise.all([
    store.getSetting(`budget_day:${userId}`),
    store.getSetting(`budget_week:${userId}`),
    store.getSetting('budget_day_default'),
    store.getSetting('budget_week_default'),
  ]);
  return {
    day: parseBudget(day) ?? parseBudget(dayDefault),
    week: parseBudget(week) ?? parseBudget(weekDefault),
  };
}

export async function saveBudgets(
  store: Store,
  key: string,
  budgets: { day?: number | null; week?: number | null },
): Promise<void> {
  for (const [name, value] of Object.entries(budgets)) {
    if (value === undefined) continue;
    await store.setSetting(
      `budget_${name}${key ? `:${key}` : '_default'}`,
      value && value > 0 ? String(value) : '',
    );
  }
}

async function windowFor(
  store: Store,
  userId: string,
  since: Date,
  resetsAt: Date,
  limitUsd: number | null,
): Promise<UsageWindow> {
  const report = await buildSpendReport(store, {
    period: 'week',
    userId,
    since,
  });
  const usedUsd = report.total.costUsd ?? 0;
  return {
    usedUsd: Math.round(usedUsd * 10_000) / 10_000,
    tokens: report.total.inputTokens + report.total.outputTokens,
    calls: report.total.calls,
    limitUsd,
    percent:
      limitUsd === null
        ? null
        : Math.round(Math.min(999, (usedUsd / limitUsd) * 100) * 10) / 10,
    resetsAt: resetsAt.toISOString(),
  };
}

export async function usageMeter(
  store: Store,
  userId: string,
  now = new Date(),
): Promise<UsageMeter> {
  const budgets = await readBudgets(store, userId);
  const today = dayStart(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const monday = weekStart(now);
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  const [day, week] = await Promise.all([
    windowFor(store, userId, today, tomorrow, budgets.day),
    windowFor(store, userId, monday, nextMonday, budgets.week),
  ]);
  return { day, week };
}

/** Перед запросом к модели: лимит в долларах исчерпан — не пускаем. */
export async function assertBudget(
  store: Store,
  userId: string,
): Promise<void> {
  const budgets = await readBudgets(store, userId);
  if (budgets.day === null && budgets.week === null) return;
  const meter = await usageMeter(store, userId);
  const time = (iso: string) =>
    new Date(iso).toLocaleString('ru-RU', {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  if (meter.week.percent !== null && meter.week.percent >= 100)
    throw new HttpError(
      429,
      `Недельный лимит расходов исчерпан ($${meter.week.limitUsd}). Сбросится ${time(meter.week.resetsAt)}.`,
    );
  if (meter.day.percent !== null && meter.day.percent >= 100)
    throw new HttpError(
      429,
      `Дневной лимит расходов исчерпан ($${meter.day.limitUsd}). Сбросится ${time(meter.day.resetsAt)}.`,
    );
}
