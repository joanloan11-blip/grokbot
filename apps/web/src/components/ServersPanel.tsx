import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';

interface Host {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
}

/**
 * Серверы, на которых агент может работать по SSH. Только администратор:
 * приватный ключ шифруется на сервере и в браузер не возвращается.
 */
export function ServersPanel() {
  const { t } = useI18n();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('root');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [probe, setProbe] = useState('');

  const refresh = useCallback(async () => {
    try {
      const data = await api.servers();
      setHosts(data.hosts);
    } catch {
      setHosts([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add() {
    setBusy(true);
    setError('');
    setProbe('');
    try {
      const saved = await api.addServer({
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || 22,
        user: user.trim(),
        privateKey,
      });
      setProbe(saved.probe);
      setName('');
      setHost('');
      setPrivateKey('');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  async function check(id: string) {
    setBusy(true);
    setError('');
    try {
      const result = await api.testServer(id);
      setProbe(result.probe);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api.deleteServer(id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="panel card">
        <h3>{t('serversTitle')}</h3>
        <p className="hint">{t('serversLead')}</p>
        {hosts.length === 0 ? (
          <p className="muted">{t('serversEmpty')}</p>
        ) : (
          <ul className="plain-list">
            {hosts.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>{' '}
                <span className="muted">
                  {item.user}@{item.host}:{item.port}
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void check(item.id)}
                  >
                    {t('serversTest')}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void remove(item.id)}
                  >
                    {t('serversDelete')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {probe && <pre className="probe">{probe}</pre>}
        {error && <p className="fault">{error}</p>}
      </div>

      <form
        className="panel card form"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <h3>{t('serversAdd')}</h3>
        <label>
          {t('serversName')}
          <input
            value={name}
            placeholder="qastom"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {t('serversHost')}
          <input
            value={host}
            placeholder="217.197.114.108"
            onChange={(event) => setHost(event.target.value)}
          />
        </label>
        <label>
          {t('serversPort')}
          <input
            value={port}
            inputMode="numeric"
            onChange={(event) => setPort(event.target.value)}
          />
        </label>
        <label>
          {t('serversUser')}
          <input
            value={user}
            placeholder="root"
            onChange={(event) => setUser(event.target.value)}
          />
        </label>
        <label>
          {t('serversKey')}
          <textarea
            rows={6}
            value={privateKey}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            onChange={(event) => setPrivateKey(event.target.value)}
          />
        </label>
        <div className="row-actions">
          <button
            className="primary-btn"
            type="submit"
            disabled={busy || !host.trim() || !user.trim() || !privateKey.trim()}
          >
            {t('serversConnect')}
          </button>
        </div>
        <p className="hint">{t('serversNote')}</p>
      </form>
    </div>
  );
}
