import { useCallback, useEffect, useState } from 'react';
import { api, getAuthToken, setAuthToken, SESSION_EXPIRED_EVENT } from './api.js';
import { canOpen, screensFor } from './app/access.js';
import ChangePassword from './app/ChangePassword.jsx';
import Layout from './app/Layout.jsx';
import Login from './app/Login.jsx';
import { applyTheme, loadDevicePreferences, saveDevicePreference } from './app/preferences.js';
import { useHashRoute } from './app/useHashRoute.js';
import { useI18n } from './i18n/I18nProvider.jsx';
import BarcodePage from './features/barcode/BarcodePage.jsx';
import Dashboard from './features/dashboard/Dashboard.jsx';
import InventoryPage from './features/inventory/InventoryPage.jsx';
import { CartProvider } from './features/pos/CartContext.jsx';
import HeldOrdersPage from './features/pos/HeldOrdersPage.jsx';
import PosPage from './features/pos/PosPage.jsx';
import PurchasesPage from './features/purchases/PurchasesPage.jsx';
import CustomersPage from './features/customers/CustomersPage.jsx';
import SuppliersPage from './features/suppliers/SuppliersPage.jsx';
import BillsPage from './features/transactions/BillsPage.jsx';
import DailyPage from './features/transactions/DailyPage.jsx';
import MonthlyPage from './features/transactions/MonthlyPage.jsx';
import ProductsPage from './features/products/ProductsPage.jsx';
import ReportsModule from './reports/pages/ReportsModule.jsx';

function Screen({ user, page, onHome, onNavigate }) {
  const { t } = useI18n();
  if (!canOpen(user, page)) {
    return (
      <div className="card access-denied">
        <p className="form-error" role="alert">{t('Your role does not have access to this section.')}</p>
        <button type="button" className="btn btn-primary" onClick={onHome}>{t('Go to my home screen')}</button>
      </div>
    );
  }
  if (page === 'Dashboard') return <Dashboard user={user} onNavigate={onNavigate} />;
  if (page === 'Barcode Scanner') return <BarcodePage user={user} />;
  if (page === 'Customers') return <CustomersPage user={user} />;
  if (page === 'Suppliers') return <SuppliersPage user={user} />;
  if (page === 'Purchases') return <PurchasesPage user={user} />;
  if (page === 'Bills Register') return <BillsPage user={user} />;
  if (page === 'Daily Transactions') return <DailyPage user={user} />;
  if (page === 'Monthly Transactions') return <MonthlyPage user={user} onNavigate={onNavigate} />;
  if (page === 'POS Billing') return <PosPage user={user} onNavigate={onNavigate} />;
  if (page === 'Held Orders') return <HeldOrdersPage onNavigate={onNavigate} />;
  if (page === 'Inventory') return <InventoryPage user={user} />;
  if (page === 'Products') return <ProductsPage user={user} />;
  if (page === 'Reports') return <ReportsModule user={user} />;
  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">{t('RM HARDWARE STORE')}</div><h1>{t(page)}</h1></div>
      </div>
      <div className="card"><div className="empty">{t('This screen is not built yet. It is scheduled in a later development phase.')}</div></div>
    </>
  );
}

export default function App() {
  const { t, setLanguage } = useI18n();
  const { slug, screen, navigate } = useHashRoute();
  const [user, setUser] = useState(null);
  const [version, setVersion] = useState('');
  const [authReady, setAuthReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [offline, setOffline] = useState('');
  const [theme, setThemeState] = useState(() => loadDevicePreferences().theme);

  useEffect(() => applyTheme(theme), [theme]);

  const enter = useCallback((nextUser) => {
    setUser(nextUser);
    setNotice('');
    setOffline('');
    api('/api/auth/preferences')
      .then(({ preferences }) => {
        if (!preferences) return;
        setThemeState(preferences.theme);
        saveDevicePreference('theme', preferences.theme);
        setLanguage(preferences.language);
      })
      .catch((error) => console.error('Could not load preferences:', error.message));
  }, [setLanguage]);

  const leave = useCallback((message = '') => {
    setAuthToken(null);
    setUser(null);
    setChangingPassword(false);
    setNotice(message);
    navigate('');
  }, [navigate]);

  const restoreSession = useCallback(() => {
    if (!getAuthToken()) {
      setAuthReady(true);
      return;
    }
    setOffline('');
    api('/api/auth/me')
      .then(({ user: currentUser }) => enter(currentUser))
      .catch((error) => {
        // A network failure keeps the session, so it can continue once the connection returns.
        if (error.status === 0) setOffline(error.message);
        else leave(error.status === 403 ? error.message : '');
      })
      .finally(() => setAuthReady(true));
  }, [enter, leave]);

  useEffect(() => {
    window.rmpos?.getVersion().then(setVersion);
    restoreSession();
    const expired = () => leave('Your session has ended. Please sign in again.');
    window.addEventListener(SESSION_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
  }, [restoreSession, leave]);

  const signedIn = Boolean(user);
  const savePreferences = useCallback((change) => {
    if (!signedIn) return;
    api('/api/auth/preferences', { method: 'PUT', body: JSON.stringify(change) })
      .catch((error) => console.error('Could not save preferences:', error.message));
  }, [signedIn]);

  function changeTheme(next) {
    setThemeState(next);
    saveDevicePreference('theme', next);
    savePreferences({ theme: next });
  }

  function changeLanguage(next) {
    setLanguage(next);
    savePreferences({ language: next });
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      if (error.status !== 401) console.error('Logout could not reach the server:', error.message);
    }
    leave();
  }

  if (!authReady) return null;
  if (offline) {
    return (
      <div className="center-screen">
        <div className="login-card">
          <h2>{t('Server unavailable')}</h2>
          <p className="form-error" role="alert">{t(offline)}</p>
          <button type="button" className="btn btn-primary login-submit" onClick={restoreSession}>{t('Try again')}</button>
        </div>
      </div>
    );
  }
  if (!user) {
    return (
      <Login
        notice={notice}
        theme={theme}
        onTheme={changeTheme}
        onLanguage={changeLanguage}
        onLogin={({ user: nextUser, token, refreshToken }) => {
          setAuthToken(token, refreshToken);
          enter(nextUser);
        }}
      />
    );
  }
  if (user.mustChangePassword || changingPassword) {
    return (
      <ChangePassword
        required={user.mustChangePassword}
        onChanged={() => leave('Password changed. Sign in with your new password.')}
        onCancel={user.mustChangePassword ? logout : () => setChangingPassword(false)}
      />
    );
  }

  const home = screensFor(user)[0] || '';
  // An empty address opens the role's home screen. A typed address that isn't allowed is refused.
  const page = slug ? (screen ?? slug) : home;

  return (
    <CartProvider key={user.id}>
    <Layout
      user={user}
      page={screen ?? (slug ? '' : home)}
      version={version}
      theme={theme}
      onNavigate={navigate}
      onTheme={changeTheme}
      onLanguage={changeLanguage}
      onChangePassword={() => setChangingPassword(true)}
      onLogout={logout}
    >
      <Screen user={user} page={page} onHome={() => navigate(home)} onNavigate={navigate} />
    </Layout>
    </CartProvider>
  );
}
