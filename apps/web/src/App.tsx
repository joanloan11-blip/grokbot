import { useCallback, useEffect, useState } from 'react';
import type { Agent, Conversation, ProviderPublic } from '@mayak/shared';
import { api } from './api';
import { AgentEditor } from './components/AgentEditor';
import { AgentWizard } from './components/AgentWizard';
import { ChatPane } from './components/ChatPane';
import { BeaconMark, IconPlus } from './components/icons';
import { SettingsPane, type SettingsTab } from './components/SettingsPane';
import { I18nProvider, useI18n } from './i18n';

type View =
  | { name: 'chat' }
  | { name: 'settings'; tab: SettingsTab }
  | { name: 'agent' };

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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(() =>
    localStorage.getItem('mayak.agentId'),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [wizard, setWizard] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextAgents, nextProviders] = await Promise.all([
        api.agents(),
        api.providers(),
      ]);
      setAgents(nextAgents);
      setProviders(nextProviders);
      setAgentId((current) =>
        current && nextAgents.some((agent) => agent.id === current)
          ? current
          : (nextAgents[0]?.id ?? null),
      );
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!agentId) {
      setConversations([]);
      return;
    }
    localStorage.setItem('mayak.agentId', agentId);
    let cancelled = false;
    void api
      .conversations(agentId)
      .then((next) => {
        if (!cancelled)
          setConversations((current) =>
            mergeConversations(agentId, current, next),
          );
      })
      .catch(() => {
        if (!cancelled) {
          setConversations((current) =>
            current.filter((item) => item.agentId === agentId),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const agent = agents.find((item) => item.id === agentId) ?? agents[0];

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
        <p className="side-label">{t('agents')}</p>
        <div className="agent-row">
          {agents.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                item.id === agent?.id ? 'agent-pill active' : 'agent-pill'
              }
              onClick={() => {
                setAgentId(item.id);
                setActiveId(null);
                setView({ name: 'chat' });
              }}
            >
              {item.emoji} {item.name}
            </button>
          ))}
        </div>
        <button className="ghost" type="button" onClick={() => setWizard(true)}>
          <IconPlus />
          {t('newAgent')}
        </button>
        {agent && (
          <button
            className="ghost slim"
            type="button"
            onClick={() => setView({ name: 'agent' })}
          >
            {t('configureAgent')}
          </button>
        )}
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
        {view.name === 'agent' && agent ? (
          <AgentEditor
            agent={agent}
            providers={providers}
            onMenu={() => setNavOpen(true)}
            onSaved={(saved) => {
              setAgents((current) =>
                current.map((item) => (item.id === saved.id ? saved : item)),
              );
              setView({ name: 'chat' });
            }}
            onDeleted={() => {
              setView({ name: 'chat' });
              setActiveId(null);
              void refresh();
            }}
          />
        ) : view.name === 'chat' && agent ? (
          <ChatPane
            conversationId={activeId}
            agentId={agent.id}
            defaultProviderId={agent.providerId}
            defaultModel={agent.model}
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
        ) : view.name === 'settings' ? (
          <SettingsPane
            tab={view.tab}
            onTab={(tab) => setView({ name: 'settings', tab })}
            onMenu={() => setNavOpen(true)}
            onProvidersChanged={() => void refresh()}
          />
        ) : (
          <p className="muted empty-side">{t('noAgent')}</p>
        )}
        {wizard && (
          <AgentWizard
            onClose={() => setWizard(false)}
            onCreated={(id) => {
              setWizard(false);
              setAgentId(id);
              setActiveId(null);
              setView({ name: 'chat' });
              void refresh();
            }}
          />
        )}
      </main>
    </div>
  );
}

function mergeConversations(
  agentId: string,
  current: Conversation[],
  next: Conversation[],
): Conversation[] {
  const byId = new Map<string, Conversation>();
  for (const item of next) byId.set(item.id, item);
  for (const item of current) {
    if (item.agentId && item.agentId !== agentId) continue;
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt > existing.updatedAt)
      byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
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
