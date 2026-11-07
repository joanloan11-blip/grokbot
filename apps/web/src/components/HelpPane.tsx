import { useEffect, useState } from 'react';
import { MarkdownView } from './MarkdownView';
import { IconMenu } from './icons';
import { useI18n } from '../i18n';

/**
 * Справка для пользователя: тот же docs/USER-GUIDE.md, что лежит в репозитории,
 * отдаётся сервером через /api/help. Правка файла не требует пересборки фронта.
 */
export function HelpPane({ onMenu }: { onMenu: () => void }) {
  const { t } = useI18n();
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/help', { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as { markdown?: string };
      })
      .then((data) => {
        if (!alive) return;
        if (data.markdown) setMarkdown(data.markdown);
        else setError(t('helpEmpty'));
      })
      .catch(() => {
        if (alive) setError(t('helpEmpty'));
      });
    return () => {
      alive = false;
    };
  }, [t]);

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
        <h1>{t('help')}</h1>
      </header>
      <div className="settings-body">
        {error ? (
          <p className="muted">{error}</p>
        ) : markdown ? (
          <MarkdownView text={markdown} />
        ) : (
          <p className="muted">{t('loading')}</p>
        )}
      </div>
    </section>
  );
}
