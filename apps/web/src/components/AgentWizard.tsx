import { useEffect, useState } from 'react';
import type {
  AgentTemplate,
  McpServerPublic,
  ProviderPublic,
  SkillSummary,
} from '@mayak/shared';
import { api } from '../api';
import { useI18n } from '../i18n';
import { modelLabel, splitModelRef, visibleModels } from '../models';
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
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [servers, setServers] = useState<McpServerPublic[]>([]);
  const [templateId, setTemplateId] = useState('assistant');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🏮');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: шаблон применяется один раз при загрузке
  useEffect(() => {
    void Promise.all([
      api.templates(),
      api.providers(),
      api.skills(),
      api.mcp().catch(() => []),
    ])
      .then(([nextTemplates, nextProviders, nextSkills, nextServers]) => {
        setTemplates(nextTemplates);
        setProviders(nextProviders);
        setSkills(nextSkills.skills);
        setServers(nextServers);
        const first = nextTemplates[0];
        if (first)
          applyTemplate(first, nextSkills.skills, nextServers, nextProviders);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('error')),
      );
  }, [t]);

  function applyTemplate(
    template: AgentTemplate,
    nextSkills = skills,
    nextServers = servers,
    nextProviders = providers,
  ) {
    setTemplateId(template.id);
    setPlugins(template.plugins ?? null);
    setName(template.name);
    setEmoji(template.emoji);
    setDescription(template.description);
    setSystemPrompt(template.systemPrompt);
    setSkillNames(
      nextSkills
        .filter((skill) =>
          template.skillNames
            ? template.skillNames.includes(skill.name)
            : skill.enabled,
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

  async function create() {
    setError('');
    try {
      const created = await api.createAgent({
        name: name.trim(),
        emoji,
        description,
        systemPrompt,
        providerId: providerId || null,
        model: model || null,
        skillNames,
        mcpServerIds: restricted ? [] : mcpServerIds,
        plugins,
      });
      onCreated(created.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    }
  }

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
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
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
          <label>
            {t('agentPrompt')}
            <textarea
              rows={10}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </label>
        )}
        {step === 3 && (
          <label>
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
            <p>{description}</p>
            <p className="muted">
              {provider?.name ?? '—'} / {model || '—'}
            </p>
            <p className="muted">{skillNames.join(', ') || '—'}</p>
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
