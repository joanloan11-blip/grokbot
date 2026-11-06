import { useState } from 'react';
import type { PublicUser } from '@mayak/shared';
import { api } from '../api';
import { useI18n } from '../i18n';
import { BeaconMark } from './icons';

type Mode = 'login' | 'register' | 'invite' | 'forgot' | 'reset';

function resetTokenFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('reset') ?? '';
  } catch {
    return '';
  }
}

function clearResetFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('reset');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
}

export function AuthScreen({
  onUser,
  initialMode = 'login',
  onBack,
}: {
  onUser: (user: PublicUser) => void;
  initialMode?: 'login' | 'register';
  /** Вернуться на главную страницу с описанием. */
  onBack?: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const initialReset = resetTokenFromUrl();
  const [mode, setMode] = useState<Mode>(initialReset ? 'reset' : initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [resetToken] = useState(initialReset);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setNotice('');
    setPending(false);
    setPassword('');
    setRepeat('');
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    setPending(false);
    try {
      if (mode === 'login') {
        const result = await api.login({ email, password });
        onUser(result.user);
      } else if (mode === 'register') {
        const result = await api.register({ email, password, name });
        if (result.pending) setPending(true);
        else onUser(result.user);
      } else if (mode === 'invite') {
        const result = await api.acceptInvite({ token, password, name });
        onUser(result.user);
      } else if (mode === 'forgot') {
        const result = await api.forgotPassword({ email, locale });
        setNotice(result.mail ? t('forgotSent') : t('forgotNoMail'));
      } else {
        if (password !== repeat) {
          setError(t('passwordsDiffer'));
          return;
        }
        const result = await api.resetPassword({ token: resetToken, password });
        clearResetFromUrl();
        if (result.user) {
          onUser(result.user);
        } else {
          switchMode('login');
          setNotice(t('resetDone'));
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error'));
    } finally {
      setBusy(false);
    }
  };

  const recovering = mode === 'forgot' || mode === 'reset';
  const submitLabel =
    mode === 'login'
      ? t('login')
      : mode === 'register'
        ? t('register')
        : mode === 'invite'
          ? t('acceptInvite')
          : mode === 'forgot'
            ? t('forgotSend')
            : t('resetSave');

  return (
    <div className="auth-wrap">
      {onBack && (
        <button type="button" className="auth-back" onClick={onBack}>
          ← На главную
        </button>
      )}
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
            <strong>
              {recovering
                ? t(mode === 'forgot' ? 'forgotTitle' : 'resetTitle')
                : t('brand')}
            </strong>
            <small>
              {recovering
                ? t(mode === 'forgot' ? 'forgotLead' : 'resetLead')
                : t('authLead')}
            </small>
          </div>
        </div>
        {!recovering && (
          <div className="row-actions">
            {(['login', 'register', 'invite'] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={mode === item ? 'ghost active' : 'ghost'}
                onClick={() => switchMode(item)}
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
        )}
        {(mode === 'login' || mode === 'register' || mode === 'forgot') && (
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
        {(mode === 'register' || mode === 'invite') && (
          <label>
            {t('name')}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        {mode !== 'forgot' && (
          <label>
            {mode === 'reset' ? t('newPassword') : t('password')}
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
        )}
        {mode === 'reset' && (
          <label>
            {t('repeatPassword')}
            <input
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
              minLength={8}
              required
            />
          </label>
        )}
        {pending && <p className="muted">{t('authPending')}</p>}
        {notice && <p className="muted">{notice}</p>}
        {error && <p className="fault">{error}</p>}
        <button className="primary-btn" type="submit" disabled={busy}>
          {submitLabel}
        </button>
        {mode === 'login' && (
          <button
            type="button"
            className="link-btn"
            onClick={() => switchMode('forgot')}
          >
            {t('forgotPassword')}
          </button>
        )}
        {recovering && (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              clearResetFromUrl();
              switchMode('login');
            }}
          >
            {t('backToLogin')}
          </button>
        )}
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
