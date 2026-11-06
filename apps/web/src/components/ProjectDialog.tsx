import { useState } from 'react';
import type { Project } from '@mayak/shared';
import { api } from '../api';
import { useI18n } from '../i18n';

/** Создание и правка проекта (клиент, сделка, задача). */
export function ProjectDialog({
  project,
  onClose,
  onSaved,
  onDeleted,
}: {
  project: Project | null;
  onClose: () => void;
  onSaved: (project: Project) => void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(project?.name ?? '');
  const [client, setClient] = useState(project?.client ?? '');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const saved = project
        ? await api.updateProject(project.id, { name, client, instructions })
        : await api.createProject({ name, client, instructions });
      onSaved(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" role="presentation" onClick={onClose}>
      <form
        className="card form project-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2>{project ? t('projectEdit') : t('projectNew')}</h2>
        <label>
          {t('projectName')}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          {t('projectClient')}
          <input
            value={client}
            placeholder={t('projectClientHint')}
            onChange={(event) => setClient(event.target.value)}
          />
        </label>
        <label>
          {t('projectInstructions')}
          <textarea
            rows={6}
            value={instructions}
            placeholder={t('projectInstructionsHint')}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <p className="hint">{t('projectHint')}</p>
        {error && <p className="fault">{error}</p>}
        <div className="row-actions">
          <button className="primary-btn" type="submit" disabled={busy}>
            {t('save')}
          </button>
          <button className="ghost" type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          {project && (
            <button
              type="button"
              className={confirm ? 'danger' : 'ghost danger-text'}
              onClick={() => {
                if (!confirm) {
                  setConfirm(true);
                  return;
                }
                void api
                  .deleteProject(project.id)
                  .then(() => onDeleted(project.id));
              }}
            >
              {confirm ? t('projectDeleteConfirm') : t('delete')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
