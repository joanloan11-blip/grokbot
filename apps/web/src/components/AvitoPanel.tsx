import { useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';

interface Status {
  connected: boolean;
  clientId?: string;
  profileId?: string;
  name?: string;
  connectedAt?: string;
}

/**
 * Подключение своего кабинета Авито по ключам API.
 * Пользователь вводит Client_id, Client_secret и Profile_id — сервер проверяет
 * их запросом к Авито и хранит секрет зашифрованным.
 */
export function AvitoPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void api
      .avitoStatus()
      .then((next) => {
        setStatus(next);
        setClientId(next.clientId ?? '');
        setProfileId(next.profileId ?? '');
      })
      .catch(() => setStatus({ connected: false }));
  }, []);

  const ready =
    clientId.trim().length > 0 &&
    clientSecret.trim().length > 0 &&
    profileId.trim().length > 0;

  async function save() {
    setBusy(true);
    setError('');
    try {
      const saved = await api.saveAvito({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        profileId: profileId.trim(),
      });
      setStatus({ ...saved, connected: true });
      setClientSecret('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await api.deleteAvito();
      setStatus({ connected: false });
      setClientId('');
      setProfileId('');
      setClientSecret('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="panel card form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3>
        {t('avitoTitle')}{' '}
        <span className={status?.connected ? 'pill on' : 'pill'}>
          {status?.connected
            ? `${t('avitoConnected')}${status.name ? ` · ${status.name}` : ''}`
            : t('avitoOff')}
        </span>
      </h3>
      <p className="hint">{t('avitoLead')}</p>
      <label>
        Client_id
        <input
          autoComplete="off"
          value={clientId}
          placeholder="например, 1a2b3c4d5e6f"
          onChange={(event) => setClientId(event.target.value)}
        />
      </label>
      <label>
        Client_secret
        <input
          type="password"
          autoComplete="off"
          value={clientSecret}
          placeholder={status?.connected ? '••••••' : ''}
          onChange={(event) => setClientSecret(event.target.value)}
        />
      </label>
      <label>
        Profile_id
        <input
          autoComplete="off"
          value={profileId}
          placeholder="числовой id аккаунта Авито"
          onChange={(event) => setProfileId(event.target.value)}
        />
      </label>
      {error && <p className="fault">{error}</p>}
      <div className="row-actions">
        <button className="primary-btn" type="submit" disabled={busy || !ready}>
          {t('avitoSave')}
        </button>
        {status?.connected && (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            {t('avitoDisconnect')}
          </button>
        )}
      </div>
      <p className="hint">{t('avitoHowTo')}</p>
    </form>
  );
}
