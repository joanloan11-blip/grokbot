import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AGENT_PLUGINS,
  CONNECTOR_PRESETS,
  SKILL_CATALOG,
  type Agent,
  type McpServerPublic,
  type SkillSummary,
} from '@mayak/shared';
import { api } from '../api';

/** Каталог подключает возможности к выбранному агенту, а не ко всем пользователям. */
export function CapabilityCatalog({
  kind,
  personal = false,
}: {
  kind: 'plugins' | 'skills';
  personal?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [servers, setServers] = useState<McpServerPublic[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [presetId, setPresetId] = useState('');
  const connectionDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = connectionDialog.current;
    if (!presetId || !dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [presetId]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [preview, setPreview] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    const [nextAgents, nextSkills, nextServers] = await Promise.all([
      api.agents(),
      api.skills(),
      api.mcp(),
    ]);
    const editable = nextAgents.filter((agent) =>
      personal ? Boolean(agent.ownerId) : !agent.ownerId,
    );
    setAgents(editable);
    setSkills(nextSkills.skills);
    setServers(nextServers);
    setAgentId((current) =>
      editable.some((agent) => agent.id === current)
        ? current
        : (editable[0]?.id ?? ''),
    );
  }, [personal]);
  useEffect(() => {
    void load().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : 'Не удалось загрузить каталог'),
    );
  }, [load]);
  const agent = agents.find((item) => item.id === agentId);
  const plugins = AGENT_PLUGINS.filter(
    (item) => !personal || (item.id !== 'stock' && item.id !== 'skills'),
  );
  const allPluginIds = plugins.map((item) => item.id);
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  async function toggle(kind: 'plugin' | 'skill', id: string) {
    if (!agent || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const current: string[] =
        kind === 'skill'
          ? agent.skillNames
          : (agent.plugins ?? [...allPluginIds]);
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      const updated = await api.updateAgent(
        agent.id,
        kind === 'skill' ? { skillNames: next } : { plugins: next },
      );
      setAgents((rows) =>
        rows.map((row) => (row.id === updated.id ? updated : row)),
      );
      setNotice('Настройки агента сохранены');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await api.createMcp({
        name: name.trim(),
        transport: 'http',
        url: url.trim(),
        headers: token.trim()
          ? { Authorization: `Bearer ${token.trim()}` }
          : {},
        enabled: true,
      });
      setToken('');
      setPresetId('');
      await load();
      if (agent) {
        try {
          const updated = await api.updateAgent(agent.id, {
            mcpServerIds: [...new Set([...agent.mcpServerIds, saved.id])],
          });
          setAgents((rows) =>
            rows.map((row) => (row.id === updated.id ? updated : row)),
          );
        } catch {
          setNotice(
            'Коннектор сохранён. Подключите его к агенту в настройках агента.',
          );
          return;
        }
      }
      setNotice(
        saved.status === 'connected'
          ? 'Коннектор подключён'
          : `Коннектор сохранён. ${saved.error || 'Проверьте соединение в разделе «Мои коннекторы».'}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка подключения');
    } finally {
      setBusy(false);
    }
  }
  const preset = CONNECTOR_PRESETS.find((item) => item.id === presetId);
  return (
    <div className="capability-catalog">
      <div className="catalog-top">
        <div>
          <h2>{kind === 'plugins' ? 'Плагины' : 'Навыки'}</h2>
          <p className="muted">
            {kind === 'plugins'
              ? 'Встроенные возможности и ваши подключения к внешним сервисам'
              : 'Готовые инструкции для конкретных задач — подключите их к своему агенту'}
          </p>
        </div>
        <input
          type="search"
          aria-label="Поиск в каталоге"
          placeholder={kind === 'plugins' ? 'Поиск плагинов' : 'Поиск навыков'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="form catalog-controls">
        <label>
          Агент
          <select
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">Выберите агента</option>
            {agents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.emoji} {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={installedOnly}
            onChange={(event) => setInstalledOnly(event.target.checked)}
          />
          Только подключённые
        </label>
      </div>
      {!agent && (
        <p className="hint">
          Создайте личного агента или выберите его, чтобы подключать навыки и
          встроенные возможности.
        </p>
      )}
      {error && (
        <p role="alert" className="error-line">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="hint">
          {notice}
        </p>
      )}
      {kind === 'skills' ? (
        <div className="catalog-grid">
          {skills
            .filter(
              (skill) =>
                skill.enabled &&
                matches(
                  `${skill.name} ${skill.description} ${SKILL_CATALOG.find((entry) => entry.id === skill.name)?.name ?? ''}`,
                ) &&
                (!installedOnly || agent?.skillNames.includes(skill.name)),
            )
            .map((skill) => {
              const entry = SKILL_CATALOG.find(
                (item) => item.id === skill.name,
              );
              const enabled = Boolean(agent?.skillNames.includes(skill.name));
              return (
                <article key={skill.name} className="catalog-card">
                  <span className="catalog-icon">🧩</span>
                  <div>
                    <h3>{entry?.name ?? skill.name}</h3>
                    <p>{skill.description}</p>
                    <button
                      className="ghost slim"
                      type="button"
                      onClick={() => {
                        setPreview('');
                        void api
                          .skill(skill.name)
                          .then((value) => setPreview(value.body))
                          .catch((e: unknown) =>
                            setError(e instanceof Error ? e.message : 'Ошибка'),
                          );
                      }}
                    >
                      Инструкции
                    </button>
                  </div>
                  <button
                    className={enabled ? 'ghost slim' : 'primary-btn slim'}
                    type="button"
                    disabled={!agent || busy}
                    aria-pressed={enabled}
                    onClick={() => void toggle('skill', skill.name)}
                  >
                    {enabled ? '✓ Подключён' : 'Подключить'}
                  </button>
                </article>
              );
            })}
        </div>
      ) : (
        <>
          <h3>Встроенные</h3>
          <p className="hint">
            Переключатели разрешают инструменты агенту. Некоторые возможности
            требуют настроенной модели или песочницы.
          </p>
          <div className="catalog-grid">
            {plugins
              .filter(
                (plugin) =>
                  matches(`${plugin.name} ${plugin.description}`) &&
                  (!installedOnly ||
                    (agent &&
                      (agent.plugins === null ||
                        agent.plugins?.includes(plugin.id)))),
              )
              .map((plugin) => {
                const enabled = Boolean(
                  agent &&
                    (agent.plugins == null ||
                      agent.plugins.includes(plugin.id)),
                );
                return (
                  <article className="catalog-card" key={plugin.id}>
                    <span className="catalog-icon">{plugin.emoji}</span>
                    <div>
                      <h3>{plugin.name}</h3>
                      <p>{plugin.description}</p>
                    </div>
                    <button
                      type="button"
                      className={enabled ? 'ghost slim' : 'primary-btn slim'}
                      disabled={!agent || busy}
                      aria-pressed={enabled}
                      onClick={() => void toggle('plugin', plugin.id)}
                    >
                      {enabled ? '✓ Включён' : 'Включить'}
                    </button>
                  </article>
                );
              })}
          </div>
          <h3>Подключить свой аккаунт</h3>
          <p className="hint">
            Нужен MCP-сервер сервиса (Streamable HTTP), а не обычный сайт и не
            прямой REST API. Нажмите «Настроить» — в форме будет подсказка, какой
            адрес вставить в поле «HTTPS MCP-адрес» и где взять токен. Общие
            кабинеты Авито и МойСклад доступны только администратору.
          </p>
          {!installedOnly && (
            <div className="catalog-grid">
              {CONNECTOR_PRESETS.filter((item) =>
                matches(`${item.name} ${item.description}`),
              ).map((item) => (
                <article
                  key={item.id}
                  className="catalog-card"
                  title={item.hint}
                >
                  <span className="catalog-icon">{item.emoji}</span>
                  <div>
                    <h3>{item.name}</h3>
                    <p>{item.description}</p>
                    <small>Собственный MCP-коннектор</small>
                  </div>
                  <button
                    className="ghost slim"
                    type="button"
                    onClick={() => {
                      setPresetId(item.id);
                      setName(`${item.id}-${Date.now().toString(36)}`);
                      setUrl('');
                      setToken('');
                      setError('');
                    }}
                  >
                    Настроить
                  </button>
                </article>
              ))}
            </div>
          )}
          {servers.filter((server) => matches(server.name)).length > 0 && (
            <>
              <h3>Доступные подключения</h3>
              <div className="catalog-grid">
                {servers
                  .filter(
                    (server) =>
                      matches(server.name) &&
                      (!installedOnly ||
                        agent?.mcpServerIds.includes(server.id)),
                  )
                  .map((server) => (
                    <article key={server.id} className="catalog-card">
                      <span className="catalog-icon">🔌</span>
                      <div>
                        <h3>{server.name}</h3>
                        <p>
                          {server.status === 'connected'
                            ? 'Соединение установлено'
                            : server.error || 'Нет соединения'}
                        </p>
                        <small>
                          {agent?.mcpServerIds.includes(server.id)
                            ? 'Подключён к выбранному агенту'
                            : 'Выберите в настройках агента'}
                        </small>
                      </div>
                    </article>
                  ))}
              </div>
            </>
          )}
        </>
      )}
      {kind === 'skills' &&
        skills.filter(
          (skill) =>
            skill.enabled &&
            matches(
              `${skill.name} ${skill.description} ${SKILL_CATALOG.find((entry) => entry.id === skill.name)?.name ?? ''}`,
            ) &&
            (!installedOnly || agent?.skillNames.includes(skill.name)),
        ).length === 0 && (
          <p className="muted">Навыки не найдены. Измените поиск или фильтр.</p>
        )}
      {preview && (
        <section className="card catalog-preview">
          <button
            type="button"
            className="ghost slim"
            onClick={() => setPreview('')}
          >
            Закрыть инструкции
          </button>
          <pre>{preview}</pre>
        </section>
      )}
      {preset && (
        <dialog ref={connectionDialog} className="catalog-dialog"
          aria-labelledby="connector-dialog-title"
          onCancel={() => { setPresetId(''); setToken(''); }}>
        <form
          className="card form catalog-connection"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <h3 id="connector-dialog-title">
            {preset.emoji} Подключить {preset.name}
          </h3>
          {error && <p role="alert" className="error-line">{error}</p>}
          <p className="hint">
            <strong>{preset.hint}</strong>
          </p>
          <div className="connector-help">
            <p>
              <strong>Куда что вставлять</strong>
            </p>
            <ol>
              <li>
                <strong>Название</strong> — как коннектор будет называться у
                агента, например <code>github-work</code>.
              </li>
              <li>
                <strong>HTTPS MCP-адрес</strong> — endpoint MCP-сервера
                (Streamable HTTP), обычно заканчивается на <code>/mcp</code>.
                Это не адрес сайта и не REST API.
              </li>
              <li>
                <strong>Bearer-токен</strong> — ключ сервиса, если он требует
                авторизацию. Если сервер работает без токена, оставьте пустым.
              </li>
            </ol>
            <p className="muted">
              Токен хранится зашифрованным на сервере и не возвращается в
              браузер. Проверить подключение можно в «Мои коннекторы».
            </p>
          </div>
          <label>
            Название
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            HTTPS MCP-адрес
            <input
              required
              type="url"
              placeholder={preset.urlPlaceholder}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <small className="muted">Пример: {preset.urlPlaceholder}</small>
          <label>
            {preset.tokenLabel}
            <input
              autoComplete="off"
              type="password"
              placeholder="Вставьте токен или оставьте пустым"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <small className="muted">{preset.tokenHint}</small>
          <div className="row-actions">
            <button disabled={busy} className="primary-btn" type="submit">
              {busy
                ? 'Подключение…'
                : agent
                  ? 'Подключить к агенту'
                  : 'Сохранить подключение'}
            </button>
            <button
              className="ghost"
              type="button"
              onClick={() => {
                setPresetId('');
                setToken('');
              }}
            >
              Отмена
            </button>
          </div>
        </form>
        </dialog>
      )}
    </div>
  );
}
