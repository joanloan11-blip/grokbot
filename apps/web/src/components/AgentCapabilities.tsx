import {
  AGENT_PLUGINS,
  type McpServerPublic,
  type SkillSummary,
} from '@mayak/shared';
import { useI18n } from '../i18n';

/** Три раздела настроек агента: навыки, коннекторы (MCP) и плагины (встроенные инструменты). */
export function AgentCapabilities({
  skills,
  servers,
  skillNames,
  mcpServerIds,
  plugins,
  restricted,
  onSkills,
  onServers,
  onPlugins,
}: {
  skills: SkillSummary[];
  servers: McpServerPublic[];
  skillNames: string[];
  mcpServerIds: string[];
  /** null — включены все плагины. */
  plugins: string[] | null;
  /** Менеджер: коннекторы подключает администратор. */
  restricted?: boolean;
  onSkills: (next: string[]) => void;
  onServers: (next: string[]) => void;
  onPlugins: (next: string[] | null) => void;
}) {
  const { t } = useI18n();
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((item) => item !== id);
  const visiblePlugins = AGENT_PLUGINS.filter(
    (plugin) => !restricted || (plugin.id !== 'stock' && plugin.id !== 'skills'),
  );
  const allPlugins = visiblePlugins.map((plugin) => plugin.id as string);
  const activePlugins = plugins ?? allPlugins;
  return (
    <div className="caps">
      <section className="caps-section">
        <header>
          <strong>🧩 {t('capsSkills')}</strong>
          <small className="muted">{t('capsSkillsHint')}</small>
        </header>
        {skills.length === 0 && <p className="muted">{t('capsNone')}</p>}
        <div className="caps-grid">
          {skills.map((skill) => (
            <label key={skill.name} className="cap-card">
              <input
                type="checkbox"
                checked={skillNames.includes(skill.name)}
                onChange={(event) =>
                  onSkills(toggle(skillNames, skill.name, event.target.checked))
                }
              />
              <span>
                <strong>{skill.name}</strong>
                <small>{skill.description}</small>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="caps-section">
        <header>
          <strong>🔌 {t('capsConnectors')}</strong>
          <small className="muted">
            {restricted ? t('capsConnectorsAdmin') : t('capsConnectorsHint')}
          </small>
        </header>
        {servers.length === 0 && <p className="muted">{t('capsNone')}</p>}
        {
          <div className="caps-grid">
            {servers.map((server) => (
              <label key={server.id} className="cap-card">
                <input
                  type="checkbox"
                  checked={mcpServerIds.includes(server.id)}
                  disabled={!server.enabled}
                  onChange={(event) =>
                    onServers(
                      toggle(mcpServerIds, server.id, event.target.checked),
                    )
                  }
                />
                <span>
                  <strong>
                    {server.name}
                    <i
                      className={
                        server.status === 'connected' ? 'dot on' : 'dot'
                      }
                    />
                  </strong>
                  <small>
                    {server.tools.length} {t('capsTools')}
                    {server.status !== 'connected' && ` · ${server.status}`}
                  </small>
                </span>
              </label>
            ))}
          </div>
        }
        {mcpServerIds.length > 2 && (
          <p className="hint">{t('capsManyConnectors')}</p>
        )}
      </section>

      <section className="caps-section">
        <header>
          <strong>🧰 {t('capsPlugins')}</strong>
          <small className="muted">{t('capsPluginsHint')}</small>
        </header>
        <div className="caps-grid">
          {visiblePlugins.map((plugin) => (
            <label key={plugin.id} className="cap-card">
              <input
                type="checkbox"
                checked={activePlugins.includes(plugin.id)}
                onChange={(event) => {
                  const next = toggle(
                    activePlugins,
                    plugin.id,
                    event.target.checked,
                  );
                  onPlugins(next.length === allPlugins.length ? null : next);
                }}
              />
              <span>
                <strong>
                  {plugin.emoji} {plugin.name}
                </strong>
                <small>{plugin.description}</small>
              </span>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
