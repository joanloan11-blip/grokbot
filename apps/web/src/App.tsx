import { useCallback, useEffect, useState } from 'react';
import type {
  Agent,
  Conversation,
  ProviderPublic,
  PublicUser,
  SearchHit,
} from '@mayak/shared';
import { ApiError, api } from './api';
import { AgentEditor } from './components/AgentEditor';
import { AgentWizard } from './components/AgentWizard';
import { AuthScreen } from './components/AuthScreen';
import { ChatPane } from './components/ChatPane';
import {
  BeaconMark,
  IconPlus,
  IconSearch,
  IconSidebar,
} from './components/icons';
import { SettingsPane, type SettingsTab } from './components/SettingsPane';
import { TeamPane } from './components/TeamPane';
import { I18nProvider, useI18n } from './i18n';

type View =
  | { name: 'chat' }
  | { name: 'settings'; tab: SettingsTab }
  | { name: 'agent' }
  | { name: 'team' };

export function App() {
  return (
    <I18nProvider>
      <Gate />
    </I18nProvider>
  );
}

function Gate() {
  const [ready, setReady] = useState(false);
  const [required, setRequired] = useState(false);
  const [user, setUser] = useState<PublicUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await api.authConfig();
        if (cancelled) return;
        setRequired(config.required);
        if (config.required) {
          try {
            setUser((await api.me()).user);
          } catch {
            setUser(null);
          }
        }
      } catch {
        setRequired(false);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onLogout = useCallback(() => {
    void api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  if (!ready) return null;
  if (required && !user) return <AuthScreen onUser={setUser} />;
  return <Shell user={user} onLogout={onLogout} />;
}

function Shell({
  user,
  onLogout,
}: {
  user: PublicUser | null;
  onLogout: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const isAdmin = !user || user.role === 'admin';
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
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('mayak.sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  const toggleSidebar = (next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem('mayak.sidebar', next ? 'collapsed' : 'open');
    } catch {
      /* ignore */
    }
  };
  const openNav = () => {
    if (window.matchMedia('(max-width: 900px)').matches) setNavOpen(true);
    else toggleSidebar(false);
  };
  const [chatQuery, setChatQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    const query = chatQuery.trim();
    if (query.length < 2) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .search(query)
        .then((next) => {
          if (!cancelled) setHits(next);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [chatQuery]);
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
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onLogout();
      setOnline(false);
    }
  }, [onLogout]);

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
    <div className={collapsed ? 'app collapsed' : 'app'}>
      <aside className={navOpen ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <BeaconMark />
          <strong>{t('brand')}</strong>
          <button
            type="button"
            className="icon-btn quiet collapse-btn"
            aria-label={t('hideSidebar')}
            title={t('hideSidebar')}
            onClick={() => {
              setNavOpen(false);
              toggleSidebar(true);
            }}
          >
            <IconSidebar />
          </button>
        </div>
        <button
          className="primary-btn new-chat"
          type="button"
          onClick={() => openChat(null)}
        >
          <IconPlus />
          {t('newChat')}
        </button>
        <label className="chat-search">
          <IconSearch />
          <input
            value={chatQuery}
            placeholder={t('searchChats')}
            onChange={(event) => setChatQuery(event.target.value)}
          />
        </label>
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
        {isAdmin && (
          <button
            className="ghost"
            type="button"
            onClick={() => setWizard(true)}
          >
            <IconPlus />
            {t('newAgent')}
          </button>
        )}
        {isAdmin && agent && (
          <button
            className="ghost slim"
            type="button"
            onClick={() => setView({ name: 'agent' })}
          >
            {t('configureAgent')}
          </button>
        )}
        <p className="side-label">{t('chats')}</p>
        {hits && (
          <div className="search-hits">
            <p className="side-label">{t('searchResults')}</p>
            {hits.length === 0 && (
              <p className="muted empty-side">{t('noResults')}</p>
            )}
            {hits.map((hit) => (
              <button
                key={hit.conversationId}
                type="button"
                className={
                  hit.conversationId === activeId
                    ? 'conv hit active'
                    : 'conv hit'
                }
                onClick={() => {
                  if (hit.agentId && hit.agentId !== agentId)
                    setAgentId(hit.agentId);
                  openChat(hit.conversationId);
                }}
              >
                <span>{hit.title}</span>
                <small>{hit.snippet}</small>
              </button>
            ))}
          </div>
        )}
        <nav className="conv-list" hidden={hits !== null}>
          {conversations.length === 0 && (
            <p className="muted empty-side">{t('noChats')}</p>
          )}
          {conversations
            .filter((conversation) =>
              conversation.title
                .toLowerCase()
                .includes(chatQuery.trim().toLowerCase()),
            )
            .map((conversation) => (
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
          {user?.role === 'admin' && (
            <button
              type="button"
              className={view.name === 'team' ? 'ghost active' : 'ghost'}
              onClick={() => {
                setView({ name: 'team' });
                setNavOpen(false);
              }}
            >
              {t('team')}
            </button>
          )}
          {isAdmin && (
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
          )}
          <button
            type="button"
            className="lang"
            onClick={() => setLocale(locale === 'ru' ? 'en' : 'ru')}
          >
            {locale === 'ru' ? 'EN' : 'RU'}
          </button>
          {user && (
            <button type="button" className="ghost" onClick={onLogout}>
              {t('logout')}
            </button>
          )}
        </div>
        {user && (
          <p className="muted empty-side">
            {t('youAre')} {user.email}
          </p>
        )}
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
            onMenu={openNav}
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
            barPicker={user?.role === 'manager'}
            onMenu={openNav}
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
        ) : view.name === 'team' && user?.role === 'admin' ? (
          <TeamPane onMenu={openNav} />
        ) : view.name === 'settings' && isAdmin ? (
          <SettingsPane
            tab={view.tab}
            onTab={(tab) => setView({ name: 'settings', tab })}
            onMenu={openNav}
            shareModels={user?.role === 'admin'}
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
