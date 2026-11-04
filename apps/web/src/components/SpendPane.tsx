import { useCallback, useEffect, useState } from 'react';
import type {
  KeyBalance,
  ModelPrice,
  SpendLine,
  SpendReport,
} from '@mayak/shared';
import { api } from '../api';
import { useI18n } from '../i18n';
import { IconMenu } from './icons';

type Period = SpendReport['period'];
type Scope = SpendReport['scope'];

export function money(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 10) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}K`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function Cost({ line }: { line: SpendLine }) {
  const { t } = useI18n();
  return (
    <span className="spend-cost">
      {line.costUsd === null ? (
        <span className="muted">{t('spendNoPrice')}</span>
      ) : (
        money(line.costUsd)
      )}
      {line.costUsd !== null && line.unpricedCalls > 0 && (
        <small className="warn" title={t('spendNoPrice')}>
          +?
        </small>
      )}
    </span>
  );
}

function Numbers({ line }: { line: SpendLine }) {
  const { t } = useI18n();
  return (
    <span className="spend-nums muted">
      {line.calls} · {t('spendIn')} {tokens(line.inputTokens)}
      {line.cachedTokens > 0 &&
        ` (${tokens(line.cachedTokens)} ${t('spendCached')})`}{' '}
      · {t('spendOut')} {tokens(line.outputTokens)}
      {line.calls > 0 && line.exactShare < 1 && (
        <span className="warn" title={t('spendEstimated')}>
          {' '}
          ≈
        </span>
      )}
    </span>
  );
}

function Bar({ value, max }: { value: number | null; max: number }) {
  const share = max > 0 && value ? Math.max(2, (value / max) * 100) : 0;
  return (
    <span className="spend-bar" aria-hidden>
      <span style={{ width: `${share}%` }} />
    </span>
  );
}

export function SpendPane({
  onMenu,
  isAdmin,
}: {
  onMenu: () => void;
  isAdmin: boolean;
}) {
  const { t } = useI18n();
  const [period, setPeriod] = useState<Period>('day');
  const [scope, setScope] = useState<Scope>(isAdmin ? 'all' : 'mine');
  const [report, setReport] = useState<SpendReport | null>(null);
  const [balances, setBalances] = useState<KeyBalance[]>([]);
  const [prices, setPrices] = useState<{
    defaults: Record<string, ModelPrice>;
    overrides: Record<string, ModelPrice>;
  } | null>(null);
  const [editing, setEditing] = useState<{
    model: string;
    input: string;
    cached: string;
    output: string;
  } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setReport(await api.spend(period, scope));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error'));
    }
  }, [period, scope, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isAdmin) return;
    void api
      .balances()
      .then(setBalances)
      .catch(() => undefined);
    void api
      .prices()
      .then(setPrices)
      .catch(() => undefined);
  }, [isAdmin]);

  const savePrice = async () => {
    if (!editing || !prices) return;
    const next = {
      input: Number(editing.input.replace(',', '.')),
      cached: Number(editing.cached.replace(',', '.')),
      output: Number(editing.output.replace(',', '.')),
    };
    if (![next.input, next.cached, next.output].every((n) => n >= 0)) {
      setError(t('error'));
      return;
    }
    try {
      setPrices(
        await api.savePrices({
          ...prices.overrides,
          [editing.model.toLowerCase()]: next,
        }),
      );
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error'));
    }
  };

  const resetPrice = async (model: string) => {
    if (!prices) return;
    const { [model.toLowerCase()]: _drop, ...rest } = prices.overrides;
    setPrices(await api.savePrices(rest));
    setEditing(null);
    await load();
  };

  const maxAgent = Math.max(
    0,
    ...(report?.agents ?? []).map((row) => row.costUsd ?? 0),
  );
  const maxUser = Math.max(
    0,
    ...(report?.users ?? []).map((row) => row.costUsd ?? 0),
  );
  const showAll = isAdmin && scope === 'all';

  return (
    <section className="settings">
      <header className="topbar">
        <button
          className="icon-btn menu-btn"
          type="button"
          onClick={onMenu}
          aria-label={t('menu')}
        >
          <IconMenu />
        </button>
        <div>
          <h1>{t('spend')}</h1>
          <p className="muted">{t('spendLead')}</p>
        </div>
      </header>
      <div className="settings-body spend">
        <div className="spend-controls">
          <div className="tabs">
            {(
              [
                ['day', t('spendDay')],
                ['week', t('spendWeek')],
                ['month', t('spendMonth')],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={period === value ? 'active' : ''}
                onClick={() => setPeriod(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {isAdmin && (
            <div className="tabs">
              {(
                [
                  ['all', t('spendAll')],
                  ['mine', t('spendMine')],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={scope === value ? 'active' : ''}
                  onClick={() => setScope(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {error && <p className="error">{error}</p>}

        {report && (
          <div className="spend-total card">
            <div>
              <span className="muted">{t('spendTotal')}</span>
              <strong>
                <Cost line={report.total} />
              </strong>
            </div>
            <div>
              <span className="muted">{t('spendCalls')}</span>
              <strong>{report.total.calls}</strong>
            </div>
            <div>
              <span className="muted">{t('spendIn')}</span>
              <strong>{tokens(report.total.inputTokens)}</strong>
            </div>
            <div>
              <span className="muted">{t('spendOut')}</span>
              <strong>{tokens(report.total.outputTokens)}</strong>
            </div>
          </div>
        )}

        {report &&
          (report.total.unpricedCalls > 0 || report.total.exactShare < 1) &&
          report.total.calls > 0 && (
            <p className="spend-legend muted">
              {report.total.unpricedCalls > 0 && (
                <>
                  <span className="warn">+?</span> {t('spendLegendPrice')}{' '}
                </>
              )}
              {report.total.exactShare < 1 && (
                <>
                  <span className="warn">≈</span> {t('spendEstimated')}.
                </>
              )}
            </p>
          )}

        {report && report.total.calls === 0 && (
          <p className="muted">{t('spendNoData')}</p>
        )}

        {report && report.agents.length > 0 && (
          <>
            <h2 className="spend-h">{t('spendByAgent')}</h2>
            <ul className="stack">
              {report.agents.map((agent) => (
                <li key={agent.agentId ?? 'none'} className="card spend-row">
                  <details>
                    <summary>
                      <span className="spend-name">
                        <span className="spend-emoji">{agent.emoji}</span>
                        {agent.name}
                      </span>
                      <Bar value={agent.costUsd} max={maxAgent} />
                      <Cost line={agent} />
                      <Numbers line={agent} />
                    </summary>
                    <div className="spend-sub">
                      {showAll && (
                        <table>
                          <tbody>
                            {agent.users.map((user) => (
                              <tr key={user.userId}>
                                <td>
                                  {user.name}
                                  {user.email && user.email !== user.name && (
                                    <small className="muted">
                                      {' '}
                                      {user.email}
                                    </small>
                                  )}
                                </td>
                                <td>
                                  <Numbers line={user} />
                                </td>
                                <td className="num">
                                  <Cost line={user} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      <table>
                        <tbody>
                          {agent.models.map((model) => (
                            <tr
                              key={`${model.provider}|${model.model}|${model.kind}`}
                            >
                              <td>
                                <code>{model.model}</code>
                                <small className="muted">
                                  {' '}
                                  {model.provider}
                                  {model.kind === 'image' &&
                                    ` · ${t('spendImages')}`}
                                </small>
                              </td>
                              <td>
                                <Numbers line={model} />
                              </td>
                              <td className="num">
                                <Cost line={model} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </>
        )}

        {showAll && report && report.users.length > 0 && (
          <>
            <h2 className="spend-h">{t('spendByUser')}</h2>
            <ul className="stack">
              {report.users.map((user) => (
                <li key={user.userId} className="card spend-flat">
                  <span className="spend-name">
                    {user.name}
                    {user.email && user.email !== user.name && (
                      <small className="muted"> {user.email}</small>
                    )}
                  </span>
                  <Bar value={user.costUsd} max={maxUser} />
                  <Cost line={user} />
                  <Numbers line={user} />
                </li>
              ))}
            </ul>
          </>
        )}

        {isAdmin &&
          report &&
          (report.keys.length > 0 || balances.length > 0) && (
            <>
              <h2 className="spend-h">{t('spendByKey')}</h2>
              <ul className="stack">
                {mergeKeys(report, balances).map(({ key, balance }) => (
                  <li
                    key={key?.providerId ?? balance?.providerId}
                    className="card"
                  >
                    <div className="card-top">
                      <strong>{key?.name ?? balance?.name}</strong>
                      {key && <Cost line={key} />}
                    </div>
                    {balance && (
                      <p className="spend-balance">
                        {balance.supported ? (
                          <>
                            {t('spendBalance')}:{' '}
                            <strong>
                              {balance.balance !== undefined
                                ? `${balance.balance.toFixed(2)} ${balance.currency ?? ''}`
                                : '—'}
                            </strong>
                            {balance.used !== undefined && (
                              <span className="muted">
                                {' '}
                                · {t('spendProviderUsed')}: $
                                {balance.used.toFixed(2)}
                                {balance.limit ? ` / $${balance.limit}` : ''}
                              </span>
                            )}
                            {balance.note && (
                              <span className="warn"> · {balance.note}</span>
                            )}
                          </>
                        ) : (
                          <span className="muted">{balance.note}</span>
                        )}
                      </p>
                    )}
                    {key && key.models.length > 0 && (
                      <table className="spend-prices">
                        <thead>
                          <tr>
                            <th />
                            <th />
                            <th>{t('spendPrice')}</th>
                            <th className="num">$</th>
                          </tr>
                        </thead>
                        <tbody>
                          {key.models.map((model) => {
                            const custom = Boolean(
                              prices?.overrides[model.model.toLowerCase()],
                            );
                            const open =
                              editing?.model.toLowerCase() ===
                              model.model.toLowerCase();
                            return (
                              <tr key={`${model.model}|${model.kind}`}>
                                <td>
                                  <code>{model.model}</code>
                                  {model.kind === 'image' && (
                                    <small className="muted">
                                      {' '}
                                      {t('spendImages')}
                                    </small>
                                  )}
                                </td>
                                <td>
                                  <Numbers line={model} />
                                </td>
                                <td>
                                  {open && editing ? (
                                    <form
                                      className="price-edit"
                                      onSubmit={(event) => {
                                        event.preventDefault();
                                        void savePrice();
                                      }}
                                    >
                                      {(
                                        ['input', 'cached', 'output'] as const
                                      ).map((field) => (
                                        <input
                                          key={field}
                                          inputMode="decimal"
                                          aria-label={field}
                                          value={editing[field]}
                                          onChange={(event) =>
                                            setEditing({
                                              ...editing,
                                              [field]: event.target.value,
                                            })
                                          }
                                        />
                                      ))}
                                      <button className="chip on" type="submit">
                                        OK
                                      </button>
                                      {custom && (
                                        <button
                                          className="chip"
                                          type="button"
                                          onClick={() =>
                                            void resetPrice(model.model)
                                          }
                                        >
                                          {t('spendResetPrice')}
                                        </button>
                                      )}
                                    </form>
                                  ) : (
                                    <button
                                      type="button"
                                      className={
                                        model.price ? 'chip' : 'chip bad-price'
                                      }
                                      title={t('spendEditPrice')}
                                      onClick={() =>
                                        setEditing({
                                          model: model.model,
                                          input: String(
                                            model.price?.input ?? '',
                                          ),
                                          cached: String(
                                            model.price?.cached ?? '',
                                          ),
                                          output: String(
                                            model.price?.output ?? '',
                                          ),
                                        })
                                      }
                                    >
                                      {model.price
                                        ? model.price.input === 0 &&
                                          model.price.output === 0
                                          ? t('spendFree')
                                          : `${model.price.input} / ${model.price.cached} / ${model.price.output}`
                                        : t('spendNoPrice')}
                                      {custom && ` · ${t('spendCustom')}`}
                                    </button>
                                  )}
                                </td>
                                <td className="num">
                                  <Cost line={model} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
      </div>
    </section>
  );
}

function mergeKeys(report: SpendReport, balances: KeyBalance[]) {
  const out: {
    key?: SpendReport['keys'][number];
    balance?: KeyBalance;
  }[] = report.keys.map((key) => ({
    key,
    balance: balances.find((item) => item.providerId === key.providerId),
  }));
  for (const balance of balances)
    if (!report.keys.some((key) => key.providerId === balance.providerId))
      out.push({ balance });
  return out;
}
