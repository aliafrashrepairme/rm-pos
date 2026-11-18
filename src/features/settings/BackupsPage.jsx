import { useCallback, useEffect, useState } from 'react';
import { api, apiFile } from '../../api.js';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const hours = (seconds) => (seconds >= 86400 ? `${Math.floor(seconds / 86400)} d ${Math.floor((seconds % 86400) / 3600)} h` : `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`);

// Monitoring and automated backups in one place for the Manager.
export default function BackupsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [system, backups] = await Promise.all([api('/api/system/status'), api('/api/backups')]);
      setStatus(system);
      setList(backups);
      setError('');
    } catch (failure) {
      setError(failure.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function backUpNow() {
    setBusy(true);
    try {
      await api('/api/backups', { method: 'POST' });
      toast(t('Backup saved.'));
      await load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function download(name) {
    try {
      const url = URL.createObjectURL(await apiFile(`/api/backups/${encodeURIComponent(name)}/download`));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (failure) {
      setError(failure.message);
    }
  }

  const backupState = !status ? null : status.backupOverdue ? 'Overdue' : 'Up to date';

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Backups & Status')}</h1>
          <p>{t('The system backs up the whole database every day and keeps the newest copies. Check here that it is healthy.')}</p>
        </div>
        <button type="button" className="btn btn-outline" onClick={load}>↻ {t('Refresh')}</button>
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}

      <div className="card">
        <h3>{t('System status')}</h3>
        {!status ? <div className="empty">{t('Loading…')}</div> : (
          <div className="status-grid">
            <div><span className="sub">{t('Database')}</span><Status value={status.database === 'connected' ? 'Active' : 'Disabled'} label={t(status.database === 'connected' ? 'Connected' : 'Unavailable')} /></div>
            <div><span className="sub">{t('Last backup')}</span><b>{when(status.lastBackupAt)}</b><Status value={status.backupOverdue ? 'Pending' : 'Active'} label={t(backupState)} /></div>
            <div><span className="sub">{t('Server running for')}</span><b>{hours(status.uptimeSeconds)}</b></div>
            <div><span className="sub">{t('Requests since start')}</span><b>{status.requests}</b></div>
            <div><span className="sub">{t('Server errors')}</span><b>{status.serverErrors}</b>{status.lastError && <span className="sub">{when(status.lastError.at)} · {status.lastError.path}</span>}</div>
            <div><span className="sub">{t('Slow requests (over 2 s)')}</span><b>{status.slowRequests}</b></div>
          </div>
        )}
      </div>

      <div className="card dash-gap">
        <div className="section-row">
          <h3>{t('Backups')}</h3>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={backUpNow}>{busy ? t('Backing up…') : `⟲ ${t('Back up now')}`}</button>
        </div>
        <p className="sub">{t('A backup is made automatically every day and the newest {n} are kept. Download one now and then and keep it somewhere safe, such as a USB drive.').replace('{n}', list?.keep ?? 14)}</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t('Made at')}</th><th>{t('Size')}</th><th>{t('Actions')}</th></tr></thead>
            <tbody>
              {!list && <tr><td colSpan="3"><div className="empty">{t('Loading…')}</div></td></tr>}
              {list?.backups.length === 0 && <tr><td colSpan="3"><div className="empty">{t('No backups yet.')}</div></td></tr>}
              {list?.backups.map((file) => (
                <tr key={file.name}>
                  <td>{when(file.createdAt)}</td>
                  <td>{size(file.size)}</td>
                  <td><button type="button" className="btn btn-outline btn-sm" onClick={() => download(file.name)}>⇩ {t('Download')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
