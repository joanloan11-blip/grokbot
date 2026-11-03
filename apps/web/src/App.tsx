import { useCallback, useEffect, useState } from 'react';
import type {
  Agent,
  Conversation,
  ProviderPublic,
  Project,
  PublicUser,
  SearchHit,
} from '@mayak/shared';
import { ApiError, api } from './api';
import { AgentEditor } from './components/AgentEditor';
import { ProjectDialog } from './components/ProjectDialog';
import { AgentWizard } from './components/AgentWizard';
import { AuthScreen } from './components/AuthScreen';
import { ChatPane } from './components/ChatPane';
import {
  BeaconMark,
  IconEdit,
  IconFolder,
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
  const resetLink = new URLSearchParams(window.location.search).has('reset');
  if (required && (!user || resetLink)) return <AuthScreen onUser={setUser} />;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('mayak.projectId');
    } catch {
      return null;
    }
  });
  const [projectDialog, setProjectDialog] = useState<Project | 'new' | null>(
    null,
  );
  const project = projects.find((item) => item.id === projectId) ?? null;
  const selectProject = (id: string | null) => {
    setProjectId(id);
    setActiveId(null);
    setView({ name: 'chat' });
    try {
      if (id) localStorage.setItem('mayak.projectId', id);
      else localStorage.removeItem('mayak.projectId');
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    void api
      .projects()
      .then((next) => {
        setProjects(next);
        setProjectId((current) =>
          current && next.some((item) => item.id === current) ? current : null,
        );
      })
      .catch(() => setProjects([]));
  }, []);

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
    if (projectId) {
      let cancelled = false;
      void api
        .projectConversations(projectId)
        .then((next) => {
          if (!cancelled) setConversations(next);
        })
        .catch(() => {
          if (!cancelled) setConversations([]);
        });
      return () => {
        cancelled = true;
      };
    }
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
  }, [agentId, projectId]);

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
        <div className="side-scroll">
          <div className="side-head">
            <p className="side-label">{t('projects')}</p>
            <button
              type="button"
              className="icon-btn quiet tiny"
              aria-label={t('projectNew')}
              title={t('projectNew')}
              onClick={() => setProjectDialog('new')}
            >
              <IconPlus />
            </button>
          </div>
          <nav className="project-list">
            {projects.length === 0 && (
              <button
                type="button"
                className="conv hint-row"
                onClick={() => setProjectDialog('new')}
              >
                <span>{t('projectEmpty')}</span>
              </button>
            )}
            {projects
              .filter((item) => !item.archived)
              .map((item) => (
                <div
                  key={item.id}
                  className={
                    item.id === projectId ? 'project active' : 'project'
                  }
                >
                  <button
                    type="button"
                    className="project-open"
                    onClick={() =>
                      selectProject(item.id === projectId ? null : item.id)
                    }
                  >
                    <IconFolder />
                    <span>
                      {item.name}
                      {item.client && <small>{item.client}</small>}
                    </span>
                  </button>
                  {item.id === projectId && (
                    <button
                      type="button"
                      className="icon-btn quiet tiny"
                      aria-label={t('projectEdit')}
                      title={t('projectEdit')}
                      onClick={() => setProjectDialog(item)}
                    >
                      <IconEdit />
                    </button>
                  )}
                </div>
              ))}
          </nav>
          <div className="side-head">
            <p className="side-label">{t('agents')}</p>
            <span className="side-actions">
              {agent && (isAdmin || (user && agent.ownerId === user.id)) && (
                <button
                  type="button"
                  className="icon-btn quiet tiny"
                  aria-label={t('configureAgent')}
                  title={t('configureAgent')}
                  onClick={() => {
                    setView({ name: 'agent' });
                    setNavOpen(false);
                  }}
                >
                  <IconEdit />
                </button>
              )}
              <button
                type="button"
                className="icon-btn quiet tiny"
                aria-label={t('newAgent')}
                title={t('newAgent')}
                onClick={() => setWizard(true)}
              >
                <IconPlus />
              </button>
            </span>
          </div>
          <div className="agent-row">
            {agents.map((item) => (
              <button
                key={item.id}
                type="button"
                className={
                  item.id === agent?.id ? 'agent-pill active' : 'agent-pill'
                }
                title={item.description || item.name}
                onClick={() => {
                  setAgentId(item.id);
                  setActiveId(null);
                  setView({ name: 'chat' });
                }}
              >
                <span className="agent-name">
                  {item.emoji} {item.name}
                </span>
                {item.ownerId && <em className="own-mark">{t('personal')}</em>}
              </button>
            ))}
          </div>
          <p className="side-label">
            {project ? `${t('chats')} · ${project.name}` : t('chats')}
          </p>
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
                  onClick={() => {
                    if (
                      projectId &&
                      conversation.agentId &&
                      conversation.agentId !== agentId
                    )
                      setAgentId(conversation.agentId);
                    openChat(conversation.id);
                  }}
                >
                  <span>{conversation.title}</span>
                  <time dateTime={conversation.updatedAt}>
                    {formatWhen(conversation.updatedAt, locale)}
                  </time>
                </button>
              ))}
          </nav>
        </div>
        <div className="side-foot">
          {menuOpen && (
            <>
              <button
                type="button"
                className="menu-scrim"
                aria-label={t('close')}
                onClick={() => setMenuOpen(false)}
              />
              <div className="user-menu" role="menu">
                {user?.role === 'admin' && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setView({ name: 'team' });
                      setMenuOpen(false);
                      setNavOpen(false);
                    }}
                  >
                    {t('team')}
                  </button>
                )}
                {isAdmin && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setView({ name: 'settings', tab: 'providers' });
                      setMenuOpen(false);
                      setNavOpen(false);
                    }}
                  >
                    {t('settings')}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setLocale(locale === 'ru' ? 'en' : 'ru')}
                >
                  {t('language')}: {locale === 'ru' ? 'Русский' : 'English'}
                  <small>{locale === 'ru' ? 'EN' : 'RU'}</small>
                </button>
                {user && (
                  <button
                    type="button"
                    role="menuitem"
                    className="danger-text"
                    onClick={() => {
                      setMenuOpen(false);
                      onLogout();
                    }}
                  >
                    {t('logout')}
                  </button>
                )}
              </div>
            </>
          )}
          <button
            type="button"
            className={menuOpen ? 'user-btn open' : 'user-btn'}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="avatar">
              {(user?.name || user?.email || t('brand'))
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <span className="user-name">
              {user?.name || user?.email || t('brand')}
              {user && <small>{user.email}</small>}
            </span>
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
            restricted={!isAdmin}
            canShare={isAdmin}
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
            projectId={projectId}
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
        {projectDialog && (
          <ProjectDialog
            project={projectDialog === 'new' ? null : projectDialog}
            onClose={() => setProjectDialog(null)}
            onSaved={(saved) => {
              setProjects((current) => [
                saved,
                ...current.filter((item) => item.id !== saved.id),
              ]);
              setProjectDialog(null);
              selectProject(saved.id);
            }}
            onDeleted={(id) => {
              setProjects((current) =>
                current.filter((item) => item.id !== id),
              );
              setProjectDialog(null);
              if (projectId === id) selectProject(null);
            }}
          />
        )}
        {wizard && (
          <AgentWizard
            restricted={!isAdmin}
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
