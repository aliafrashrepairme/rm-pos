import { useState } from 'react';
import { api } from '../api.js';
import PasswordInput from './PasswordInput.jsx';

function SignIn({ notice, onLogin, onForgot }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const session = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) });
      onLogin(session);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <form className="login-card" onSubmit={submit}>
      <h2>Welcome back</h2>
      <p className="login-sub">Sign in with your staff account to continue.</p>
      {notice && <p className="notice">{notice}</p>}
      <label>Username or email
        <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" autoFocus required />
      </label>
      <PasswordInput label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in to RM POS →'}</button>
      <button type="button" className="link-btn" onClick={onForgot}>Forgot password?</button>
    </form>
  );
}

function ForgotPassword({ onDone }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  function requestCode(event) {
    event.preventDefault();
    run(async () => {
      await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    });
  }

  function resetPassword(event) {
    event.preventDefault();
    run(async () => {
      await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email, code, password }) });
      onDone('Password changed. Sign in with your new password.');
    });
  }

  return (
    <form className="login-card" onSubmit={sent ? resetPassword : requestCode}>
      <h2>Reset password</h2>
      {sent
        ? <p className="login-sub">If this email has an account, a reset code is on its way. Enter it below.</p>
        : <p className="login-sub">Enter your account email. No email on your account? Ask your manager to reset your password.</p>}
      <label>Email address
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={sent} autoFocus required />
      </label>
      {sent && (
        <>
          <label>Reset code
            <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" required />
          </label>
          <PasswordInput label="New password" value={password} onChange={setPassword} autoComplete="new-password" minLength={8} />
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{sent ? 'Set new password' : 'Send reset code'}</button>
      <button type="button" className="link-btn" onClick={() => onDone('')}>Back to sign in</button>
    </form>
  );
}

export default function Login({ notice, onLogin }) {
  const [forgot, setForgot] = useState(false);
  const [message, setMessage] = useState('');

  return (
    <div className="login">
      <div className="login-brand">
        <div className="mark">RM</div>
        <h1>Smarter store operations start here.</h1>
      </div>
      {forgot
        ? <ForgotPassword onDone={(text) => { setMessage(text); setForgot(false); }} />
        : <SignIn notice={message || notice} onLogin={onLogin} onForgot={() => setForgot(true)} />}
    </div>
  );
}
