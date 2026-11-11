import { useEffect, useState } from 'react';
import type {
  Agent,
  AgentTemplate,
  McpServerPublic,
  ProviderPublic,
  SkillSummary,
} from '@mayak/shared';
import { api } from '../api';
import { useI18n } from '../i18n';
import { localFsSupported, setStorageMode, storageMode } from '../local-fs';
import { modelLabel, splitModelRef, visibleModels } from '../models';
import { buildAgentPrompt } from '../agent-context';
import { AgentCapabilities } from './AgentCapabilities';

const STEPS = [
  'stepTemplate',
  'stepIdentity',
  'stepPrompt',
  'stepModel',
  'stepTools',
  'stepReview',
] as const;

export function AgentWizard({
  onClose,
  onCreated,
  restricted = false,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  /** Менеджер: личный агент без MCP. */
  restricted?: boolean;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [servers, setServers] = useState<McpServerPublic[]>([]);
  const [templateId, setTemplateId] = useState('assistant');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🏮');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [niche, setNiche] = useState('');
  const [customNiche, setCustomNiche] = useState('');
  const [tasks, setTasks] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<string[] | null>(null);
  // По умолчанию новый агент работает в папке на компьютере: файлы и память
  // не уходят на сервер. В облако можно переключить здесь или в чате.
  const [storage, setStorage] = useState<'local' | 'cloud'>(() =>
    storageMode(null) === 'local' ? 'local' : 'cloud',
  );
  const [error, setError] = useState('');
  // Имя подставили с суффиксом, потому что такое уже занято.
  const [nameAdjusted, setNameAdjusted] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: шаблон применяется один раз при загрузке
  useEffect(() => {
    void Promise.all([
      api.templates(),
      api.providers(),
      api.skills(),
      api.mcp().catch(() => []),
      api.agents().catch(() => []),
    ])
      .then(
        ([nextTemplates, nextProviders, nextSkills, nextServers, nextAgents]) => {
          setTemplates(nextTemplates);
          setProviders(nextProviders);
          setSkills(nextSkills.skills);
          setServers(nextServers);
          setAgents(nextAgents);
          const first = nextTemplates[0];
          if (first)
            applyTemplate(
              first,
              nextSkills.skills,
              nextServers,
              nextProviders,
              nextAgents,
            );
        },
      )
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('error')),
      );
  }, [t]);

  /** Имена, которые сервер не даст повторить: свои (менеджер) или общие (админ). */
  function takenNames(list: Agent[]): Set<string> {
    const relevant = restricted
      ? list.filter((agent) => agent.ownerId)
      : list.filter((agent) => !agent.ownerId);
    return new Set(
      relevant.map((agent) => agent.name.trim().toLowerCase()),
    );
  }

  /** Свободное имя на основе шаблона: «Помощник по продажам 2», «… 3» и т. д. */
  function freeName(base: string, taken: Set<string>): string {
    const clean = base.trim();
    if (!taken.has(clean.toLowerCase())) return clean;
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${clean} ${index}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${clean} ${Date.now()}`;
  }

  function applyTemplate(
    template: AgentTemplate,
    nextSkills = skills,
    nextServers = servers,
    nextProviders = providers,
    nextAgents = agents,
  ) {
    setTemplateId(template.id);
    setPlugins(template.plugins ?? null);
    const taken = takenNames(nextAgents);
    const free = freeName(template.name, taken);
    setName(free);
    setNameAdjusted(free !== template.name.trim());
    setEmoji(template.emoji);
    setDescription(template.description);
    setSystemPrompt(template.systemPrompt);
    setSkillNames(
      nextSkills
        .filter((skill) =>
          template.skillNames
            ? template.skillNames.includes(skill.name)
            : false,
        )
        .map((skill) => skill.name),
    );
    // MCP добавляют много инструментов — включаем только те, что нужны шаблону.
    const wanted = template.mcpNames ?? [];
    setMcpServerIds(
      nextServers
        .filter(
          (server) =>
            server.enabled &&
            wanted.some((name) =>
              name.endsWith('-')
                ? server.name.startsWith(name)
                : server.name === name,
            ),
        )
        .map((server) => server.id),
    );
    const provider = nextProviders.find(
      (item) => item.enabled && item.models.length > 0,
    );
    setProviderId(provider?.id ?? '');
    setModel(provider?.models[0] ?? '');
  }

  const taken = takenNames(agents);
  const nameTaken =
    name.trim().length > 0 && taken.has(name.trim().toLowerCase());

  async function create() {
    setError('');
    if (nameTaken) {
      setError(
        'Агент с таким именем уже есть — измените имя на шаге «Кто это».',
      );
      setStep(1);
      return;
    }
    try {
      const created = await api.createAgent({
        name: name.trim(),
        emoji,
        description,
        systemPrompt: buildAgentPrompt(systemPrompt, selectedNiche, tasks),
        providerId: providerId || null,
        model: model || null,
        skillNames,
        mcpServerIds,
        plugins,
      });
      setStorageMode(created.id, storage);
      onCreated(created.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    }
  }

  const selectedNiche = niche === 'custom' ? customNiche.trim() : niche;
  const provider = providers.find((item) => item.id === providerId);
  const stepKey = STEPS[step] ?? 'stepTemplate';

  return (
    <div className="modal-back">
      <form
        className="wizard card"
        onSubmit={(event) => {
          event.preventDefault();
          if (step < STEPS.length - 1) setStep(step + 1);
          else void create();
        }}
      >
        <header className="card-top">
          <div>
            <p className="eyebrow">{t('newAgent')}</p>
            <h2>{t(stepKey)}</h2>
          </div>
          <button type="button" className="ghost slim" onClick={onClose}>
            {t('close')}
          </button>
        </header>
        {error && <p className="error-line">{error}</p>}
        {step === 0 && (
          <div className="template-grid">
            <button
              type="button"
              className={
                templateId === 'custom'
                  ? 'template active custom'
                  : 'template custom'
              }
              onClick={() => {
                setTemplateId('custom');
                setName('');
                setEmoji('🤖');
                setDescription('');
                setSystemPrompt('');
                setSkillNames([]);
                setMcpServerIds([]);
                setPlugins(null);
                setStep(1);
              }}
            >
              <span>✨</span>
              <strong>{t('customAgent')}</strong>
              <small>{t('customAgentHint')}</small>
            </button>
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className={
                  templateId === template.id ? 'template active' : 'template'
                }
                onClick={() => applyTemplate(template)}
              >
                <span>{template.emoji}</span>
                <strong>{template.name}</strong>
                <small>{template.description}</small>
              </button>
            ))}
          </div>
        )}
        {step === 1 && (
          <div className="form">
            <label>
              {t('agentEmoji')}
              <input
                value={emoji}
                onChange={(event) => setEmoji(event.target.value)}
                maxLength={8}
              />
            </label>
            <label>
              {t('agentName')}
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameAdjusted(false);
                }}
                required
              />
            </label>
            {nameTaken && (
              <p className="fault">
                Агент с таким именем уже есть. Добавьте к имени номер или
                название проекта — например, «{name.trim()} 2».
              </p>
            )}
            <label>
              {t('agentDescription')}
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </div>
        )}
        {step === 2 && (
          <div className="form agent-context">
            <p className="muted">{t('agentContextHint')}</p>
            <label>
              {t('agentNiche')}
              <select
                value={niche}
                onChange={(event) => setNiche(event.target.value)}
              >
                <option value="">{t('agentNicheGeneral')}</option>
                <option value={t('agentNicheRetail')}>
                  {t('agentNicheRetail')}
                </option>
                <option value={t('agentNicheServices')}>
                  {t('agentNicheServices')}
                </option>
                <option value={t('agentNicheEducation')}>
                  {t('agentNicheEducation')}
                </option>
                <option value={t('agentNicheTechnology')}>
                  {t('agentNicheTechnology')}
                </option>
                <option value={t('agentNicheProduction')}>
                  {t('agentNicheProduction')}
                </option>
                <option value={t('agentNicheCreative')}>
                  {t('agentNicheCreative')}
                </option>
                <option value="custom">{t('agentNicheCustom')}</option>
              </select>
            </label>
            {niche === 'custom' && (
              <label>
                {t('agentNicheOwn')}
                <input
                  value={customNiche}
                  maxLength={200}
                  placeholder={t('agentNichePlaceholder')}
                  onChange={(event) => setCustomNiche(event.target.value)}
                />
              </label>
            )}
            <label>
              {t('agentTasks')}
              <textarea
                rows={3}
                value={tasks}
                maxLength={2000}
                placeholder={t('agentTasksPlaceholder')}
                onChange={(event) => setTasks(event.target.value)}
              />
            </label>
            <details>
              <summary>{t('agentInstructionsAdvanced')}</summary>
              <label>
                {t('agentPrompt')}
                <textarea
                  rows={8}
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                />
              </label>
            </details>
          </div>
        )}
        {step === 3 && (
          <label className="form">
            {t('modelLabel')}
            <select
              value={providerId && model ? `${providerId}:${model}` : ''}
              onChange={(event) => {
                const [nextProvider, nextModel] = splitModelRef(
                  event.target.value,
                );
                setProviderId(nextProvider ?? '');
                setModel(nextModel ?? '');
              }}
            >
              <option value="">{t('noProviders')}</option>
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
        )}
        {step === 4 && (
          <AgentCapabilities
            skills={skills}
            servers={servers}
            skillNames={skillNames}
            mcpServerIds={mcpServerIds}
            plugins={plugins}
            restricted={restricted}
            onSkills={setSkillNames}
            onServers={setMcpServerIds}
            onPlugins={setPlugins}
          />
        )}
        {step === 5 && (
          <div className="review">
            <p>
              <span>{emoji}</span> <strong>{name}</strong>
            </p>
            {nameAdjusted && (
              <p className="hint">
                Имя подставлено с номером: агент с именем «{name.replace(
                  / \d+$/,
                  '',
                )}» уже есть.
              </p>
            )}
            {nameTaken && (
              <p className="fault">
                Такое имя уже занято — вернитесь на шаг «Кто это» и измените
                его.
              </p>
            )}
            <p>{description}</p>
            <p>
              {t('agentNiche')}: {selectedNiche || t('agentNicheGeneral')}
            </p>
            {tasks.trim() && (
              <p className="agent-context-tasks">
                {t('agentTasks')}: {tasks.trim()}
              </p>
            )}
            <p className="muted">
              {provider?.name ?? '—'} / {model || '—'}
            </p>
            <p className="muted">{skillNames.join(', ') || '—'}</p>
            {localFsSupported() && (
              <div className="form storage-choice">
                <p className="muted">Где агент хранит файлы и память</p>
                <label>
                  <input
                    type="radio"
                    name="storage"
                    checked={storage === 'local'}
                    onChange={() => setStorage('local')}
                  />{' '}
                  💻 На этом компьютере (по умолчанию) — файлы и память остаются
                  у вас и не занимают сервер
                </label>
                <label>
                  <input
                    type="radio"
                    name="storage"
                    checked={storage === 'cloud'}
                    onChange={() => setStorage('cloud')}
                  />{' '}
                  ☁ В облаке на сервере
                </label>
              </div>
            )}
          </div>
        )}
        <div className="row-actions">
          {step > 0 && (
            <button
              type="button"
              className="ghost"
              onClick={() => setStep(step - 1)}
            >
              {t('wizardBack')}
            </button>
          )}
          <button className="primary-btn" type="submit">
            {step === STEPS.length - 1 ? t('wizardCreate') : t('wizardNext')}
          </button>
        </div>
      </form>
    </div>
  );
}
