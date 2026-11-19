import { useState } from 'react';
import { api } from '../../api.js';
import { dateTime } from '../../app/format.js';
import { useListRequest } from '../../app/useListRequest.js';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

// The Owner's list of cash counters. Cashiers pick one of the active counters when they open a shift.
export default function CountersPage() {
  const { t } = useI18n();
  const toast = useToast();
  const { data, error, reload } = useListRequest('/api/counters');
  const [counters, setCounters] = useState(null);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const list = counters ?? data?.counters;

  async function send(path, method, body, message) {
    setProblem('');
    setBusy(true);
    try {
      const result = await api(path, { method, body: JSON.stringify(body) });
      setCounters(result.counters);
      toast(t(message));
      return true;
    } catch (failure) {
      setProblem(failure.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event) {
    event.preventDefault();
    if (await send('/api/counters', 'POST', { name: newName }, 'Counter added.')) setNewName('');
  }

  async function rename(event) {
    event.preventDefault();
    if (await send(`/api/counters/${editing.id}`, 'PATCH', { name: editing.name }, 'Counter renamed.')) setEditing(null);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Counters')}</h1>
          <p>{t('The cash counters in the shop. Cashiers choose an active counter when they open a shift.')}</p>
        </div>
      </div>
      {(error || problem) && <p className="form-error" role="alert">{t(error || problem)}</p>}

      <form className="card counter-add" onSubmit={add}>
        <label className="field">{t('New counter name')}
          <input name="counterName" value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={40} placeholder={t('e.g. Counter 03')} required />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>＋ {t('Add counter')}</button>
      </form>

      <div className="table-wrap">
        <table>
          <thead><tr>{['Counter', 'Status', 'In use now', 'Last used', 'Actions'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {!list && !error && <tr><td colSpan="5"><div className="empty">{t('Loading…')}</div></td></tr>}
            {list?.length === 0 && <tr><td colSpan="5"><div className="empty">{t('No counters yet. Add the first one above.')}</div></td></tr>}
            {list?.map((counter) => (
              <tr key={counter.id}>
                <td>
                  {editing?.id === counter.id ? (
                    <form className="inline-edit" onSubmit={rename}>
                      <input aria-label={t('Counter name')} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} maxLength={40} required autoFocus />
                      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{t('Save')}</button>
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditing(null)}>{t('Cancel')}</button>
                    </form>
                  ) : <b>{counter.name}</b>}
                </td>
                <td><Status value={counter.active ? 'Active' : 'Inactive'} label={t(counter.active ? 'Active' : 'Inactive')} /></td>
                <td>{counter.openShift ? `${counter.openShift.cashier} · ${counter.openShift.shiftNo}` : '—'}</td>
                <td>{counter.lastUsed ? dateTime(counter.lastUsed) : t('Never')}</td>
                <td className="row-actions">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditing({ id: counter.id, name: counter.name })}>{t('Rename')}</button>
                  {counter.active
                    ? <button type="button" className="btn btn-outline btn-sm" disabled={busy || Boolean(counter.openShift)} title={counter.openShift ? t('Close the open shift first.') : ''} onClick={() => send(`/api/counters/${counter.id}`, 'PATCH', { active: false }, 'Counter switched off.')}>{t('Switch off')}</button>
                    : <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => send(`/api/counters/${counter.id}`, 'PATCH', { active: true }, 'Counter switched on.')}>{t('Switch on')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small-note counter-hint">{t('Switched-off counters keep their history but can no longer be chosen for a new shift.')} <button type="button" className="link-btn" onClick={() => { setCounters(null); reload(); }}>{t('Refresh')}</button></p>
    </>
  );
}
