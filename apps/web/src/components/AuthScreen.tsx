import { useState } from 'react';
import type { PublicUser } from '@mayak/shared';
import { api } from '../api';
import { useI18n } from '../i18n';
import { BeaconMark } from './icons';

type Mode = 'login' | 'register' | 'invite';

export function AuthScreen({ onUser }: { onUser: (user: PublicUser) => void }) {
  const { t, locale, setLocale } = useI18n();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError('');
    setPending(false);
    try {
      if (mode === 'login') {
        const result = await api.login({ email, password });
        onUser(result.user);
      } else if (mode === 'register') {
        const result = await api.register({ email, password, name });
        if (result.pending) setPending(true);
        else onUser(result.user);
      } else {
        const result = await api.acceptInvite({ token, password, name });
        onUser(result.user);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form
        className="auth-card form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="brand">
          <BeaconMark />
          <div>
            <strong>{t('brand')}</strong>
            <small>{t('authLead')}</small>
          </div>
        </div>
        <div className="row-actions">
          {(['login', 'register', 'invite'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={mode === item ? 'ghost active' : 'ghost'}
              onClick={() => {
                setMode(item);
                setError('');
                setPending(false);
              }}
            >
              {t(
                item === 'login'
                  ? 'login'
                  : item === 'register'
                    ? 'register'
                    : 'acceptInvite',
              )}
            </button>
          ))}
        </div>
        {mode !== 'invite' && (
          <label>
            {t('email')}
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
        )}
        {mode === 'invite' && (
          <label>
            {t('inviteToken')}
            <input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              required
            />
          </label>
        )}
        {mode !== 'login' && (
          <label>
            {t('name')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        <label>
          {t('password')}
          <input
            type="password"
            autoComplete={
              mode === 'login' ? 'current-password' : 'new-password'
            }
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={8}
            required
          />
        </label>
        {pending && <p className="muted">{t('authPending')}</p>}
        {error && <p className="fault">{error}</p>}
        <button className="primary-btn" type="submit" disabled={busy}>
          {t(
            mode === 'login'
              ? 'login'
              : mode === 'register'
                ? 'register'
                : 'acceptInvite',
          )}
        </button>
        <button
          className="lang"
          type="button"
          onClick={() => setLocale(locale === 'ru' ? 'en' : 'ru')}
        >
          {locale === 'ru' ? 'EN' : 'RU'}
        </button>
      </form>
    </div>
  );
}
