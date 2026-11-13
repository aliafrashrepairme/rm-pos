import { useState } from 'react';
import { api } from '../../api.js';
import { dateTime } from '../../app/format.js';
import { useListRequest } from '../../app/useListRequest.js';
import Modal from '../../components/Modal.jsx';
import Status from '../../components/Status.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useI18n } from '../../i18n/I18nProvider.jsx';

function UserForm({ user, roles, onClose, onSaved }) {
  const { t } = useI18n();
  const [values, setValues] = useState({ name: user?.name ?? '', username: '', email: user?.email ?? '', role: user?.role ?? 'Cashier', temporaryPassword: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (name) => ({ name, value: values[name], onChange: (event) => setValues((current) => ({ ...current, [name]: event.target.value })) });

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = user ? { name: values.name, email: values.email } : values;
      await api(user ? `/api/users/${user.id}` : '/api/users', { method: user ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={t(user ? 'Edit user' : 'Add user')} description={t(user ? 'Update this staff login.' : 'Create a staff login and assign a role.')} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field full">{t('Full name')}<input {...field('name')} maxLength={120} required autoFocus /></label>
          {!user && <label className="field">{t('Username')}<input {...field('username')} maxLength={40} autoComplete="off" required /></label>}
          <label className="field">{t('Email (optional)')}<input {...field('email')} type="email" maxLength={120} autoComplete="off" /></label>
          {!user && (
            <>
              <label className="field">{t('Role')}
                <select {...field('role')}>{roles.map((role) => <option key={role.code} value={role.code}>{t(role.code)}</option>)}</select>
              </label>
              <label className="field">{t('Temporary password')}<input {...field('temporaryPassword')} type="password" minLength={8} maxLength={72} autoComplete="new-password" required /></label>
            </>
          )}
        </div>
        {!user && <p className="sub">{t('They must choose their own password the first time they sign in.')}</p>}
        {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
        <div className="modal-actions-row">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t('Save record')}</button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPassword({ user, onClose, onDone }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api(`/api/users/${user.id}/reset-password`, { method: 'POST', body: JSON.stringify({ temporaryPassword: password }) });
      onDone();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={t('Reset password')} description={`${user.name} · ${user.username}`} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field full">{t('Temporary password')}<input name="temporaryPassword" type="password" minLength={8} maxLength={72} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus /></label>
        <p className="sub">{t('They must choose their own password the first time they sign in.')}</p>
        {error && <p className="form-error modal-error" role="alert">{t(error)}</p>}
        <div className="modal-actions-row">
          <button type="button" className="btn btn-outline" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{t('Reset password')}</button>
        </div>
      </form>
    </Modal>
  );
}

function Activity({ user, onClose }) {
  const { t } = useI18n();
  const { data, error } = useListRequest(`/api/users/${user.id}/activity`);
  return (
    <Modal wide title={`${t('User activity')} · ${user.name}`} description={t('The latest 50 actions.')} onClose={onClose}>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="modal-scroll">
        {!data && !error && <div className="empty">{t('Loading…')}</div>}
        {data?.activity.length === 0 && <div className="empty">{t('No records found.')}</div>}
        {data?.activity.map((row) => (
          <div className="list-row" key={row.id}>
            <span><b>{t(row.action)}</b>{row.description && <> · {row.description}</>}</span>
            <span className="muted small-note">{dateTime(row.createdAt)}</span>
          </div>
        ))}
      </div>
      <div className="modal-actions-row"><button type="button" className="btn btn-primary" onClick={onClose}>{t('Close')}</button></div>
    </Modal>
  );
}

export default function UsersPage({ user: me }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data, error, reload } = useListRequest('/api/users');
  const [dialog, setDialog] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const roles = data?.roles ?? [];

  async function change(user, body, message) {
    try {
      await api(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast(message);
    } catch (failure) {
      toast(t(failure.message));
    }
    reload();
  }

  async function remove(user) {
    setConfirming(null);
    try {
      await api(`/api/users/${user.id}`, { method: 'DELETE' });
      toast(`${user.name} ${t('removed.')}`);
    } catch (failure) {
      toast(t(failure.message));
    }
    reload();
  }

  const closeAnd = (message) => {
    setDialog(null);
    toast(message);
    reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{t('RM HARDWARE STORE')}</div>
          <h1>{t('User management')}</h1>
          <p>{t('Only the Manager can create logins, assign roles, reset passwords and disable accounts.')}</p>
        </div>
        <div className="toolbar head-actions"><button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'add' })}>＋ {t('Add user')}</button></div>
      </div>
      <div className="role-grid users-roles">
        {roles.map((role) => <div className="role" key={role.code}><strong>{t(role.code)}</strong><small>{t(role.description)}</small></div>)}
      </div>
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr>{['User', 'Username', 'Email', 'Role', 'Status', 'Actions'].map((heading) => <th key={heading}>{t(heading)}</th>)}</tr></thead>
          <tbody>
            {!data && !error && <tr><td colSpan="6"><div className="empty">{t('Loading…')}</div></td></tr>}
            {data?.users.map((user) => {
              const isMe = user.id === me.id;
              return (
                <tr key={user.id}>
                  <td><b className="pname">{user.name}</b>{isMe && <> <span className="chip">{t('You')}</span></>}</td>
                  <td>{user.username}</td>
                  <td>{user.email || '—'}</td>
                  <td>
                    <select className="inp" aria-label={`${t('Role')} ${user.name}`} disabled={isMe} value={user.role} onChange={(event) => change(user, { role: event.target.value }, `${user.name}: ${t(event.target.value)}`)}>
                      {roles.map((role) => <option key={role.code} value={role.code}>{t(role.code)}</option>)}
                    </select>
                  </td>
                  <td><Status value={user.active ? 'Active' : 'Disabled'} label={t(user.active ? 'Active' : 'Disabled')} /></td>
                  <td>
                    <div className="user-actions">
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setDialog({ kind: 'edit', user })}>{t('Edit')}</button>
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setDialog({ kind: 'activity', user })}>{t('Activity')}</button>
                      {!isMe && (
                        <>
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => setDialog({ kind: 'reset', user })}>{t('Reset password')}</button>
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => change(user, { active: !user.active }, `${user.name}: ${t(user.active ? 'Disabled' : 'Active')}`)}>{t(user.active ? 'Disable' : 'Enable')}</button>
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => setConfirming(user)}>{t('Remove')}</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dialog?.kind === 'add' && <UserForm roles={roles} onClose={() => setDialog(null)} onSaved={() => closeAnd(t('User saved.'))} />}
      {dialog?.kind === 'edit' && <UserForm user={dialog.user} roles={roles} onClose={() => setDialog(null)} onSaved={() => closeAnd(t('User saved.'))} />}
      {dialog?.kind === 'reset' && <ResetPassword user={dialog.user} onClose={() => setDialog(null)} onDone={() => closeAnd(t('Password updated.'))} />}
      {dialog?.kind === 'activity' && <Activity user={dialog.user} onClose={() => setDialog(null)} />}
      {confirming && (
        <Modal title={t('Remove user')} description={`${confirming.name} · ${confirming.username}`} onClose={() => setConfirming(null)}>
          <p>{t('Only an account with no activity can be removed. Otherwise, disable it.')}</p>
          <div className="modal-actions-row">
            <button type="button" className="btn btn-outline" onClick={() => setConfirming(null)}>{t('Cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={() => remove(confirming)}>{t('Remove')}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
