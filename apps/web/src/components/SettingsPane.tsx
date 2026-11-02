import { useCallback, useEffect, useState } from 'react';
import type {
  McpServerInput,
  McpServerPublic,
  ProviderInput,
  ProviderKind,
  ProviderPublic,
  Skill,
  SkillSummary,
} from '@mayak/shared';
import { api } from '../api';
import { useI18n, useTheme } from '../i18n';
import { IconMenu } from './icons';

export type SettingsTab = 'providers' | 'mcp' | 'skills' | 'general';

const KINDS: ProviderKind[] = ['openai', 'anthropic', 'gemini', 'mock'];

export function SettingsPane({
  tab,
  onTab,
  onMenu,
  onProvidersChanged,
}: {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onMenu: () => void;
  onProvidersChanged: () => void;
}) {
  const { t } = useI18n();
  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'providers', label: t('tabProviders') },
    { id: 'mcp', label: t('tabMcp') },
    { id: 'skills', label: t('tabSkills') },
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
          <ProvidersPanel onChanged={onProvidersChanged} />
        )}
        {tab === 'mcp' && <McpPanel />}
        {tab === 'skills' && <SkillsPanel />}
        {tab === 'general' && <GeneralPanel />}
      </div>
    </section>
  );
}

function ProvidersPanel({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderPublic[]>([]);
  const [editing, setEditing] = useState<
    (ProviderInput & { id?: string; hasApiKey?: boolean }) | null
  >(null);
  const [error, setError] = useState('');
  const [testNote, setTestNote] = useState('');
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setProviders(await api.providers());
  }, []);
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
    try {
      if (editing.id) await api.updateProvider(editing.id, payload);
      else await api.createProvider(payload);
      setEditing(null);
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
          onClick={() =>
            setEditing({
              name: '',
              kind: 'openai',
              baseUrl: 'https://api.openai.com/v1',
              models: [''],
              enabled: true,
              apiKey: '',
            })
          }
        >
          {t('addProvider')}
        </button>
      </div>
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
              onChange={(event) =>
                setEditing({ ...editing, name: event.target.value })
              }
              required
            />
          </label>
          <label>
            {t('providerKind')}
            <select
              value={editing.kind}
              onChange={(event) =>
                setEditing({
                  ...editing,
                  kind: event.target.value as ProviderKind,
                })
              }
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(kind, t)}
                </option>
              ))}
            </select>
          </label>
          {editing.kind === 'openai' && (
            <p className="hint">{t('openaiHint')}</p>
          )}
          {editing.kind !== 'mock' && (
            <>
              <label>
                {t('baseUrl')}
                <input
                  value={editing.baseUrl ?? ''}
                  placeholder={placeholderUrl(editing.kind)}
                  onChange={(event) =>
                    setEditing({ ...editing, baseUrl: event.target.value })
                  }
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
                {editing.hasApiKey ? t('apiKeySaved') : t('apiKeyHint')}
              </p>
            </>
          )}
          <label>
            {t('models')}
            <textarea
              rows={3}
              value={(editing.models ?? []).join('\n')}
              onChange={(event) =>
                setEditing({
                  ...editing,
                  models: event.target.value.split('\n'),
                })
              }
            />
          </label>
          <p className="hint">{t('modelsHint')}</p>
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
            <p className="models">{provider.models.join(', ') || '—'}</p>
            <div className="row-actions">
              <button
                type="button"
                className="ghost slim"
                onClick={() =>
                  setEditing({
                    id: provider.id,
                    name: provider.name,
                    kind: provider.kind,
                    baseUrl: provider.baseUrl,
                    models: provider.models,
                    enabled: provider.enabled,
                    apiKey: '',
                    hasApiKey: provider.hasApiKey,
                  })
                }
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

function McpPanel() {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServerPublic[]>([]);
  const [configText, setConfigText] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<McpServerInput>({
    name: '',
    transport: 'stdio',
    command: 'node',
    args: [],
    url: '',
    enabled: true,
  });

  const load = useCallback(async () => {
    const [list, file] = await Promise.all([api.mcp(), api.mcpConfig()]);
    setServers(list);
    setConfigText(JSON.stringify(file, null, 2));
  }, []);
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
        transport: 'stdio',
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
          <label>
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
              <label>
                {t('url')}
                <input
                  value={form.url ?? ''}
                  placeholder="http://127.0.0.1:3000/mcp"
                  onChange={(event) =>
                    setForm({ ...form, url: event.target.value })
                  }
                />
              </label>
              <label>
                {t('headers')}
                <textarea
                  rows={3}
                  placeholder={t('envHint')}
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
  if (kind === 'anthropic') return t('kindAnthropic');
  if (kind === 'gemini') return t('kindGemini');
  if (kind === 'mock') return t('kindMock');
  return t('kindOpenAI');
}

function placeholderUrl(kind: ProviderKind): string {
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
