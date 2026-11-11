import { CapabilityCatalog } from './CapabilityCatalog';
import { AvitoPanel } from './AvitoPanel';
import { ServersPanel } from './ServersPanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODELS,
  type McpServerInput,
  type McpServerPublic,
  type DiscoverResult,
  type FreeCatalog,
  type FreeProvider,
  type ProviderInput,
  type ProviderKind,
  type ProviderPublic,
  guessProviderFromModel,
  guessProvidersFromKey,
  type Skill,
  type SkillSummary,
} from '@mayak/shared';
import { api } from '../api';
import { availableCount } from '../models';
import { useI18n, useTheme } from '../i18n';
import { GithubPane } from './GithubPane';
import { MailPane } from './MailPane';
import { TelegramPane } from './TelegramPane';
import { BillingSettingsPanel } from './BillingPane';
import { IconMenu } from './icons';

export type SettingsTab =
  | 'avito'
  | 'mail'
  | 'telegram'
  | 'servers'
  | 'plugins'
  | 'providers'
  | 'mcp'
  | 'skills'
  | 'github'
  | 'billing'
  | 'general';

const KINDS: ProviderKind[] = [
  'openai',
  'deepseek',
  'anthropic',
  'gemini',
  'mock',
];

export function SettingsPane({
  tab,
  onTab,
  onMenu,
  onProvidersChanged,
  shareModels = false,
  personal = false,
}: {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onMenu: () => void;
  onProvidersChanged: () => void;
  shareModels?: boolean;
  /** Менеджер: только свои модели (личные ключи), без остальных настроек. */
  personal?: boolean;
}) {
  const { t } = useI18n();
  const [personalTab, setPersonalTab] = useState<SettingsTab>('plugins');
  if (personal)
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
          <div>
            <h1>{t('myModels')}</h1>
            <p className="muted">{t('myModelsLead')}</p>
          </div>
        </header>
        <div className="settings-body">
          <div className="tabs" role="tablist" aria-label="Мои возможности">
            {(
              [
                { id: 'plugins', label: 'Плагины' },
                { id: 'mail', label: 'Почта' },
                { id: 'telegram', label: 'Telegram' },
                { id: 'avito', label: 'Авито' },
                { id: 'skills', label: 'Навыки' },
                { id: 'providers', label: 'Мои модели' },
                { id: 'mcp', label: 'Мои коннекторы' },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                role="tab"
                type="button"
                aria-selected={personalTab === item.id}
                className={personalTab === item.id ? 'active' : ''}
                onClick={() => setPersonalTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {(personalTab === 'plugins' || personalTab === 'skills') && (
            <CapabilityCatalog key={personalTab} kind={personalTab} personal />
          )}
          {personalTab === 'providers' && (
            <ProvidersPanel
              onChanged={onProvidersChanged}
              shareModels={false}
              personal
            />
          )}
          {personalTab === 'mail' && <MailPane />}
          {personalTab === 'telegram' && <TelegramPane />}
          {personalTab === 'avito' && <AvitoPanel />}
          {personalTab === 'mcp' && <McpPanel personal />}
        </div>
      </section>
    );
  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'plugins', label: 'Плагины' },
    { id: 'mail', label: 'Почта' },
    { id: 'telegram', label: 'Telegram' },
    { id: 'avito', label: 'Авито' },
    { id: 'servers', label: t('serversTitle') },
    { id: 'providers', label: t('tabProviders') },
    { id: 'mcp', label: t('tabMcp') },
    { id: 'skills', label: t('tabSkills') },
    { id: 'github', label: t('tabGithub') },
    { id: 'billing', label: 'Оплата' },
    { id: 'general', label: t('tabGeneral') },
  ];
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
        <h1>{t('settingsTitle')}</h1>
      </header>
      <div className="settings-body">
        <div className="tabs" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? 'active' : ''}
              onClick={() => onTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {tab === 'providers' && (
          <ProvidersPanel
            onChanged={onProvidersChanged}
            shareModels={shareModels}
          />
        )}
        {tab === 'plugins' && <CapabilityCatalog kind="plugins" />}
        {tab === 'mail' && <MailPane />}
        {tab === 'telegram' && <TelegramPane />}
        {tab === 'avito' && <AvitoPanel />}
        {tab === 'servers' && <ServersPanel />}
        {tab === 'mcp' && <McpPanel />}
        {tab === 'skills' && (
          <>
            <CapabilityCatalog kind="skills" />
            <details>
              <summary>Редактор навыков администратора</summary>
              <SkillsPanel />
            </details>
          </>
        )}
        {tab === 'github' && <GithubPane />}
        {tab === 'billing' && <BillingSettingsPanel />}
        {tab === 'general' && (
          <>
            <GeneralPanel />
            <ImagesPanel />
            <MoyskladPanel />
          </>
        )}
      </div>
    </section>
  );
}

