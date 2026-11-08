import { useEffect, useState } from 'react';
import type { TelegramBotState } from '@mayak/shared';
import { api } from '../api';

/** Состояние «не подключено»: при сбросе и при сетевой ошибке загрузки. */
const EMPTY_STATE: TelegramBotState = {
  connected: false,
  username: '',
  tgUserId: '',
  agentId: null,
  agentName: '',
};

/**
 * Подключение личного Telegram-бота агента «Джарвис».
 * Токен и числовой Telegram ID владельца; токен шифруется на сервере.
 * Сообщения и проверки отправляются только по кнопке.
 */
export function TelegramPane() {
  const [state, setState] = useState<TelegramBotState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [token, setToken] = useState('');
  const [tgUserId, setTgUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    void api
      .telegramStatus()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setState(EMPTY_STATE);
        setLoadError(
          reason instanceof Error
            ? reason.message
            : 'Не удалось загрузить настройки Telegram.',
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const ready = token.trim().length > 0 && /^\d+$/.test(tgUserId.trim());

  async function connect() {
    if (!ready) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const saved = await api.saveTelegram({
        token: token.trim(),
        tgUserId: tgUserId.trim(),
      });
      setState(saved);
      setToken('');
      setNote(
        'Бот подключён. Откройте своего бота в Telegram и отправьте /start.',
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Не удалось подключить бота. Проверьте токен и Telegram ID.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const result = await api.testTelegram();
      if (result.ok) {
        setNote('Проверка отправлена — сообщение придёт в Telegram.');
      } else {
        setError(result.error || 'Не удалось отправить тестовое сообщение.');
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Не удалось отправить тестовое сообщение.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await api.deleteTelegram();
      setState(EMPTY_STATE);
      setToken('');
      setTgUserId('');
      setNote('Бот отключён.');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Не удалось отключить бота.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="panel card">
        <p className="muted">Загружаю настройки Telegram…</p>
      </div>
    );
  }

  return (
    <div className="panel card">
      <h3>
        Telegram{' '}
        <span className={state?.connected ? 'pill on' : 'pill'}>
          {state?.connected
            ? `Подключено · @${state.username}`
            : 'Не подключено'}
        </span>
      </h3>
      <p className="hint">
        Личный бот агента «Джарвис»: пишите ему текстом или голосом, а ответы
        будут видны в приложении в чате «Telegram: Джарвис».
      </p>
      {loadError && <p className="fault">{loadError}</p>}
      {state?.connected ? (
        <>
          <p>
            Агент: <strong>{state.agentName || 'Джарвис'}</strong>
          </p>
          <p>
            Владелец:{' '}
            <span className="muted">
              @{state.username} · ID {state.tgUserId}
            </span>
          </p>
          {error && <p className="fault">{error}</p>}
          {note && <p className="hint">{note}</p>}
          <div className="row-actions">
            <button
              type="button"
              className="primary-btn"
              disabled={busy}
              onClick={() => void test()}
            >
              Отправить тестовое сообщение
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Отключить
            </button>
          </div>
          <p className="hint">
            Памятка: пишите боту обычным текстом или голосовым — голосовые
            распознаются автоматически. /new — новый чат, /help — помощь.
          </p>
        </>
      ) : (
        <>
          <p className="muted">Как подключить своего бота — четыре шага:</p>
          <ol>
            <li>
              Откройте <strong>@BotFather</strong> в Telegram, отправьте{' '}
              <code>/newbot</code>, придумайте имя и username (username должен
              заканчиваться на <code>bot</code>). В ответ придёт токен вида{' '}
              <code>123456789:AA...</code> — скопируйте его.
            </li>
            <li>
              Узнайте свой числовой Telegram ID: напишите{' '}
              <strong>@userinfobot</strong> или <strong>@getmyid_bot</strong> —
              бот ответит числом (например, <code>123456789</code>).
            </li>
            <li>
              Вставьте токен и ID в поля ниже и нажмите «Проверить и сохранить».
            </li>
            <li>
              Откройте своего бота в Telegram и отправьте ему{' '}
              <code>/start</code> — после этого можно писать текстом и голосом.
            </li>
          </ol>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <label>
              Токен бота
              <input
                type="password"
                autoComplete="off"
                value={token}
                placeholder="123456789:AA..."
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <label>
              Ваш Telegram ID (число)
              <input
                inputMode="numeric"
                autoComplete="off"
                value={tgUserId}
                placeholder="например, 123456789"
                onChange={(event) =>
                  setTgUserId(event.target.value.replace(/\D/g, ''))
                }
              />
            </label>
            <div className="row-actions">
              <button
                className="primary-btn"
                type="submit"
                disabled={busy || !ready}
              >
                Проверить и сохранить
              </button>
            </div>
          </form>
          {error && <p className="fault">{error}</p>}
          {note && <p className="hint">{note}</p>}
          <p className="hint">
            Безопасность: токен шифруется на сервере и не возвращается в
            браузер; бот отвечает только владельцу (вашему Telegram ID);
            переписка видна в приложении в чате «Telegram: Джарвис»; голосовые
            сообщения распознаются автоматически.
          </p>
        </>
      )}
    </div>
  );
}
