import { useCallback, useEffect, useState } from 'react';
import type { Agent, PublicUser, UsageRow } from '@mayak/shared';
import { api } from '../api';
import { useI18n } from '../i18n';
import { IconMenu } from './icons';

export function TeamPane({ onMenu }: { onMenu: () => void }) {
  const { t } = useI18n();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [limit, setLimit] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [nextUsers, nextAgents, nextUsage] = await Promise.all([
      api.team(),
      api.agents(),
      api.usage(),
    ]);
    setUsers(nextUsers);
    setAgents(nextAgents);
    setUsage(nextUsage);
  }, []);

  useEffect(() => {
    void load().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : t('error'));
    });
  }, [load, t]);

  const callsFor = (id: string) =>
    usage.find((row) => row.userId === id)?.calls ?? 0;

  const invite = async () => {
    setError('');
    const parsed = limit.trim() === '' ? null : Number(limit);
    try {
      const result = await api.inviteUser({
        email,
        name,
        dailyRequestLimit: parsed,
      });
      setToken(result.inviteToken);
      setEmail('');
      setName('');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error'));
    }
  };

  const save = async (
    user: PublicUser,
    patch: Parameters<typeof api.updateUser>[1],
  ) => {
    setError('');
    try {
      await api.updateUser(user.id, patch);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error'));
    }
  };

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
          <h1>{t('team')}</h1>
          <p className="muted">{t('teamLead')}</p>
        </div>
      </header>
      <div className="settings-body">
        <form
          className="form card"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <strong>{t('invite')}</strong>
          <label>
            {t('email')}
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            {t('name')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t('limit')}
            <input
              inputMode="numeric"
              value={limit}
              placeholder="∞"
              onChange={(event) => setLimit(event.target.value)}
            />
          </label>
          <button className="primary-btn" type="submit">
            {t('invite')}
          </button>
          {token && (
            <p>
              {t('copyToken')} <code>{token}</code>
            </p>
          )}
        </form>
        {error && <p className="fault">{error}</p>}
        <div className="team-list">
          {users.map((user) => (
            <article key={user.id} className="card">
              <header className="row-actions">
                <strong>
                  {user.name} · {user.email}
                </strong>
                <span className={user.status === 'active' ? 'pill on' : 'pill'}>
                  {user.role} · {user.status}
                </span>
                <span className="pill">
                  {t('usageToday')}: {callsFor(user.id)}
                  {user.dailyRequestLimit === null
                    ? ''
                    : ` / ${user.dailyRequestLimit}`}
                </span>
              </header>
              <div className="row-actions">
                {user.status !== 'active' && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void save(user, { status: 'active' })}
                  >
                    {t('approve')}
                  </button>
                )}
                {user.status !== 'disabled' && user.role !== 'admin' && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void save(user, { status: 'disabled' })}
                  >
                    {t('disable')}
                  </button>
                )}
                <label>
                  {t('limit')}
                  <input
                    defaultValue={user.dailyRequestLimit ?? ''}
                    placeholder="∞"
                    onBlur={(event) => {
                      const raw = event.target.value.trim();
                      const next = raw === '' ? null : Number(raw);
                      if (next === user.dailyRequestLimit) return;
                      void save(user, { dailyRequestLimit: next });
                    }}
                  />
                </label>
              </div>
              {user.role !== 'admin' && (
                <div className="row-actions">
                  {agents.map((agent) => {
                    const on = user.agentIds.includes(agent.id);
                    return (
                      <label key={agent.id} className="check">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const agentIds = on
                              ? user.agentIds.filter((id) => id !== agent.id)
                              : [...user.agentIds, agent.id];
                            void save(user, { agentIds });
                          }}
                        />
                        {agent.emoji} {agent.name}
                      </label>
                    );
                  })}
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