/** Метки умений моделей провайдера после проверки. */
function CapsLine({ provider }: { provider: ProviderPublic }) {
  const { t } = useI18n();
  const caps = provider.caps ?? {};
  const checked = provider.models.filter((model) => caps[model]);
  if (!checked.length) return null;
  return (
    <div className="caps-line">
      {provider.models.map((model) => {
        const item = caps[model];
        if (!item) return null;
        const state =
          item.ok === false
            ? 'down'
            : item.tools === true
              ? 'tools'
              : item.tools === false
                ? 'text'
                : 'unknown';
        return (
          <span
            key={model}
            className={`cap cap-${state}`}
            title={item.error || new Date(item.checkedAt).toLocaleString()}
          >
            {model}
            <em>
              {state === 'down'
                ? t('capDown')
                : state === 'tools'
                  ? t('capTools')
                  : state === 'text'
                    ? t('capNoTools')
                    : '?'}
            </em>
          </span>
        );
      })}
      <p className="hint">{t('capLegend')}</p>
    </div>
  );
}

function FreeCatalogView({
  onPick,
  canRefresh,
}: {
  onPick: (item: FreeProvider) => void;
  canRefresh: boolean;
}) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<FreeCatalog | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    void api
      .freeProviders()
      .then(setCatalog)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : t('error')),
      );
  }, [t]);
  if (!catalog) return error ? <p className="error-line">{error}</p> : null;
  return (
    <div className="free-catalog card">
      <p className="hint">
        {t('freeLead')}{' '}
        <a href={catalog.source} target="_blank" rel="noreferrer">
          awesome-free-llm-apis
        </a>
        {catalog.lastUpdated && ` · ${catalog.lastUpdated}`}
        {canRefresh && (
          <>
            {' · '}
            <button
              type="button"
              className="link-btn"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                setError('');
                void api
                  .refreshFreeProviders()
                  .then(setCatalog)
                  .catch((reason: unknown) =>
                    setError(
                      reason instanceof Error ? reason.message : t('error'),
                    ),
                  )
                  .finally(() => setRefreshing(false));
              }}
            >
              {refreshing ? t('testing') : t('freeRefresh')}
            </button>
          </>
        )}
      </p>
      {error && <p className="error-line">{error}</p>}
      <ul className="free-list">
        {catalog.providers.map((item) => (
          <li key={item.id}>
            <div className="free-top">
              <strong>
                {item.flag} {item.name}
              </strong>
              <span className="free-tags">
                {!item.needsKey && (
                  <span className="pill on">{t('freeNoKey')}</span>
                )}
                {item.viaProxy && (
                  <span className="pill">{t('freeProxy')}</span>
                )}
              </span>
            </div>
            <p className="muted">{item.description}</p>
            {item.notes.length > 0 && (
              <ul className="free-notes">
                {item.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            <p className="free-models">
              {item.models
                .slice(0, 6)
                .map((model) => model.id)
                .join(', ')}
              {item.models.length > 6 ? ` +${item.models.length - 6}` : ''}
            </p>
            <div className="row-actions">
              {item.keyUrl && item.needsKey && (
                <a
                  className="ghost slim"
                  href={item.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('freeGetKey')}
                </a>
              )}
              <button
                type="button"
                className="primary-btn slim"
                onClick={() => onPick(item)}
              >
                {t('freeConnect')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function toggleShared(
  providers: ProviderPublic[],
  providerId: string,
  model: string,
  shared: boolean,
): Promise<void> {
  const models = providers.flatMap((provider) =>
    provider.managerModels
      .filter((item) => !(provider.id === providerId && item === model))
      .map((item) => ({ providerId: provider.id, model: item })),
  );
  if (shared) models.push({ providerId, model });
  await api.setSharedModels(models);
}

function ProvidersPanel({
  onChanged,
  shareModels,
  personal = false,
}: {
  onChanged: () => void;
  shareModels: boolean;
  personal?: boolean;
}) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [editing, setEditing] = useState<
    (ProviderInput & { id?: string; hasApiKey?: boolean }) | null
  >(null);
  const [error, setError] = useState('');
  const [testNote, setTestNote] = useState('');
  const [testing, setTesting] = useState(false);
  // Автоопределение: тип/адрес меняем сами, пока пользователь их не трогал.
  const [touched, setTouched] = useState({
    kind: false,
    baseUrl: false,
    name: false,
  });
  const [found, setFound] = useState<DiscoverResult | null>(null);
  const [freeOpen, setFreeOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const discoverSeq = useRef(0);
  const autoName = useRef('');

  const runDiscover = useCallback(
    async (form: NonNullable<typeof editing>, flags: typeof touched) => {
      const seq = ++discoverSeq.current;
      setDiscovering(true);
      try {
        const result = await api.discoverProvider({
          apiKey: form.apiKey?.trim() || undefined,
          baseUrl:
            flags.baseUrl || flags.kind ? form.baseUrl?.trim() : undefined,
          kind: flags.kind ? form.kind : undefined,
          models: (form.models ?? [])
            .map((item) => item.trim())
            .filter(Boolean),
          providerId: form.id,
        });
        if (seq !== discoverSeq.current) return;
        setFound(result);
        setEditing((current) => {
          if (!current) return current;
          const next = { ...current };
          if (!flags.kind) next.kind = result.kind;
          if (!flags.baseUrl && !flags.kind) next.baseUrl = result.baseUrl;
          if (
            !flags.name &&
            result.name &&
            (!current.name.trim() || current.name === autoName.current)
          ) {
            next.name = result.name;
            autoName.current = result.name;
          }
          const picked = (current.models ?? [])
            .map((item) => item.trim())
            .filter(Boolean);
          const working = result.working ?? [];
          if (result.verified && picked.length === 0) {
            // Предлагаем только модели, которые ответили на пробный запрос.
            next.models = (working.length ? working : result.models).slice(
              0,
              3,
            );
          }
          return next;
        });
      } catch (reason) {
        if (seq === discoverSeq.current)
          setFound({
            kind: form.kind,
            baseUrl: form.baseUrl ?? '',
            name: '',
            models: [],
            verified: false,
            error: reason instanceof Error ? reason.message : t('error'),
          });
      } finally {
        if (seq === discoverSeq.current) setDiscovering(false);
      }
    },
    [t],
  );

  // Ключ введён → через паузу определяем провайдера и грузим модели.
  const keyValue = editing?.apiKey?.trim() ?? '';
  useEffect(() => {
    if (!editing || keyValue.length < 10) return;
    const timer = window.setTimeout(
      () => void runDiscover(editing, touched),
      700,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyValue]);

  const toggleModel = (model: string) => {
    if (!editing) return;
    const list = (editing.models ?? [])
      .map((item) => item.trim())
      .filter(Boolean);
    setEditing({
      ...editing,
      models: list.includes(model)
        ? list.filter((item) => item !== model)
        : [...list, model],
    });
  };

  const load = useCallback(async () => {
    const list = await api.providers();
    // В «Моих моделях» — только свои ключи; общие модели менеджер видит в чате.
    setProviders(personal ? list.filter((row) => row.owned) : list);
  }, [personal]);
  // Пока идёт проверка моделей — обновляем список раз в 4 секунды.
  const anyChecking = providers.some((item) => item.checking);
  useEffect(() => {
    if (!anyChecking) return;
    const timer = setInterval(() => void load().catch(() => undefined), 4000);
    return () => clearInterval(timer);
  }, [anyChecking, load]);
  useEffect(() => {
    void load().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : t('error')),
    );
  }, [load, t]);

  async function save() {
    if (!editing) return;
    setError('');
    const payload: ProviderInput = {
      name: editing.name.trim(),
      kind: editing.kind,
      baseUrl: editing.baseUrl?.trim(),
      models: (editing.models ?? [])
        .map((model) => model.trim())
        .filter(Boolean),
      enabled: editing.enabled !== false,
    };
    if (editing.apiKey?.trim()) payload.apiKey = editing.apiKey.trim();
    const keyFromProviderId =
      !payload.apiKey && !editing.hasApiKey
        ? found?.keyFrom?.providerId
        : undefined;
    try {
      if (editing.id)
        await api.updateProvider(editing.id, { ...payload, keyFromProviderId });
      else await api.createProvider({ ...payload, keyFromProviderId });
      setEditing(null);
      setFound(null);
      await load();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    }
  }

  async function test(id: string) {
    setTesting(true);
    setTestNote('');
    try {
      const result = await api.testProvider(id);
      setTestNote(
        result.preview ? `${t('testOk')}: ${result.preview}` : t('testOk'),
      );
    } catch (reason) {
      setTestNote(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <button
          type="button"
          className="primary-btn"
          onClick={() => {
            setTouched({ kind: false, baseUrl: false, name: false });
            setFound(null);
            setEditing({
              name: '',
              kind: 'openai',
              baseUrl: 'https://api.openai.com/v1',
              models: [''],
              enabled: true,
              apiKey: '',
            });
          }}
        >
          {t('addProvider')}
        </button>
        <button
          type="button"
          className={freeOpen ? 'ghost active' : 'ghost'}
          onClick={() => setFreeOpen((value) => !value)}
        >
          {t('freeProviders')}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={anyChecking}
          onClick={() =>
            void api
              .checkAllModels()
              .then(() => setTimeout(() => void load(), 1500))
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : t('error')),
              )
          }
        >
          {anyChecking ? t('capChecking') : t('capCheckAll')}
        </button>
      </div>
      {freeOpen && (
        <FreeCatalogView
          canRefresh={!personal}
          onPick={(item) => {
            setFreeOpen(false);
            setTouched({ kind: true, baseUrl: true, name: true });
            setFound(null);
            setEditing({
              name: item.name,
              kind: item.kind,
              baseUrl: item.baseUrl,
              models: item.models.map((model) => model.id),
              enabled: true,
              apiKey: '',
            });
          }}
        />
      )}
      {personal && <p className="hint">{t('myModelsHint')}</p>}
      {error && <p className="error-line">{error}</p>}
      {testNote && <p className="note">{testNote}</p>}
      {editing && (
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            {t('providerName')}
            <input
              value={editing.name}
              onChange={(event) => {
                setTouched((current) => ({ ...current, name: true }));
                setEditing({ ...editing, name: event.target.value });
              }}
              required
            />
          </label>
          <label>
            {t('providerKind')}
            <select
              value={editing.kind}
              onChange={(event) => {
                setTouched((current) => ({ ...current, kind: true }));
                setEditing(
                  applyKindPreset(editing, event.target.value as ProviderKind),
                );
              }}
            >
              {KINDS.filter((kind) => !personal || kind !== 'mock').map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {kindLabel(kind, t)}
                  </option>
                ),
              )}
            </select>
          </label>
          {editing.kind === 'openai' && (
            <p className="hint">{t('openaiHint')}</p>
          )}
          {editing.kind === 'deepseek' && (
            <p className="hint">{t('deepseekHint')}</p>
          )}
          {editing.kind !== 'mock' && (
            <>
              <label>
                {t('baseUrl')}
                <input
                  value={editing.baseUrl ?? ''}
                  placeholder={placeholderUrl(editing.kind)}
                  onChange={(event) => {
                    setTouched((current) => ({ ...current, baseUrl: true }));
                    setEditing({ ...editing, baseUrl: event.target.value });
                  }}
                />
              </label>
              <label>
                {t('apiKey')}
                <input
                  type="password"
                  autoComplete="off"
                  value={editing.apiKey ?? ''}
                  placeholder={editing.hasApiKey ? '••••••' : ''}
                  onChange={(event) =>
                    setEditing({ ...editing, apiKey: event.target.value })
                  }
                />
              </label>
              <p className="hint">
                {editing.hasApiKey ? t('apiKeySaved') : t('apiKeyHint')}{' '}
                {!touched.kind &&
                  keyValue.length >= 6 &&
                  guessProvidersFromKey(keyValue)[0] && (
                    <span className="detected">
                      {t('detectedAs')}:{' '}
                      {guessProvidersFromKey(keyValue)
                        .map((item) => item.name)
                        .join(' / ')}
                    </span>
                  )}
              </p>
            </>
          )}
          <label>
            {t('models')}
            <textarea
              rows={3}
              value={(editing.models ?? []).join('\n')}
              onChange={(event) => {
                const models = event.target.value.split('\n');
                let next = { ...editing, models };
                // Своя модель без ключа: тип провайдера угадываем по имени модели.
                if (!touched.kind && !keyValue && !editing.id) {
                  const guess = models
                    .map(guessProviderFromModel)
                    .find(Boolean);
                  if (guess) {
                    const keepName =
                      touched.name ||
                      (next.name.trim() !== '' &&
                        next.name !== autoName.current);
                    if (!keepName) autoName.current = guess.name;
                    next = {
                      ...next,
                      kind: guess.kind,
                      baseUrl: touched.baseUrl ? next.baseUrl : guess.baseUrl,
                      name: keepName ? next.name : guess.name,
                    };
                  }
                }
                setEditing(next);
              }}
              onBlur={() => {
                if (!keyValue && !editing.hasApiKey && !editing.id)
                  void runDiscover(editing, touched);
              }}
            />
          </label>
          <p className="hint">{t('modelsHint')}</p>
          <div className="row-actions">
            <button
              type="button"
              className="ghost slim"
              disabled={discovering}
              onClick={() => void runDiscover(editing, touched)}
            >
              {discovering ? t('modelsLoading') : t('loadModels')}
            </button>
            {found?.keyFrom && !keyValue && !editing.hasApiKey && (
              <span className="hint">
                {t('keyFrom')} «{found.keyFrom.name}»
              </span>
            )}
            {found?.error && <span className="fault">{found.error}</span>}
            {found?.failed?.some((model) =>
              (editing.models ?? []).map((item) => item.trim()).includes(model),
            ) && (
              <button
                type="button"
                className="ghost slim"
                onClick={() =>
                  setEditing({
                    ...editing,
                    models: (editing.models ?? [])
                      .map((item) => item.trim())
                      .filter((item) => item && !found.failed?.includes(item)),
                  })
                }
              >
                {t('keepWorking')}
              </button>
            )}
          </div>
          {found?.failed && found.failed.length > 0 && (
            <p className="hint">
              {t('modelsFailed')}: {found.failed.join(', ')}
            </p>
          )}
          {found?.verified && found.models.length > 0 && (
            <div className="model-chips">
              {found.models.map((model) => {
                const on = (editing.models ?? [])
                  .map((item) => item.trim())
                  .includes(model);
                return (
                  <button
                    key={model}
                    type="button"
                    className={[
                      'chip',
                      on ? 'on' : '',
                      found.working?.includes(model) ? 'ok' : '',
                      found.failed?.includes(model) ? 'bad' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    title={
                      found.failed?.includes(model)
                        ? t('modelFailed')
                        : found.working?.includes(model)
                          ? t('modelWorks')
                          : undefined
                    }
                    onClick={() => toggleModel(model)}
                  >
                    {found.working?.includes(model)
                      ? '✓ '
                      : found.failed?.includes(model)
                        ? '✕ '
                        : ''}
                    {model}
                  </button>
                );
              })}
            </div>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={editing.enabled !== false}
              onChange={(event) =>
                setEditing({ ...editing, enabled: event.target.checked })
              }
            />
            {t('enabled')}
          </label>
          <div className="row-actions">
            <button className="primary-btn" type="submit">
              {t('save')}
            </button>
            <button
              className="ghost"
              type="button"
              onClick={() => setEditing(null)}
            >
              {t('cancel')}
            </button>
          </div>
        </form>
      )}
      {providers.length === 0 && <p className="muted">{t('noProviders')}</p>}
      <ul className="stack">
        {providers.map((provider) => (
          <li key={provider.id} className="card">
            <div className="card-top">
              <div>
                <strong>{provider.name}</strong>
                <p className="muted">
                  {kindLabel(provider.kind, t)}
                  {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
                </p>
              </div>
              <span className={provider.enabled ? 'pill on' : 'pill'}>
                {provider.enabled ? t('enabled') : t('statusDisconnected')}
              </span>
            </div>
            {shareModels ? (
              <div className="model-shares">
                {provider.models.length === 0 && <p className="models">—</p>}
                {provider.models.map((model) => {
                  const shared = provider.managerModels.includes(model);
                  return (
                    <label key={model} className="check">
                      <input
                        type="checkbox"
                        checked={shared}
                        onChange={() =>
                          void toggleShared(
                            providers,
                            provider.id,
                            model,
                            !shared,
                          )
                            .then(() => load())
                            .then(() => onChanged())
                            .catch((reason: unknown) =>
                              setError(
                                reason instanceof Error
                                  ? reason.message
                                  : t('error'),
                              ),
                            )
                        }
                      />
                      <span>
                        {model}
                        <em>{t('shareModel')}</em>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="models">{provider.models.join(', ') || '—'}</p>
            )}
            <CapsLine provider={provider} />
            {provider.kind !== 'mock' && (
              <p className="hint avail-line">
                {provider.needsKey && !provider.hasApiKey
                  ? t('capNeedKey')
                  : `${t('capInChat')}: ${availableCount(provider)} / ${provider.models.length}`}
                {provider.checking ? ` · ${t('capChecking')}` : ''}
              </p>
            )}
            <div className="row-actions">
              <button
                type="button"
                className="ghost slim"
                onClick={() => {
                  setTouched({ kind: true, baseUrl: true, name: true });
                  setFound(null);
                  setEditing({
                    id: provider.id,
                    name: provider.name,
                    kind: provider.kind,
                    baseUrl: provider.baseUrl,
                    models: provider.models,
                    enabled: provider.enabled,
                    apiKey: '',
                    hasApiKey: provider.hasApiKey,
                  });
                }}
              >
                {t('edit')}
              </button>
              <button
                type="button"
                className="ghost slim"
                disabled={testing}
                onClick={() => void test(provider.id)}
              >
                {testing ? t('testing') : t('test')}
              </button>
              <button
                type="button"
                className="ghost slim"
                disabled={provider.checking}
                onClick={() =>
                  void api
                    .checkModels(provider.id)
                    .then(() => load())
                    .catch((reason: unknown) =>
                      setError(
                        reason instanceof Error ? reason.message : t('error'),
                      ),
                    )
                }
              >
                {provider.checking ? t('capChecking') : t('capCheck')}
              </button>
              <button
                type="button"
                className="ghost slim danger-text"
                onClick={() =>
                  void api.deleteProvider(provider.id).then(() => {
                    void load();
                    onChanged();
                  })
                }
              >
                {t('delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function McpPanel({ personal = false }: { personal?: boolean }) {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServerPublic[]>([]);
  const [configText, setConfigText] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<McpServerInput>({
    name: '',
    transport: personal ? 'http' : 'stdio',
    command: 'node',
    args: [],
    url: '',
    enabled: true,
  });

  const load = useCallback(async () => {
    if (personal) {
      setServers((await api.mcp()).filter((row) => row.owned));
      return;
    }
    const [list, file] = await Promise.all([api.mcp(), api.mcpConfig()]);
    setServers(list);
    setConfigText(JSON.stringify(file, null, 2));
  }, [personal]);
  useEffect(() => {
    void load().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : t('error')),
    );
  }, [load, t]);

  async function createServer() {
    setError('');
    try {
      await api.createMcp({
        ...form,
        name: form.name.trim(),
        args: (form.args ?? []).map((arg) => arg.trim()).filter(Boolean),
        enabled: form.enabled !== false,
      });
      setOpen(false);
      setForm({
        name: '',
        transport: personal ? 'http' : 'stdio',
        command: 'node',
        args: [],
        url: '',
        enabled: true,
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <button
          type="button"
          className="primary-btn"
          onClick={() => setOpen((value) => !value)}
        >
          {t('addMcp')}
        </button>
      </div>
      {error && <p className="error-line">{error}</p>}
      {open && (
        <form
          className="card form"
          onSubmit={(event) => {
            event.preventDefault();
            void createServer();
          }}
        >
          <label>
            {t('mcpName')}
            <input
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              required
            />
          </label>
          {personal && <p className="hint">{t('mcpPersonalHint')}</p>}
          <label hidden={personal}>
            {t('transport')}
            <select
              value={form.transport}
              onChange={(event) =>
                setForm({
                  ...form,
                  transport: event.target.value === 'http' ? 'http' : 'stdio',
                })
              }
            >
              <option value="stdio">stdio</option>
              <option value="http">Streamable HTTP</option>
            </select>
          </label>
          {form.transport === 'stdio' ? (
            <>
              <label>
                {t('command')}
                <input
                  value={form.command ?? ''}
                  onChange={(event) =>
                    setForm({ ...form, command: event.target.value })
                  }
                />
              </label>
              <label>
                {t('args')}
                <textarea
                  rows={3}
                  placeholder={t('argsHint')}
                  value={(form.args ?? []).join('\n')}
                  onChange={(event) =>
                    setForm({ ...form, args: event.target.value.split('\n') })
                  }
                />
              </label>
              <label>
                {t('env')}
                <textarea
                  rows={3}
                  placeholder={t('envHint')}
                  onChange={(event) =>
                    setForm({ ...form, env: parsePairs(event.target.value) })
                  }
                />
              </label>
            </>
          ) : (
            <>
              <p className="hint">{t('mcpHttpHint')}</p>
              <label>
                {t('url')}
                <input
                  value={form.url ?? ''}
                  placeholder={
                    personal
                      ? 'https://example.com/mcp'
                      : 'http://127.0.0.1:3000/mcp'
                  }
                  onChange={(event) =>
                    setForm({ ...form, url: event.target.value })
                  }
                />
              </label>
              <label>
                {t('headers')}
                <textarea
                  rows={3}
                  placeholder={t('headersHint')}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      headers: parsePairs(event.target.value),
                    })
                  }
                />
              </label>
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={form.enabled !== false}
              onChange={(event) =>
                setForm({ ...form, enabled: event.target.checked })
              }
            />
            {t('enabled')}
          </label>
          <div className="row-actions">
            <button className="primary-btn" type="submit">
              {t('save')}
            </button>
          </div>
        </form>
      )}
      <ul className="stack">
        {servers.map((server) => (
          <li key={server.id} className="card">
            <div className="card-top">
              <div>
                <strong>{server.name}</strong>
                <p className="muted">
                  {server.transport === 'http'
                    ? server.url
                    : `${server.command} ${server.args.join(' ')}`}
                </p>
              </div>
              <span
                className={`pill ${server.status === 'connected' ? 'on' : server.status === 'error' ? 'bad' : ''}`}
              >
                {statusLabel(server.status, t)}
              </span>
            </div>
            {server.error && <pre className="fault">{server.error}</pre>}
            <p className="hint">
              {t('tools')}:{' '}
              {server.tools.length
                ? server.tools.map((tool) => tool.name).join(', ')
                : t('noTools')}
            </p>
            <div className="row-actions">
              <label className="check">
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={(event) =>
                    void api
                      .updateMcp(server.id, { enabled: event.target.checked })
                      .then(load)
                  }
                />
                {t('enabled')}
              </label>
              {!personal &&
                !server.owned &&
                !/avito|авито|moysklad|мой[ _-]?склад/i.test(server.name) && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={Boolean(server.forManagers)}
                      onChange={(event) =>
                        void api
                          .updateMcp(server.id, {
                            forManagers: event.target.checked,
                          } as never)
                          .then(load)
                      }
                    />
                    {t('mcpForManagers')}
                  </label>
                )}
              <button
                type="button"
                className="ghost slim danger-text"
                onClick={() => void api.deleteMcp(server.id).then(load)}
              >
                {t('delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form
        className="card form"
        hidden={personal}
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          try {
            const parsed = JSON.parse(configText) as unknown;
            void api
              .importMcp(parsed as Parameters<typeof api.importMcp>[0])
              .then(load)
              .catch((reason: unknown) =>
                setError(reason instanceof Error ? reason.message : t('error')),
              );
          } catch {
            setError(t('error'));
          }
        }}
      >
        <label>
          {t('importJson')}
          <textarea
            rows={12}
            value={configText}
            spellCheck={false}
            onChange={(event) => setConfigText(event.target.value)}
          />
        </label>
        <p className="hint">{t('importHint')}</p>
        <button className="primary-btn" type="submit">
          {t('importAction')}
        </button>
      </form>
    </div>
  );
}

function SkillsPanel() {
  const { t } = useI18n();
  const [directory, setDirectory] = useState('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [current, setCurrent] = useState<Skill | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const data = await api.skills();
    setDirectory(data.directory);
    setSkills(data.skills);
  }, []);
  useEffect(() => {
    void load().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : t('error')),
    );
  }, [load, t]);

  async function open(name: string) {
    setNote('');
    setCurrent(await api.skill(name));
  }

  async function save() {
    if (!current) return;
    setError('');
    try {
      const saved = await api.saveSkill(current);
      setCurrent(saved);
      setNote(t('saved'));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    }
  }

  return (
    <div className="skills">
      <div>
        <button
          type="button"
          className="primary-btn"
          onClick={() =>
            setCurrent({ name: '', description: '', enabled: true, body: '' })
          }
        >
          {t('addSkill')}
        </button>
        <p className="hint">
          {t('skillDir')}: <code>{directory}</code>
        </p>
        <ul className="stack">
          {skills.map((skill) => (
            <li key={skill.name}>
              <button
                type="button"
                className={
                  current?.name === skill.name
                    ? 'skill-link active'
                    : 'skill-link'
                }
                onClick={() => void open(skill.name)}
              >
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
                {!skill.enabled && <em>{t('statusDisconnected')}</em>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        {error && <p className="error-line">{error}</p>}
        {!current && <p className="muted">{t('skillEmpty')}</p>}
        {current && (
          <form
            className="card form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              {t('skillName')}
              <input
                value={current.name}
                onChange={(event) =>
                  setCurrent({ ...current, name: event.target.value })
                }
                required
              />
            </label>
            <label>
              {t('skillDescription')}
              <input
                value={current.description}
                onChange={(event) =>
                  setCurrent({ ...current, description: event.target.value })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={current.enabled}
                onChange={(event) =>
                  setCurrent({ ...current, enabled: event.target.checked })
                }
              />
              {t('skillEnabled')}
            </label>
            <label>
              {t('skillBody')}
              <textarea
                rows={14}
                value={current.body}
                onChange={(event) =>
                  setCurrent({ ...current, body: event.target.value })
                }
              />
            </label>
            <div className="row-actions">
              <button className="primary-btn" type="submit">
                {t('save')}
              </button>
              {current.name && (
                <button
                  className="ghost danger-text"
                  type="button"
                  onClick={() =>
                    void api.deleteSkill(current.name).then(() => {
                      setCurrent(null);
                      return load();
                    })
                  }
                >
                  {t('delete')}
                </button>
              )}
              {note && <span className="note">{note}</span>}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ImagesPanel() {
  const { t } = useI18n();
  const [data, setData] = useState<Awaited<
    ReturnType<typeof api.imageSettings>
  > | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => setData(await api.imageSettings()), []);
  useEffect(() => {
    void load().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : t('error')),
    );
  }, [load, t]);
  if (!data) return null;
  const save = async (patch: Parameters<typeof api.saveImageSettings>[0]) => {
    setError('');
    setSaved(false);
    try {
      await api.saveImageSettings(patch);
      await load();
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    }
  };
  return (
    <div className="panel card form">
      <h3>
        {t('imagesTitle')}{' '}
        <span className={data.enabled ? 'pill on' : 'pill'}>
          {data.enabled ? t('moyskladConnected') : t('moyskladOff')}
        </span>
      </h3>
      <p className="hint">{t('imagesLead')}</p>
      {data.providers.length === 0 ? (
        <p className="fault">{t('imagesNoProvider')}</p>
      ) : (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={data.enabled}
              onChange={(event) => void save({ enabled: event.target.checked })}
            />
            {t('imagesEnabled')}
          </label>
          <label>
            {t('imagesProvider')}
            <select
              value={data.providerId ?? ''}
              onChange={(event) =>
                void save({ providerId: event.target.value })
              }
            >
              {data.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('imagesModel')}
            <select
              value={data.model}
              onChange={(event) => void save({ model: event.target.value })}
            >
              {[
                'gpt-image-2',
                'gpt-image-1.5',
                'gpt-image-1',
                'gpt-image-1-mini',
              ].map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('imagesQuality')}
            <select
              value={data.quality}
              onChange={(event) => void save({ quality: event.target.value })}
            >
              <option value="low">{t('qualityLow')}</option>
              <option value="medium">{t('qualityMedium')}</option>
              <option value="high">{t('qualityHigh')}</option>
              <option value="auto">auto</option>
            </select>
          </label>
          <label>
            {t('imagesLimit')}
            <input
              type="number"
              min={1}
              max={1000}
              defaultValue={data.dailyLimit}
              onBlur={(event) => {
                const next = Number(event.target.value);
                if (next !== data.dailyLimit && next >= 1)
                  void save({ dailyLimit: next });
              }}
            />
          </label>
          <p className="hint">
            {t('imagesUsed')}: {data.usedToday}
          </p>
        </>
      )}
      {saved && <p className="note">{t('saved')}</p>}
      {error && <p className="fault">{error}</p>}
    </div>
  );
}

function MoyskladPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<{
    connected: boolean;
    account?: string;
    error?: string;
  } | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void api
      .moysklad()
      .then(setStatus)
      .catch(() => setStatus({ connected: false }));
  }, []);
  async function save(next: string) {
    setBusy(true);
    setError('');
    try {
      setStatus(await api.saveMoysklad(next));
      setToken('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="panel card form"
      onSubmit={(event) => {
        event.preventDefault();
        void save(token);
      }}
    >
      <h3>
        {t('moyskladTitle')}{' '}
        <span className={status?.connected ? 'pill on' : 'pill'}>
          {status?.connected
            ? `${t('moyskladConnected')}${status.account ? ` · ${status.account}` : ''}`
            : t('moyskladOff')}
        </span>
      </h3>
      <p className="hint">{t('moyskladLead')}</p>
      <label>
        {t('moyskladToken')}
        <input
          type="password"
          autoComplete="off"
          value={token}
          placeholder={status?.connected ? '••••••' : ''}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      {(error || status?.error) && (
        <p className="fault">{error || status?.error}</p>
      )}
      <div className="row-actions">
        <button
          className="primary-btn"
          type="submit"
          disabled={busy || !token.trim()}
        >
          {t('moyskladSave')}
        </button>
        {status?.connected && (
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void save('')}
          >
            {t('moyskladDisconnect')}
          </button>
        )}
      </div>
    </form>
  );
}

function GeneralPanel() {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useTheme();
  return (
    <div className="panel card form">
      <p>{t('generalLead')}</p>
      <label>
        {t('language')}
        <select
          value={locale}
          onChange={(event) =>
            setLocale(event.target.value === 'en' ? 'en' : 'ru')
          }
        >
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </select>
      </label>
      <label>
        {t('theme')}
        <select
          value={theme}
          onChange={(event) =>
            setTheme(event.target.value === 'light' ? 'light' : 'dark')
          }
        >
          <option value="dark">{t('themeDark')}</option>
          <option value="light">{t('themeLight')}</option>
        </select>
      </label>
    </div>
  );
}

function kindLabel(
  kind: ProviderKind,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (kind === 'deepseek') return t('kindDeepSeek');
  if (kind === 'anthropic') return t('kindAnthropic');
  if (kind === 'gemini') return t('kindGemini');
  if (kind === 'mock') return t('kindMock');
  return t('kindOpenAI');
}

function applyKindPreset(
  current: ProviderInput & { id?: string; hasApiKey?: boolean },
  kind: ProviderKind,
): ProviderInput & { id?: string; hasApiKey?: boolean } {
  if (kind !== 'deepseek') return { ...current, kind };
  return {
    ...current,
    kind,
    name: current.name.trim() ? current.name : 'DeepSeek',
    baseUrl: DEEPSEEK_BASE_URL,
    models: [...DEEPSEEK_MODELS],
  };
}

function placeholderUrl(kind: ProviderKind): string {
  if (kind === 'deepseek') return DEEPSEEK_BASE_URL;
  if (kind === 'anthropic') return 'https://api.anthropic.com';
  if (kind === 'gemini')
    return 'https://generativelanguage.googleapis.com/v1beta';
  return 'https://api.openai.com/v1';
}

function statusLabel(
  status: McpServerPublic['status'],
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (status === 'connected') return t('statusConnected');
  if (status === 'error') return t('statusError');
  if (status === 'connecting') return t('statusConnecting');
  return t('statusDisconnected');
}

function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}
