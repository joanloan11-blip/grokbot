import { useCallback, useEffect, useState } from 'react';
import type { UsageMeter as Meter, UsageWindow } from '@mayak/shared';
import { api } from '../api';
import { useI18n } from '../i18n';
import { money, tokens } from './SpendPane';

/** Событие «расход изменился» — шлёт чат после ответа модели. */
export const USAGE_EVENT = 'qa-usage-changed';

function useMeter(): Meter | null {
  const [meter, setMeter] = useState<Meter | null>(null);
  const load = useCallback(() => {
    void api
      .usageMeter()
      .then(setMeter)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener(USAGE_EVENT, load);
    return () => {
      clearInterval(timer);
      window.removeEventListener(USAGE_EVENT, load);
    };
  }, [load]);
  return meter;
}

const level = (percent: number | null) =>
  percent === null
    ? 'none'
    : percent >= 90
      ? 'high'
      : percent >= 70
        ? 'mid'
        : 'low';

/** Кольцо: внешнее — неделя, внутреннее — день. */
function Ring({ meter }: { meter: Meter }) {
  const arc = (r: number, percent: number | null) => {
    const length = 2 * Math.PI * r;
    const share = Math.min(100, percent ?? 0) / 100;
    return { strokeDasharray: `${length * share} ${length}` };
  };
  return (
    <svg className="meter-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle className="track" cx="18" cy="18" r="15" />
      <circle
        className={`fill ${level(meter.week.percent)}`}
        cx="18"
        cy="18"
        r="15"
        style={arc(15, meter.week.percent)}
      />
      <circle className="track" cx="18" cy="18" r="10" />
      <circle
        className={`fill ${level(meter.day.percent)}`}
        cx="18"
        cy="18"
        r="10"
        style={arc(10, meter.day.percent)}
      />
    </svg>
  );
}

function Row({ label, item }: { label: string; item: UsageWindow }) {
  const { t, locale } = useI18n();
  const reset = new Date(item.resetsAt).toLocaleString(
    locale === 'en' ? 'en-GB' : 'ru-RU',
    {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    },
  );
  return (
    <div className="meter-row">
      <div className="meter-top">
        <strong>{label}</strong>
        <span>
          {item.percent === null
            ? money(item.usedUsd)
            : `${Math.round(item.percent)}%`}
        </span>
      </div>
      {item.percent !== null && (
        <span className={`meter-bar ${level(item.percent)}`}>
          <span style={{ width: `${Math.min(100, item.percent)}%` }} />
        </span>
      )}
      <small className="muted">
        {item.limitUsd === null
          ? t('meterNoLimit')
          : `${money(item.usedUsd)} ${t('meterOf')} $${item.limitUsd}`}
        {' · '}
        {tokens(item.tokens)} {t('meterTokens')} · {item.calls}{' '}
        {t('meterCalls')}
        <br />
        {t('meterResets')} {reset}
      </small>
    </div>
  );
}

function Details({ meter }: { meter: Meter }) {
  const { t } = useI18n();
  return (
    <div className="meter-pop" role="dialog" aria-label={t('meterTitle')}>
      <p className="meter-title">{t('meterTitle')}</p>
      <Row label={t('meterDay')} item={meter.day} />
      <Row label={t('meterWeek')} item={meter.week} />
    </div>
  );
}

/** Кнопка с кольцом для панели иконок слева. */
export function RailMeter() {
  const meter = useMeter();
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  if (!meter) return null;
  const label =
    meter.week.percent === null
      ? `${t('meterWeek')}: ${money(meter.week.usedUsd)}`
      : `${t('meterWeek')}: ${Math.round(meter.week.percent)}%`;
  return (
    <div className="rail-meter">
      <button
        type="button"
        className="rail-btn meter-btn"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Ring meter={meter} />
        {meter.week.percent !== null && (
          <span className="meter-num">{Math.round(meter.week.percent)}</span>
        )}
      </button>
      {open && (
        <>
          <button
            type="button"
            className="menu-scrim"
            aria-label={t('close')}
            onClick={() => setOpen(false)}
          />
          <Details meter={meter} />
        </>
      )}
    </div>
  );
}

/** Компактная строка для боковой панели (на телефоне, где нет панели иконок). */
export function InlineMeter() {
  const meter = useMeter();
  const { t } = useI18n();
  if (!meter) return null;
  const part = (label: string, item: UsageWindow) =>
    `${label} ${item.percent === null ? money(item.usedUsd) : `${Math.round(item.percent)}%`}`;
  return (
    <details className="inline-meter">
      <summary>
        <Ring meter={meter} />
        <span>
          {part(t('meterDay'), meter.day)} · {part(t('meterWeek'), meter.week)}
        </span>
      </summary>
      <Details meter={meter} />
    </details>
  );
}
