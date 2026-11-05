import { useEffect, useState } from 'react';
import type {
  Agent,
  GithubRepoInfo,
  MemoryNote,
  McpServerPublic,
  ProviderPublic,
  Routine,
  SkillSummary,
} from '@mayak/shared';
import { api } from '../api';
import { useI18n } from '../i18n';
import { modelLabel, splitModelRef, visibleModels } from '../models';
import { IconMenu } from './icons';

export function AgentEditor({
  agent,
  providers,
  onMenu,
  onSaved,
  onDeleted,
  restricted = false,
  canShare = false,
}: {
  agent: Agent;
  providers: ProviderPublic[];
  onMenu: () => void;
  onSaved: (agent: Agent) => void;
  onDeleted: () => void;
  /** Менеджер правит личного агента: без MCP и GitHub. */
  restricted?: boolean;
  /** Админ может сделать личного агента менеджера общим. */
  canShare?: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(agent);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [servers, setServers] = useState<McpServerPublic[]>([]);
  const [githubRepos, setGithubRepos] = useState<GithubRepoInfo[]>([]);
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [noteKey, setNoteKey] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [routineName, setRoutineName] = useState('');
  const [routineCron, setRoutineCron] = useState('0 9 * * 1-5');
  const [routinePrompt, setRoutinePrompt] = useState('');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setDraft(agent);
    void Promise.all([
      api.skills(),
      api.mcp().catch(() => []),
      api.memory(agent.id),
      api.routines(agent.id),
      api.githubStatus().catch(() => null),
    ])
      .then(
        async ([nextSkills, nextServers, nextNotes, nextRoutines, github]) => {
          setSkills(nextSkills.skills);
          setServers(nextServers);
          setNotes(nextNotes);
          setRoutines(nextRoutines);
          if (github?.connected) {
            setGithubRepos(await api.githubRepos().catch(() => []));
          } else {
            setGithubRepos([]);
          }
        },
      )
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('error')),
      );
  }, [agent, t]);

  async function save() {
    setError('');
    try {
      const saved = await api.updateAgent(agent.id, {
        name: draft.name,
        emoji: draft.emoji,
        description: draft.description,
        systemPrompt: draft.systemPrompt,
        providerId: draft.providerId,
        model: draft.model,
        skillNames: draft.skillNames,
        mcpServerIds: draft.mcpServerIds,
        githubRepos: draft.githubRepos ?? [],
      });
      onSaved(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
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
        <h1>
          {draft.emoji} {t('configureAgent')}
        </h1>
      </header>
      <div className="settings-body">
        {error && <p className="error-line">{error}</p>}
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            {t('agentEmoji')}
            <input
              value={draft.emoji}
              onChange={(event) =>
                setDraft({ ...draft, emoji: event.target.value })
              }
            />
          </label>
          <label>
            {t('agentName')}
            <input
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
              required
            />
          </label>
          <label>
            {t('agentDescription')}
            <input
              value={draft.description}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </label>
          <label>
            {t('agentPrompt')}
            <textarea
              rows={8}
              value={draft.systemPrompt}
              onChange={(event) =>
                setDraft({ ...draft, systemPrompt: event.target.value })
              }
            />
          </label>
          <label>
            {t('modelLabel')}
            <select
              value={
                draft.providerId && draft.model
                  ? `${draft.providerId}:${draft.model}`
                  : ''
              }
              onChange={(event) => {
                const [providerId, model] = splitModelRef(event.target.value);
                setDraft({
                  ...draft,
                  providerId: providerId || null,
                  model: model || null,
                });
              }}
            >
              <option value="">—</option>
              {providers
                .filter((item) => item.enabled)
                .map((item) =>
                  visibleModels(item).map((itemModel) => (
                    <option
                      key={`${item.id}:${itemModel}`}
                      value={`${item.id}:${itemModel}`}
                    >
                      {item.name} / {modelLabel(item, itemModel, t)}
                    </option>
                  )),
                )}
            </select>
          </label>
          <div className="check-grid">
            {skills.map((skill) => (
              <label key={skill.name} className="check">
                <input
                  type="checkbox"
                  checked={draft.skillNames.includes(skill.name)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      skillNames: event.target.checked
                        ? [...draft.skillNames, skill.name]
                        : draft.skillNames.filter(
                            (item) => item !== skill.name,
                          ),
                    })
                  }
                />
                {skill.name}
              </label>
            ))}
            {!restricted &&
              servers.map((server) => (
                <label key={server.id} className="check">
                  <input
                    type="checkbox"
                    checked={draft.mcpServerIds.includes(server.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        mcpServerIds: event.target.checked
                          ? [...draft.mcpServerIds, server.id]
                          : draft.mcpServerIds.filter(
                              (item) => item !== server.id,
                            ),
                      })
                    }
                  />
                  MCP {server.name}
                </label>
              ))}
            {!restricted &&
              githubRepos.map((item) => (
                <label key={item.fullName} className="check">
                  <input
                    type="checkbox"
                    checked={(draft.githubRepos ?? []).includes(item.fullName)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        githubRepos: event.target.checked
                          ? [...(draft.githubRepos ?? []), item.fullName]
                          : (draft.githubRepos ?? []).filter(
                              (name) => name !== item.fullName,
                            ),
                      })
                    }
                  />
                  {item.fullName}
                </label>
              ))}
          </div>
          {!restricted && githubRepos.length > 0 && (
            <p className="hint">{t('githubRepos')}</p>
          )}
          {agent.ownerId && <p className="hint">{t('personalAgentHint')}</p>}
          <div className="row-actions">
            {canShare && agent.ownerId && (
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  void api
                    .updateAgent(agent.id, { shared: true } as never)
                    .then((saved) => onSaved(saved))
                }
              >
                {t('makeShared')}
              </button>
            )}
            <button className="primary-btn" type="submit">
              {t('save')}
            </button>
            <button
              type="button"
              className={confirmDelete ? 'danger' : 'ghost danger-text'}
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                void api
                  .deleteAgent(agent.id)
                  .then(onDeleted)
                  .catch((reason: unknown) => {
                    setError(
                      reason instanceof Error ? reason.message : t('lastAgent'),
                    );
                  });
              }}
            >
              {confirmDelete ? t('confirmDelete') : t('deleteAgent')}
            </button>
          </div>
        </form>

        <section className="card">
          <h2>{t('memory')}</h2>
          {notes.length === 0 && <p className="muted">{t('memoryEmpty')}</p>}
          <ul className="stack">
            {notes.map((note) => (
              <li key={note.key}>
                <strong>{note.key}</strong>
                <p>{note.content}</p>
                <button
                  type="button"
                  className="ghost slim"
                  onClick={() =>
                    void api
                      .deleteMemory(agent.id, note.key)
                      .then(() => api.memory(agent.id).then(setNotes))
                  }
                >
                  {t('delete')}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void api
                .saveMemory(agent.id, noteKey.trim(), noteContent)
                .then(() => {
                  setNoteKey('');
                  setNoteContent('');
                  return api.memory(agent.id).then(setNotes);
                });
            }}
          >
            <label>
              {t('memoryKey')}
              <input
                value={noteKey}
                onChange={(event) => setNoteKey(event.target.value)}
                required
              />
            </label>
            <label>
              {t('memoryContent')}
              <textarea
                rows={3}
                value={noteContent}
                onChange={(event) => setNoteContent(event.target.value)}
              />
            </label>
            <button className="ghost" type="submit">
              {t('save')}
            </button>
          </form>
        </section>

        <section className="card">
          <h2>{t('routines')}</h2>
          <p className="hint">{t('routineHint')}</p>
          <ul className="stack">
            {routines.map((routine) => (
              <li key={routine.id} className="routine">
                <div>
                  <strong>{routine.name}</strong>
                  <p className="muted">
                    <code>{routine.cron || 'webhook'}</code>
                    {routine.webhookToken
                      ? ` · /api/hooks/${routine.webhookToken}`
                      : ''}
                    {routine.lastRunAt ? ` · ${routine.lastRunAt}` : ''}
                  </p>
                  <p>{routine.prompt}</p>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="ghost slim"
                    onClick={() => void api.runRoutine(agent.id, routine.id)}
                  >
                    {t('routineRun')}
                  </button>
                  <button
                    type="button"
                    className="ghost slim"
                    onClick={() =>
                      void api
                        .updateRoutine(agent.id, routine.id, {
                          enabled: !routine.enabled,
                        })
                        .then(() => api.routines(agent.id).then(setRoutines))
                    }
                  >
                    {routine.enabled ? t('enabled') : t('statusDisconnected')}
                  </button>
                  <button
                    type="button"
                    className="ghost slim danger-text"
                    onClick={() =>
                      void api
                        .deleteRoutine(agent.id, routine.id)
                        .then(() => api.routines(agent.id).then(setRoutines))
                    }
                  >
                    {t('delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              setError('');
              void api
                .createRoutine(agent.id, {
                  name: routineName,
                  cron: routineCron,
                  prompt: routinePrompt,
                  enabled: true,
                })
                .then(() => {
                  setRoutineName('');
                  setRoutinePrompt('');
                  return api.routines(agent.id).then(setRoutines);
                })
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error ? reason.message : t('error'),
                  ),
                );
            }}
          >
            <label>
              {t('routineName')}
              <input
                value={routineName}
                onChange={(event) => setRoutineName(event.target.value)}
                required
              />
            </label>
            <label>
              {t('routineCron')}
              <input
                value={routineCron}
                onChange={(event) => setRoutineCron(event.target.value)}
                required
              />
            </label>
            <label>
              {t('routinePrompt')}
              <textarea
                rows={3}
                value={routinePrompt}
                onChange={(event) => setRoutinePrompt(event.target.value)}
                required
              />
            </label>
            <button className="primary-btn" type="submit">
              {t('routineAdd')}
            </button>
          </form>
        </section>
      </div>
    </section>
  );
}
