import { useCallback, useEffect, useState } from 'react';
import type { MailAccountInput, MailAccountStatus } from '@mayak/shared';
import { api } from '../api';

/** Пояснение про часовой пояс сервера в блоке выжимки. */
const SERVER_TZ = 'Екатеринбург, UTC+5';

interface Preset {
  id: string;
  label: string;
  /** Пустой host — пресет «Другой сервер»: поля заполняет пользователь. */
  host: string;
  port: number | null;
  secure: boolean;
}

/** Готовые настройки популярных IMAP-серверов. */
const PRESETS: Preset[] = [
  {
    id: 'yandex',
    label: 'Яндекс.Почта',
    host: 'imap.yandex.ru',
    port: 993,
    secure: true,
  },
  {
    id: 'mailru',
    label: 'Mail.ru',
    host: 'imap.mail.ru',
    port: 993,
    secure: true,
  },
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
  },
  {
    id: 'outlook',
    label: 'Outlook',
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
  },
  {
    id: 'icloud',
    label: 'iCloud',
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
  },
  {
    id: 'custom',
    label: 'Другой сервер',
    host: '',
    port: null,
    secure: true,
  },
];

/** Состояние «не подключено»: при сбросе и при сетевой ошибке загрузки. */
const EMPTY_STATUS: MailAccountStatus = {
  connected: false,
  host: '',
  port: 993,
  secure: true,
  user: '',
  mailbox: 'INBOX',
  hasPassword: false,
  digest: null,
};

/** Достаёт время из cron-выражения `M H * * *` в формате `ЧЧ:ММ`. */
function cronToTime(cron: string): string {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(cron.trim());
  if (!match) return '09:00';
  const minutes = Number(match[1]);
  const hours = Number(match[2]);
  if (minutes > 59 || hours > 23) return '09:00';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Собирает cron-выражение `M H * * *` из значения поля `type="time"`. */
function timeToCron(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 23) return null;
  return `${minutes} ${hours} * * *`;
}

/**
 * Подключение личного почтового ящика по IMAP и настройка ежедневной выжимки.
 * Пароль уходит на сервер, хранится там зашифрованным и в браузер не возвращается.
 */
