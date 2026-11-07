import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';
import { IconMenu } from './icons';

interface Item {
  id: string;
  toolName: string;
  preview: string;
  conversationId: string;
  conversationTitle: string;
  agentName: string;
  createdAt: string;
}

/**
 * «Входящие»: агент не делает опасное сам — действия ждут решения человека.
 * Это же экран, на котором видно, чем занят цифровой сотрудник.
 */
export function InboxPane({
  onMenu,
  onOpenConversation,
}: {
  onMenu: () => void;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const data = await api.inbox();
      setItems(data.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    setError('');
    try {
      const response = await fetch(`/api/approvals/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ approve }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setBusy('');
    }
  }

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
        <h1>{t('inboxTitle')}</h1>
      </header>
      <div className="settings-body">
        <p className="muted">{t('inboxLead')}</p>
        {error && <p className="fault">{error}</p>}
        {items.length === 0 ? (
          <p className="muted">{t('inboxEmpty')}</p>
        ) : (
          <ul className="plain-list">
            {items.map((item) => (
              <li key={item.id} className="inbox-item">
                <div>
                  <strong>{item.toolName}</strong>{' '}
                  <span className="muted">
                    · {item.agentName || 'агент'}
                    {item.conversationTitle
                      ? ` · «${item.conversationTitle}»`
                      : ''}
                  </span>
                  <pre className="probe">{item.preview}</pre>
                </div>
                <span className="row-actions">
                  {onOpenConversation && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => onOpenConversation(item.conversationId)}
                    >
                      {t('inboxOpen')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={busy === item.id}
                    onClick={() => void decide(item.id, true)}
                  >
                    {t('inboxApprove')}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy === item.id}
                    onClick={() => void decide(item.id, false)}
                  >
                    {t('inboxDeny')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
