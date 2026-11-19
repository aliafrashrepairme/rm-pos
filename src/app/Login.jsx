import { useState } from 'react';
import { api } from '../api.js';
import logo from '../assets/logo.jpg';
import { useI18n } from '../i18n/I18nProvider.jsx';
import { LanguageSelect, ThemeButton } from './Layout.jsx';
import { useStoreLogo } from './storeLogo.js';
import PasswordInput from './PasswordInput.jsx';

function SignIn({ notice, onLogin }) {
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
      <p className="login-sub">{t('Forgot your password? Ask your manager to reset it.')}</p>
    </form>
  );
}

export default function Login({ notice, theme, onTheme, onLanguage, onLogin }) {
  const { t } = useI18n();
  const storeLogo = useStoreLogo();
  return (
    <section className="login-screen">
      <div className="login-brand-panel">
        <div>
          <img className={storeLogo ? 'login-logo login-logo-custom' : 'login-logo'} src={storeLogo || logo} alt={storeLogo ? t('Store logo') : 'RepairMe company logo'} />
          <div className="login-store">{t('RM HARDWARE STORE')}</div>
          <h1>{t('Smarter store operations start here.')}</h1>
          <p>{t('Sign in to manage billing, inventory, purchasing and stock counts — with access tailored to your role.')}</p>
        </div>
        <div className="login-foot">RM POS · {t('Hardware Store Management')}</div>
      </div>
      <div className="login-panel">
        <div className="login-card">
          <div className="login-controls">
            <ThemeButton theme={theme} onChange={onTheme} />
            <LanguageSelect onChange={onLanguage} />
          </div>
          <SignIn notice={notice} onLogin={onLogin} />
        </div>
      </div>
    </section>
  );
}
