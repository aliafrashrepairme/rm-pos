import { useI18n } from '../i18n/I18nProvider.jsx';
import { LANGUAGES } from '../i18n/translate.js';
import { menuFor } from './access.js';

export function ThemeButton({ theme, onChange }) {
  const { t } = useI18n();
  return (
    <button type="button" className="icon-btn" title={t('Toggle theme')} aria-label={t('Toggle theme')} onClick={() => onChange(theme === 'dark' ? 'light' : 'dark')}>
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

export function LanguageSelect({ onChange }) {
  const { language, t } = useI18n();
  return (
    <select className="filters" aria-label={t('Language')} value={language} onChange={(event) => onChange(event.target.value)}>
      {LANGUAGES.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
    </select>
  );
}

export default function Layout({ user, page, version, theme, onNavigate, onTheme, onLanguage, onChangePassword, onLogout, children }) {
  const { t } = useI18n();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">RM</div>
          <div className="brand-copy"><strong>RM POS</strong><small>{t('HARDWARE STORE SYSTEM')}</small></div>
        </div>
        <nav className="nav">
          {menuFor(user).map((group) => [
            <div className="nav-label" key={group.label}>{t(group.label)}</div>,
            ...group.screens.map((screen) => (
              <button
                type="button"
                key={screen.name}
                className={screen.name === page ? 'active' : ''}
                title={t(screen.name)}
                onClick={() => onNavigate(screen.name)}
              >
                <span className="ico">{screen.icon}</span><span className="label">{t(screen.name)}</span>
              </button>
            ))
          ])}
        </nav>
        <div className="side-bottom">
          RM Hardware Store{version && ` · v${version}`}<br />
          <b className="side-user">● {user.name}</b>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumb">RM POS <span className="crumb-sep">/</span><b>{page ? t(page) : ''}</b></div>
          <div className="top-actions">
            <ThemeButton theme={theme} onChange={onTheme} />
            <LanguageSelect onChange={onLanguage} />
            <span className="user-pill">{user.name} · {t(user.role)}</span>
            <button type="button" className="btn btn-outline btn-sm" onClick={onChangePassword}>{t('Change password')}</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={onLogout}>{t('Log out')}</button>
          </div>
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
