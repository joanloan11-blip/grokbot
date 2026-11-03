import { useCallback, useEffect, useState } from 'react';
import type {
  GithubPreview,
  GithubRepoInfo,
  GithubStatus,
} from '@mayak/shared';
import { api } from '../api';
import { useI18n } from '../i18n';

export function GithubPane() {
  const { t } = useI18n();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [token, setToken] = useState('');
  const [repos, setRepos] = useState<GithubRepoInfo[]>([]);
  const [repo, setRepo] = useState('');
  const [preview, setPreview] = useState<GithubPreview | null>(null);
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [enable, setEnable] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const next = await api.githubStatus();
    setStatus(next);
    if (next.connected) {
      setRepos(await api.githubRepos().catch(() => []));
    } else {
      setRepos([]);
    }
  }, []);

  useEffect(() => {
    void load().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : t('error')),
    );
  }, [load, t]);

  async function saveToken() {
    setError('');
    setNote('');
    try {
      setStatus(await api.saveGithubToken(token));
      setToken('');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    }
  }

  async function inspect(target: string) {
    setError('');
    setNote('');
    try {
      const next = await api.previewGithub(target);
      setPreview(next);
      setCommand(next.command);
      setArgs(next.args.join('\n'));
      setSkills(next.skills.map((item) => item.name));
      setEnable(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    }
  }

  async function confirm() {
    if (!preview) return;
    setError('');
    try {
      const result = await api.confirmGithub({
        id: preview.id,
        confirm: true,
        command,
        args: args
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        name: preview.repo.split('/')[1],
        enabled: enable,
        skillNames: skills,
      });
      setNote(
        `${result.server.name}${result.skills.length ? `, навыки: ${result.skills.join(', ')}` : ''}`,
      );
      setPreview(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    }
  }

  return (
    <div className="stack">
      <p className="muted">{t('githubLead')}</p>
      {status?.connected && (
        <p>
          {t('githubConnected')}{' '}
          <strong>{status.login ? `@${status.login}` : '…'}</strong>
        </p>
      )}
      {status?.error && <p className="fault">{status.error}</p>}
      <form
        className="form card"
        onSubmit={(event) => {
          event.preventDefault();
          void saveToken();
        }}
      >
        <label>
          {t('githubToken')}
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <div className="row-actions">
          <button className="primary-btn" type="submit">
            {t('githubSave')}
          </button>
          {status?.oauth && (
            <button
              className="ghost"
              type="button"
              onClick={() =>
                void api
                  .githubOauthUrl()
                  .then((result) => {
                    window.location.href = result.url;
                  })
                  .catch((reason: unknown) =>
                    setError(
                      reason instanceof Error ? reason.message : t('error'),
                    ),
                  )
              }
            >
              {t('githubOauth')}
            </button>
          )}
          {status?.connected && (
            <button
              className="ghost"
              type="button"
              onClick={() =>
                void api
                  .disconnectGithub()
                  .then((next) => {
                    setStatus(next);
                    setRepos([]);
                  })
                  .catch((reason: unknown) =>
                    setError(
                      reason instanceof Error ? reason.message : t('error'),
                    ),
                  )
              }
            >
              {t('githubDisconnect')}
            </button>
          )}
        </div>
      </form>
      {status?.connected && (
        <form
          className="form card"
          onSubmit={(event) => {
            event.preventDefault();
            void inspect(repo);
          }}
        >
          <label>
            {t('githubRepo')}
            <input
              value={repo}
              placeholder="https://github.com/owner/repo"
              onChange={(event) => setRepo(event.target.value)}
            />
          </label>
          {repos.length > 0 && (
            <label>
              {t('githubRepos')}
              <select
                value=""
                onChange={(event) => {
                  setRepo(event.target.value);
                  if (event.target.value) void inspect(event.target.value);
                }}
              >
                <option value="">—</option>
                {repos.map((item) => (
                  <option key={item.fullName} value={item.fullName}>
                    {item.fullName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="ghost" type="submit">
            {t('githubPreview')}
          </button>
        </form>
      )}
      {preview && (
        <form
          className="form card"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <strong>
            {preview.repo} · {preview.kind}
          </strong>
          <p className="muted">{preview.summary}</p>
          <label>
            {t('command')}
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <label>
            {t('args')}
            <textarea
              rows={4}
              value={args}
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
          {preview.skills.map((skill) => (
            <label key={skill.name} className="check">
              <input
                type="checkbox"
                checked={skills.includes(skill.name)}
                onChange={(event) =>
                  setSkills((current) =>
                    event.target.checked
                      ? [...current, skill.name]
                      : current.filter((item) => item !== skill.name),
                  )
                }
              />
              {skill.name}
              {skill.description ? ` — ${skill.description}` : ''}
            </label>
          ))}
          <label className="check">
            <input
              type="checkbox"
              checked={enable}
              onChange={(event) => setEnable(event.target.checked)}
            />
            {t('githubEnable')}
          </label>
          <button className="primary-btn" type="submit">
            {t('githubConfirm')}
          </button>
        </form>
      )}
      {status?.connected && (
        <div className="row-actions">
          <button
            className="ghost"
            type="button"
            onClick={() =>
              void api
                .officialGithub('http')
                .then((server) => setNote(server.name))
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error ? reason.message : t('error'),
                  ),
                )
            }
          >
            {t('githubOfficialHttp')}
          </button>
          <button
            className="ghost"
            type="button"
            onClick={() =>
              void api
                .officialGithub('docker')
                .then((server) => setNote(server.name))
                .catch((reason: unknown) =>
                  setError(
                    reason instanceof Error ? reason.message : t('error'),
                  ),
                )
            }
          >
            {t('githubOfficialDocker')}
          </button>
        </div>
      )}
      {note && <p className="muted">{note}</p>}
      {error && <p className="fault">{error}</p>}
    </div>
  );
}