export function MailPane() {
  const [status, setStatus] = useState<MailAccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [preset, setPreset] = useState('yandex');
  const [host, setHost] = useState('imap.yandex.ru');
  const [port, setPort] = useState('993');
  const [secure, setSecure] = useState(true);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [mailbox, setMailbox] = useState('INBOX');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // Ежедневная выжимка: время и включённость.
  const [digestTime, setDigestTime] = useState('09:00');
  const [digestEnabled, setDigestEnabled] = useState(true);
  const [digestBusy, setDigestBusy] = useState(false);
  const [digestError, setDigestError] = useState('');
  const [digestNote, setDigestNote] = useState('');

  /** Применяет статус с сервера и подставляет время выжимки из cron. */
  const applyStatus = useCallback((next: MailAccountStatus) => {
    setStatus(next);
    if (next.digest) {
      setDigestTime(cronToTime(next.digest.cron));
      setDigestEnabled(next.digest.enabled);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .mailStatus()
      .then((next) => {
        if (alive) applyStatus(next);
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setStatus(EMPTY_STATUS);
        setLoadError(
          reason instanceof Error
            ? reason.message
            : 'Не удалось загрузить настройки почты.',
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [applyStatus]);

  /** Выбор готового сервера заполняет поля подключения. */
  function pickPreset(id: string) {
    const found =
      PRESETS.find((item) => item.id === id) ?? PRESETS[PRESETS.length - 1];
    setPreset(found.id);
    setHost(found.host);
    setPort(found.port === null ? '' : String(found.port));
    setSecure(found.secure);
    setError('');
    setNote('');
  }

  /** Собирает данные подключения; null — обязательные поля не заполнены. */
  function buildInput(): MailAccountInput | null {
    const hostValue = host.trim();
    const userValue = user.trim();
    const portValue = Number(port);
    if (!hostValue || !userValue) return null;
    if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535)
      return null;
    const input: MailAccountInput = {
      host: hostValue,
      port: portValue,
      secure,
      user: userValue,
      mailbox: mailbox.trim() || 'INBOX',
    };
    if (password.trim()) input.password = password.trim();
    return input;
  }

  const ready = buildInput() !== null && password.trim().length > 0;

  async function test() {
    const input = buildInput();
    if (!input) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const result = await api.testMail(input);
      if (result.ok) {
        setNote(`Подключение работает, писем в ящике: ${result.messages ?? 0}`);
      } else {
        setError(
          result.error || 'Не удалось подключиться к почтовому серверу.',
        );
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Не удалось проверить подключение.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    const input = buildInput();
    if (!input || !password.trim()) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      await api.saveMail(input);
      setPassword('');
      // Статус обновляем отдельно: ящик уже подключён, даже если запрос упал.
      try {
        applyStatus(await api.mailStatus());
      } catch {
        // при следующем открытии панели статус перечитается с сервера
        setStatus({
          connected: true,
          host: input.host,
          port: input.port,
          secure: input.secure,
          user: input.user,
          mailbox: input.mailbox ?? 'INBOX',
          hasPassword: true,
          digest: status?.digest ?? null,
        });
      }
      setNote('Ящик подключён. Ниже можно настроить ежедневную выжимку.');
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Не удалось сохранить настройки почты.',
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
      await api.deleteMail();
      setStatus(EMPTY_STATUS);
      setPassword('');
      setNote('Ящик отключён.');
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Не удалось отключить ящик.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function createDigest() {
    setDigestBusy(true);
    setDigestError('');
    setDigestNote('');
    try {
      const saved = await api.saveMailDigest({
        cron: '0 9 * * *',
        enabled: true,
      });
      setStatus((prev) => (prev ? { ...prev, digest: saved } : prev));
      setDigestTime(cronToTime(saved.cron));
      setDigestEnabled(saved.enabled);
      setDigestNote('Ежедневная выжимка включена: 09:00 по времени сервера.');
    } catch (reason) {
      setDigestError(
        reason instanceof Error
          ? reason.message
          : 'Не удалось создать ежедневную выжимку.',
      );
    } finally {
      setDigestBusy(false);
    }
  }

  async function saveDigest() {
    const cron = timeToCron(digestTime);
    if (!cron) {
      setDigestError('Укажите корректное время выжимки.');
      return;
    }
    setDigestBusy(true);
    setDigestError('');
    setDigestNote('');
    try {
      const saved = await api.saveMailDigest({
        cron,
        enabled: digestEnabled,
      });
      setStatus((prev) => (prev ? { ...prev, digest: saved } : prev));
      setDigestTime(cronToTime(saved.cron));
      setDigestEnabled(saved.enabled);
      setDigestNote(
        saved.enabled
          ? `Сохранено: каждый день в ${cronToTime(saved.cron)} по времени сервера.`
          : 'Ежедневная рассылка выжимки отключена.',
      );
    } catch (reason) {
      setDigestError(
        reason instanceof Error
          ? reason.message
          : 'Не удалось сохранить время выжимки.',
      );
    } finally {
      setDigestBusy(false);
    }
  }

  async function runDigest() {
    setDigestBusy(true);
    setDigestError('');
    setDigestNote('');
    try {
      const result = await api.mailDigestNow();
      if (result.ok) {
        setDigestNote(
          'Выжимка запущена. Результат появится в чате «Почтовый агент».',
        );
      } else {
        setDigestError(result.error || 'Не удалось сделать выжимку.');
      }
    } catch (reason) {
      setDigestError(
        reason instanceof Error
          ? reason.message
          : 'Не удалось сделать выжимку.',
      );
    } finally {
      setDigestBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="panel card">
        <p className="muted">Загружаю настройки почты…</p>
      </div>
    );
  }

  return (
    <>
      <div className="panel card">
        <h3>
          Почта{' '}
          <span className={status?.connected ? 'pill on' : 'pill'}>
            {status?.connected
              ? `Подключено · ${status.user}@${status.host}`
              : 'Не подключено'}
          </span>
        </h3>
        <p className="hint">
          Подключите личный ящик по IMAP — агент «Почтовый агент» будет читать
          письма и делать ежедневную выжимку. Пароль хранится зашифрованным на
          сервере и в браузер не возвращается.
        </p>
        {loadError && <p className="fault">{loadError}</p>}
        {status?.connected ? (
          <>
            <p>
              Ящик:{' '}
              <strong>
                {status.user}@{status.host}
              </strong>{' '}
              <span className="muted">
                · порт {status.port}
                {status.secure ? ', TLS' : ''} · папка {status.mailbox}
              </span>
            </p>
            <p className="hint">
              Пароль сохранён зашифрованным на сервере и повторно не
              запрашивается.
            </p>
            {error && <p className="fault">{error}</p>}
            {note && <p className="hint">{note}</p>}
            <div className="row-actions">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void disconnect()}
              >
                Отключить
              </button>
            </div>
          </>
        ) : (
          <>
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              <label>
                Готовый сервер
                <select
                  value={preset}
                  onChange={(event) => pickPreset(event.target.value)}
                >
                  {PRESETS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Сервер (IMAP)
                <input
                  autoComplete="off"
                  value={host}
                  placeholder="imap.example.com"
                  onChange={(event) => setHost(event.target.value)}
                />
              </label>
              <label>
                Порт
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  placeholder="993"
                  onChange={(event) => setPort(event.target.value)}
                />
              </label>
              <label>
                Логин (адрес почты)
                <input
                  autoComplete="username"
                  value={user}
                  placeholder="you@example.com"
                  onChange={(event) => setUser(event.target.value)}
                />
              </label>
              <label>
                Пароль
                <input
                  type="password"
                  autoComplete="off"
                  value={password}
                  placeholder="пароль приложения или IMAP-пароль"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label>
                Папка
                <input
                  autoComplete="off"
                  value={mailbox}
                  placeholder="INBOX"
                  onChange={(event) => setMailbox(event.target.value)}
                />
              </label>
            </form>
            <div className="row-actions">
              <input
                id="mail-secure"
                type="checkbox"
                checked={secure}
                onChange={(event) => setSecure(event.target.checked)}
              />
              <label htmlFor="mail-secure">Защищённое соединение (TLS)</label>
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="ghost"
                disabled={busy || !ready}
                onClick={() => void test()}
              >
                Проверить подключение
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={busy || !ready}
                onClick={() => void connect()}
              >
                Подключить
              </button>
            </div>
            {error && <p className="fault">{error}</p>}
            {note && <p className="hint">{note}</p>}
            <p className="hint">
              Пароли приложений: Яндекс — «Пароли приложений» в Яндекс ID; Gmail
              — пароль приложения при включённой двухфакторной аутентификации;
              Mail.ru — «Пароль для внешних приложений». Для своего сервера
              подойдёт обычный пароль IMAP.
            </p>
          </>
        )}
      </div>
      {status?.connected && (
        <div className="panel card">
          <h3>Ежедневная выжимка</h3>
          <p className="hint">
            Короткая сводка новых писем. Время — по часовому поясу сервера (
            {SERVER_TZ}). Выжимка появляется в чате агента «Почтовый агент», а
            если подключён Telegram — приходит и туда.
          </p>
          {status.digest === null ? (
            <>
              <p className="muted">Ежедневная выжимка ещё не настроена.</p>
              <div className="row-actions">
                <button
                  type="button"
                  className="primary-btn"
                  disabled={digestBusy}
                  onClick={() => void createDigest()}
                >
                  Создать ежедневную выжимку
                </button>
              </div>
              <p className="hint">
                Включим рассылку на 09:00 — время можно будет изменить.
              </p>
            </>
          ) : (
            <>
              <form
                className="form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDigest();
                }}
              >
                <label>
                  Время выжимки (по времени сервера)
                  <input
                    type="time"
                    value={digestTime}
                    onChange={(event) => setDigestTime(event.target.value)}
                  />
                </label>
              </form>
              <div className="row-actions">
                <input
                  id="mail-digest-enabled"
                  type="checkbox"
                  checked={digestEnabled}
                  onChange={(event) => setDigestEnabled(event.target.checked)}
                />
                <label htmlFor="mail-digest-enabled">
                  Присылать каждый день
                </label>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="primary-btn"
                  disabled={digestBusy}
                  onClick={() => void saveDigest()}
                >
                  Сохранить время
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={digestBusy}
                  onClick={() => void runDigest()}
                >
                  Сделать выжимку сейчас
                </button>
              </div>
              {!digestEnabled && (
                <p className="hint">
                  Ежедневная рассылка выключена — сохраните время, чтобы
                  применить настройку.
                </p>
              )}
            </>
          )}
          {digestError && <p className="fault">{digestError}</p>}
          {digestNote && <p className="hint">{digestNote}</p>}
        </div>
      )}
    </>
  );
}
