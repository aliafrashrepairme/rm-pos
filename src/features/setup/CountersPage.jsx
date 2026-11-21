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

  // The counter's own PIN: cashiers enter it to open or close a shift there.
  const [pinFor, setPinFor] = useState(null);
  async function savePin(event) {
    event.preventDefault();
    if (await send(`/api/counters/${pinFor.id}/pin`, 'PUT', { pin: pinFor.pin }, 'Counter PIN saved.')) setPinFor(null);
  }
  async function removePin(counter) {
    if (!window.confirm(t('Remove the PIN? Cashiers will confirm shifts on this counter with their own password.'))) return;
    await send(`/api/counters/${counter.id}/pin`, 'PUT', { pin: '' }, 'Counter PIN removed.');
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
          <thead><tr>{['Counter', 'Status', 'PIN', 'In use now', 'Last used', 'Actions'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {!list && !error && <tr><td colSpan="6"><div className="empty">{t('Loading…')}</div></td></tr>}
            {list?.length === 0 && <tr><td colSpan="6"><div className="empty">{t('No counters yet. Add the first one above.')}</div></td></tr>}
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
                <td>
                  {pinFor?.id === counter.id ? (
                    <form className="inline-edit" onSubmit={savePin}>
                      <input aria-label={t('New PIN')} type="password" inputMode="numeric" autoComplete="new-password" pattern="\d{4,6}" title={t('4 to 6 digits')} placeholder={t('4–6 digits')} value={pinFor.pin} onChange={(event) => setPinFor({ ...pinFor, pin: event.target.value.replace(/\D/g, '').slice(0, 6) })} required autoFocus />
                      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{t('Save')}</button>
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setPinFor(null)}>{t('Cancel')}</button>
                    </form>
                  ) : counter.hasPin ? <span className="chip green">🔒 {t('PIN set')}</span> : <span className="muted">{t('No PIN (uses cashier password)')}</span>}
                </td>
                <td>{counter.openShift ? `${counter.openShift.cashier} · ${counter.openShift.shiftNo}` : '—'}</td>
                <td>{counter.lastUsed ? dateTime(counter.lastUsed) : t('Never')}</td>
                <td className="row-actions">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditing({ id: counter.id, name: counter.name })}>{t('Rename')}</button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setPinFor({ id: counter.id, pin: '' })}>{t(counter.hasPin ? 'Change PIN' : 'Set PIN')}</button>
                  {counter.hasPin && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => removePin(counter)}>{t('Remove PIN')}</button>}
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
