import { useState } from 'react';
import { api } from '../api.js';
import logo from '../assets/logo.jpg';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { LanguageSelect, ThemeButton } from './Layout.jsx';
import PasswordInput from './PasswordInput.jsx';

function SignIn({ notice, onLogin, onForgot }) {
  const { t } = useI18n();
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
    <form onSubmit={submit}>
      <h2>{t('Welcome back')}</h2>
      <p className="login-sub">{t('Sign in with your staff account to continue.')}</p>
      {notice && <p className="notice">{t(notice)}</p>}
      <label className="field">{t('Username or email')}
        <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" autoFocus required />
      </label>
      <PasswordInput label={t('Password')} value={password} onChange={setPassword} autoComplete="current-password" />
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <button type="submit" className="btn btn-primary login-submit" disabled={busy}>{busy ? t('Signing in…') : t('Sign in to RM POS →')}</button>
      <button type="button" className="link-btn" onClick={onForgot}>{t('Forgot password?')}</button>
    </form>
  );
}

function ForgotPassword({ onDone }) {
  const { t } = useI18n();
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
    <form onSubmit={sent ? resetPassword : requestCode}>
      <h2>{t('Reset password')}</h2>
      <p className="login-sub">
        {sent
          ? t('If this email has an account, a reset code is on its way. Enter it below.')
          : t('Enter your account email. No email on your account? Ask your manager to reset your password.')}
      </p>
      <label className="field">{t('Email address')}
        <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={sent} autoFocus required />
      </label>
      {sent && (
        <>
          <label className="field">{t('Reset code')}
            <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" required />
          </label>
          <PasswordInput label={t('New password')} value={password} onChange={setPassword} autoComplete="new-password" minLength={8} />
        </>
      )}
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      <button type="submit" className="btn btn-primary login-submit" disabled={busy}>{sent ? t('Set new password') : t('Send reset code')}</button>
      <button type="button" className="link-btn" onClick={() => onDone('')}>{t('Back to sign in')}</button>
    </form>
  );
}

export default function Login({ notice, theme, onTheme, onLanguage, onLogin }) {
  const { t } = useI18n();
  const [forgot, setForgot] = useState(false);
  const [message, setMessage] = useState('');

  return (
    <section className="login-screen">
      <div className="login-brand-panel">
        <div>
          <img className="login-logo" src={logo} alt="RepairMe company logo" />
          <div className="login-store">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Smarter store operations start here.')}</h1>
          <p>{t('Sign in to manage billing, inventory, purchasing, stock counts and AI invoice capture — with access tailored to your role.')}</p>
        </div>
        <div className="login-foot">RM POS · {t('Hardware Store Management')}</div>
      </div>
      <div className="login-panel">
        <div className="login-card">
          <div className="login-controls">
            <ThemeButton theme={theme} onChange={onTheme} />
            <LanguageSelect onChange={onLanguage} />
          </div>
          {forgot
            ? <ForgotPassword onDone={(text) => { setMessage(text); setForgot(false); }} />
            : <SignIn notice={message || notice} onLogin={onLogin} onForgot={() => setForgot(true)} />}
        </div>
      </div>
    </section>
  );
}
