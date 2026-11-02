import { useCallback, useEffect, useState } from 'react';
import type { Conversation, ProviderPublic } from '@mayak/shared';
import { api } from './api';
import { ChatPane } from './components/ChatPane';
import { BeaconMark, IconPlus } from './components/icons';
import { SettingsPane, type SettingsTab } from './components/SettingsPane';
import { I18nProvider, useI18n } from './i18n';

type View = { name: 'chat' } | { name: 'settings'; tab: SettingsTab };

export function App() {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}

function Shell() {
  const { t, locale, setLocale } = useI18n();
  const [view, setView] = useState<View>({ name: 'chat' });
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [navOpen, setNavOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextConversations, nextProviders] = await Promise.all([
        api.conversations(),
        api.providers(),
      ]);
      setConversations(nextConversations);
      setProviders(nextProviders);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openChat = (id: string | null) => {
    setActiveId(id);
    setView({ name: 'chat' });
    setNavOpen(false);
  };

  return (
    <div className="app">
      <aside className={navOpen ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <BeaconMark />
          <div>
            <strong>{t('brand')}</strong>
            <small>{t('tagline')}</small>
          </div>
        </div>
        <button
          className="primary-btn"
          type="button"
          onClick={() => openChat(null)}
        >
          <IconPlus />
          {t('newChat')}
        </button>
        <p className="side-label">{t('chats')}</p>
        <nav className="conv-list">
          {conversations.length === 0 && (
            <p className="muted empty-side">{t('noChats')}</p>
          )}
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={
                view.name === 'chat' && conversation.id === activeId
                  ? 'conv active'
                  : 'conv'
              }
              onClick={() => openChat(conversation.id)}
            >
              <span>{conversation.title}</span>
              <time dateTime={conversation.updatedAt}>
                {formatWhen(conversation.updatedAt, locale)}
              </time>
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <button
            type="button"
            className={view.name === 'settings' ? 'ghost active' : 'ghost'}
            onClick={() => {
              setView({ name: 'settings', tab: 'providers' });
              setNavOpen(false);
            }}
          >
            {t('settings')}
          </button>
          <button
            type="button"
            className="lang"
            onClick={() => setLocale(locale === 'ru' ? 'en' : 'ru')}
          >
            {locale === 'ru' ? 'EN' : 'RU'}
          </button>
        </div>
      </aside>
      {navOpen && (
        <button
          className="scrim"
          type="button"
          aria-label={t('close')}
          onClick={() => setNavOpen(false)}
        />
      )}
      <main>
        {!online && (
          <div className="banner">
            <span>{t('serverDown')}</span>
            <button type="button" onClick={() => void refresh()}>
              {t('retry')}
            </button>
          </div>
        )}
        {view.name === 'chat' ? (
          <ChatPane
            conversationId={activeId}
            providers={providers}
            onMenu={() => setNavOpen(true)}
            onConversation={(conversation) => {
              setActiveId(conversation.id);
              setConversations((current) => {
                const rest = current.filter(
                  (item) => item.id !== conversation.id,
                );
                return [conversation, ...rest];
              });
            }}
            onDeleted={(id) => {
              setConversations((current) =>
                current.filter((item) => item.id !== id),
              );
              setActiveId(null);
            }}
          />
        ) : (
          <SettingsPane
            tab={view.tab}
            onTab={(tab) => setView({ name: 'settings', tab })}
            onMenu={() => setNavOpen(true)}
            onProvidersChanged={() => void refresh()}
          />
        )}
      </main>
    </div>
  );
}

function formatWhen(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale === 'en' ? 'en-GB' : 'ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
