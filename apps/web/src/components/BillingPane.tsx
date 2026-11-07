import { useEffect, useState } from 'react';
import type { BillingPlan, BillingSettings, BillingState } from '@mayak/shared';
import { api } from '../api';
import { IconMenu } from './icons';

/** Событие «открыть оплату» — из чата, когда пробные доллары закончились. */
export const OPEN_BILLING_EVENT = 'qastom:open-billing';

const rub = (value: number) =>
  `${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

const STATUS: Record<string, string> = {
  pending: 'ждёт оплаты',
  waiting_for_capture: 'подтверждается',
  succeeded: 'оплачен',
  canceled: 'отменён',
};

const KIND: Record<string, string> = {
  topup: 'Пополнение',
  plan: 'Тариф',
  renew: 'Продление',
  manual: 'Зачисление',
};

/** Раздел «Оплата» для пользователя: пробные $, тариф, баланс, пополнение. */
export function BillingPane({ onMenu }: { onMenu: () => void }) {
  const [state, setState] = useState<BillingState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState('');

  useEffect(() => {
    const returned = new URLSearchParams(window.location.search).has('billing');
    const load = returned ? api.billingRefresh() : api.billing();
    void load.then(setState, (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : 'Ошибка'),
    );
    if (returned)
      window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function pay(
    body:
      | { kind: 'topup'; amountRub: number }
      | { kind: 'plan'; planId: string },
  ) {
    setBusy(true);
    setError('');
    try {
      const { url } = await api.billingPay(body);
      window.location.href = url;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ошибка');
      setBusy(false);
    }
  }

  const trialLeft = state
    ? Math.max(0, state.trial.limitUsd - state.trial.usedUsd)
    : 0;
  const trialShare = state?.trial.limitUsd
    ? state.trial.usedUsd / state.trial.limitUsd
    : 0;

  return (
    <section className="settings billing">
      <header className="topbar">
        <button
          className="icon-btn menu-btn"
          type="button"
          onClick={onMenu}
          aria-label="Меню"
        >
          <IconMenu />
        </button>
        <h1>Оплата</h1>
      </header>
      <div className="settings-body">
        {error && <p className="error-line">{error}</p>}
        {!state ? (
          <p className="muted">Загружаю…</p>
        ) : !state.applies ? (
          <p className="muted">
            {state.enabled
              ? 'Для вашей учётной записи модели оплачивает компания — платить не нужно.'
              : 'Оплата пока не включена.'}
          </p>
        ) : (
          <>
            {state.blocked && (
              <p className="billing-alert">
                Пробные ${state.trial.limitUsd} закончились. Чтобы пользоваться
                платными моделями, пополните баланс или выберите тариф.
                Бесплатные модели работают как раньше.
              </p>
            )}
            <div className="billing-cards">
              <div className="billing-card">
                <span className="billing-label">Пробный период</span>
                <strong className="billing-value">
                  ${trialLeft.toFixed(2)}
                </strong>
                <span className="muted">
                  из ${state.trial.limitUsd} на модели OpenAI
                </span>
                <div className="meter-bar">
                  <span
                    style={{ width: `${Math.min(100, trialShare * 100)}%` }}
                  />
                </div>
              </div>
              <div className="billing-card">
                <span className="billing-label">Возможности</span>
                <strong className="billing-value">
                  {state.limits.source === 'admin'
                    ? 'без ограничений'
                    : state.limits.source === 'none'
                      ? 'нет доступа'
                      : state.plan
                        ? state.plan.name
                        : 'пробный период'}
                </strong>
                <span className="muted">
                  {state.limits.source === 'admin'
                    ? `агентов ${state.usage.agents} · коннекторов ${state.usage.connectors} · рутин ${state.usage.routines}`
                    : `агенты ${state.usage.agents}/${state.limits.agents} · коннекторы ${state.usage.connectors}/${state.limits.connectors} · рутины ${state.usage.routines}/${state.limits.routines}`}
                </span>
              </div>
              <div className="billing-card">
                <span className="billing-label">Тариф</span>
                {state.plan ? (
                  <>
                    <strong className="billing-value">{state.plan.name}</strong>
                    <span className="muted">
                      осталось {rub(state.plan.leftRub)} · до{' '}
                      {new Date(state.plan.until).toLocaleDateString('ru-RU')}
                    </span>
                    {state.canAutorenew && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={state.autorenew}
                          onChange={(event) =>
                            void api
                              .billingAutorenew(event.target.checked)
                              .then(setState)
                          }
                        />
                        Продлевать автоматически
                      </label>
                    )}
                  </>
                ) : (
                  <>
                    <strong className="billing-value">—</strong>
                    <span className="muted">не подключён</span>
                  </>
                )}
              </div>
              <div className="billing-card">
                <span className="billing-label">Баланс</span>
                <strong
                  className={
                    state.balanceRub < 0 ? 'billing-value bad' : 'billing-value'
                  }
                >
                  {rub(state.balanceRub)}
                </strong>
                <span className="muted">
                  $1 расходов модели = {rub(state.rubPerUsd)}
                </span>
              </div>
            </div>

            <h2>Тарифы</h2>
            <div className="billing-plans">
              {state.plans.map((plan: BillingPlan) => (
                <div
                  key={plan.id}
                  className={
                    state.plan?.id === plan.id
                      ? 'billing-plan current'
                      : 'billing-plan'
                  }
                >
                  <strong>{plan.name}</strong>
                  <span className="billing-price">{rub(plan.priceRub)}</span>
                  <span className="muted">
                    {plan.days} дн. · модели на {rub(plan.includedRub)}
                  </span>
                  {plan.description && (
                    <span className="muted">{plan.description}</span>
                  )}
                  <button
                    type="button"
                    className="primary-btn slim"
                    disabled={busy}
                    onClick={() => void pay({ kind: 'plan', planId: plan.id })}
                  >
                    {state.plan?.id === plan.id ? 'Продлить' : 'Подключить'}
                  </button>
                </div>
              ))}
            </div>

            <h2>Пополнить баланс</h2>
            <p className="muted">
              Баланс тратится, когда закончился лимит тарифа или тарифа нет.
            </p>
            <div className="billing-topups">
              {state.topups.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className="compare-chip"
                  disabled={busy}
                  onClick={() => void pay({ kind: 'topup', amountRub: amount })}
                >
                  {rub(amount)}
                </button>
              ))}
              <form
                className="billing-custom"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = Number(custom);
                  if (value >= 10)
                    void pay({ kind: 'topup', amountRub: value });
                }}
              >
                <input
                  type="number"
                  min={10}
                  placeholder="Своя сумма"
                  value={custom}
                  onChange={(event) => setCustom(event.target.value)}
                />
                <button
                  type="submit"
                  className="ghost slim"
                  disabled={busy || Number(custom) < 10}
                >
                  Оплатить
                </button>
              </form>
            </div>

            {state.payments.length > 0 && (
              <>
                <h2>Платежи</h2>
                <table className="billing-table">
                  <tbody>
                    {state.payments.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {new Date(item.createdAt).toLocaleString('ru-RU')}
                        </td>
                        <td>{KIND[item.kind] ?? item.kind}</td>
                        <td className="mono">{rub(item.amountRub)}</td>
                        <td className="muted">
                          {STATUS[item.status] ?? item.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <p className="muted small">
              Оплата через ЮKassa: банковские карты, СБП, SberPay, ЮMoney.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** Настройки оплаты для администратора (вкладка «Оплата» в настройках). */
export function BillingSettingsPanel() {
  const [form, setForm] = useState<BillingSettings | null>(null);
  const [secretKey, setSecretKey] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void api
      .billingSettings()
      .then(setForm, (reason: unknown) =>
        setMessage(reason instanceof Error ? reason.message : 'Ошибка'),
      );
  }, []);

  if (!form) return <p className="muted">{message || 'Загружаю…'}</p>;
  const set = <K extends keyof BillingSettings>(
    key: K,
    value: BillingSettings[K],
  ) => setForm({ ...form, [key]: value });
  const setPlan = (index: number, patch: Partial<BillingPlan>) =>
    set(
      'plans',
      form.plans.map((plan, i) => (i === index ? { ...plan, ...patch } : plan)),
    );

  return (
    <form
      className="panel billing-admin"
      onSubmit={(event) => {
        event.preventDefault();
        setMessage('');
        void api
          .saveBillingSettings({ ...form, ...(secretKey ? { secretKey } : {}) })
          .then((saved) => {
            setForm(saved);
            setSecretKey('');
            setMessage('Сохранено');
          })
          .catch((reason: unknown) =>
            setMessage(reason instanceof Error ? reason.message : 'Ошибка'),
          );
      }}
    >
      <h2>Оплата клиентов (ЮKassa)</h2>
      <p className="muted">
        Клиенты — те, кто зарегистрировался сам, без приглашения. Сотрудники и
        администратор не платят. Клиенту доступны только свои коннекторы, без
        склада и репозиториев компании.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => set('enabled', event.target.checked)}
        />
        Брать оплату с клиентов
      </label>
      <div className="grid-2">
        <label>
          shopId магазина
          <input
            value={form.shopId}
            onChange={(event) => set('shopId', event.target.value)}
          />
        </label>
        <label>
          Секретный ключ {form.hasSecret ? '(сохранён)' : ''}
          <input
            type="password"
            autoComplete="off"
            placeholder={
              form.hasSecret
                ? '•••••• — оставьте пустым, чтобы не менять'
                : 'live_…'
            }
            value={secretKey}
            onChange={(event) => setSecretKey(event.target.value)}
          />
        </label>
        <label>
          Курс, ₽ за $1
          <input
            type="number"
            step="0.01"
            value={form.usdRub}
            onChange={(event) => set('usdRub', Number(event.target.value))}
          />
        </label>
        <label>
          Наценка (×)
          <input
            type="number"
            step="0.1"
            value={form.markup}
            onChange={(event) => set('markup', Number(event.target.value))}
          />
        </label>
        <label>
          Пробный период, $
          <input
            type="number"
            step="0.5"
            value={form.trialUsd}
            onChange={(event) => set('trialUsd', Number(event.target.value))}
          />
        </label>
        <label>
          Пробные тратятся на (хосты через запятую)
          <input
            value={form.trialHosts.join(', ')}
            onChange={(event) =>
              set(
                'trialHosts',
                event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
            }
          />
        </label>
        <label>
          Суммы пополнения, ₽
          <input
            value={form.topups.join(', ')}
            onChange={(event) =>
              set(
                'topups',
                event.target.value
                  .split(',')
                  .map((item) => Number(item.trim()))
                  .filter((item) => item > 0),
              )
            }
          />
        </label>
      </div>
      <p className="muted">
        Клиент платит: расход модели в $ × курс × наценку. Сейчас $1 расходов ={' '}
        {(form.usdRub * form.markup).toFixed(2)} ₽.
      </p>
      <h3>Тарифы</h3>
      {form.plans.map((plan, index) => (
        <div key={plan.id} className="billing-plan-row">
          <input
            value={plan.name}
            aria-label="Название"
            onChange={(event) => setPlan(index, { name: event.target.value })}
          />
          <label>
            цена ₽
            <input
              type="number"
              value={plan.priceRub}
              onChange={(event) =>
                setPlan(index, { priceRub: Number(event.target.value) })
              }
            />
          </label>
          <label>
            включено ₽
            <input
              type="number"
              value={plan.includedRub}
              onChange={(event) =>
                setPlan(index, { includedRub: Number(event.target.value) })
              }
            />
          </label>
          <label>
            дней
            <input
              type="number"
              value={plan.days}
              onChange={(event) =>
                setPlan(index, { days: Number(event.target.value) })
              }
            />
          </label>
          <button
            type="button"
            className="ghost slim"
            onClick={() =>
              set(
                'plans',
                form.plans.filter((_, i) => i !== index),
              )
            }
          >
            Убрать
          </button>
        </div>
      ))}
      {form.plans.length < 6 && (
        <button
          type="button"
          className="ghost slim"
          onClick={() =>
            set('plans', [
              ...form.plans,
              {
                id: `plan-${Date.now().toString(36)}`,
                name: 'Новый тариф',
                priceRub: 1990,
                includedRub: 1800,
                days: 30,
              },
            ])
          }
        >
          + тариф
        </button>
      )}
      <h3>Чеки и автоплатежи</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={form.receipts}
          onChange={(event) => set('receipts', event.target.checked)}
        />
        Передавать чек (54-ФЗ) — если в ЮKassa подключены чеки
      </label>
      {form.receipts && (
        <label>
          Код НДС ЮKassa (1 — без НДС)
          <input
            type="number"
            min={1}
            max={12}
            value={form.vatCode}
            onChange={(event) => set('vatCode', Number(event.target.value))}
          />
        </label>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={form.recurring}
          onChange={(event) => set('recurring', event.target.checked)}
        />
        Автопродление тарифа по сохранённой карте (нужно разрешение ЮKassa на
        автоплатежи)
      </label>
      <p className="muted">
        Адрес для уведомлений (в личном кабинете ЮKassa → Интеграция →
        HTTP-уведомления, событие payment.succeeded):{' '}
        <code>{form.webhookUrl}</code>
      </p>
      <div className="row-actions">
        <button className="primary-btn" type="submit">
          Сохранить
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
    </form>
  );
}
