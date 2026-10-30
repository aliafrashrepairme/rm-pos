import { useState } from 'react';
import { api } from '../api.js';
import PasswordInput from './PasswordInput.jsx';

export default function ChangePassword({ required, onChanged, onCancel }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      onChanged();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="login-card" onSubmit={submit}>
        <h2>Change password</h2>
        {required && <p className="notice">You are using a temporary password. Choose a new one to continue.</p>}
        <PasswordInput label={required ? 'Temporary password' : 'Current password'} value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
        <PasswordInput label="New password (at least 8 characters)" value={newPassword} onChange={setNewPassword} autoComplete="new-password" minLength={8} />
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>Change password</button>
        <button type="button" className="link-btn" onClick={onCancel}>{required ? 'Log out' : 'Cancel'}</button>
      </form>
    </div>
  );
}
