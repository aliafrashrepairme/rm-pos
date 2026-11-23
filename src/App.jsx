import { useCallback, useEffect, useState } from 'react';
import { api, getAuthToken, isNetworkError, setAuthToken, SESSION_EXPIRED_EVENT } from './api.js';
import { can, canOpen, screensFor } from './app/access.js';
import { syncCatalog } from './offline/catalog.js';
import { subscribeConnection } from './offline/connection.js';
import { forgetSignIn } from './offline/offlineAuth.js';
import { startAutoSync } from './offline/outbox.js';
import { clearSavedCart } from './features/pos/CartContext.jsx';
import ChangePassword from './app/ChangePassword.jsx';
import Layout from './app/Layout.jsx';
import Login from './app/Login.jsx';
import { applyTheme, loadDevicePreferences, saveDevicePreference } from './app/preferences.js';
import { useHashRoute } from './app/useHashRoute.js';
import { useI18n } from './i18n/I18nProvider.jsx';
import BarcodePage from './features/barcode/BarcodePage.jsx';
import Dashboard from './features/dashboard/Dashboard.jsx';
import InventoryPage from './features/inventory/InventoryPage.jsx';
import StockAdjustmentsPage from './features/inventory/StockAdjustmentsPage.jsx';
import StockCountsPage from './features/inventory/StockCountsPage.jsx';
import { CartProvider } from './features/pos/CartContext.jsx';
import HeldOrdersPage from './features/pos/HeldOrdersPage.jsx';
import PosPage from './features/pos/PosPage.jsx';
import PurchasesPage from './features/purchases/PurchasesPage.jsx';
import QuotationsPage from './features/quotations/QuotationsPage.jsx';
import CreditPage from './features/credit/CreditPage.jsx';
import CountersPage from './features/setup/CountersPage.jsx';
import CouponsPage from './features/coupons/CouponsPage.jsx';
import PrintersPage from './features/setup/PrintersPage.jsx';
import CustomersPage from './features/customers/CustomersPage.jsx';
import SettingsPage from './features/settings/SettingsPage.jsx';
import StoreLogoPage from './features/settings/StoreLogoPage.jsx';
import BackupsPage from './features/settings/BackupsPage.jsx';
import ShiftsPage from './features/shifts/ShiftsPage.jsx';
import SuppliersPage from './features/suppliers/SuppliersPage.jsx';
import UsersPage from './features/users/UsersPage.jsx';
import AuditPage from './features/data/AuditPage.jsx';
import ImportExportPage from './features/data/ImportExportPage.jsx';
import ListsPage from './features/data/ListsPage.jsx';
import BillsPage from './features/transactions/BillsPage.jsx';
import DailyPage from './features/transactions/DailyPage.jsx';
import MonthlyPage from './features/transactions/MonthlyPage.jsx';
import ProductsPage from './features/products/ProductsPage.jsx';
import ReportsModule from './features/reports/pages/ReportsModule.jsx';

function Screen({ user, page, onHome, onNavigate, theme, onTheme, onLanguage }) {
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
  if (page === 'Import / Export') return <ImportExportPage />;
  if (page === 'List Management') return <ListsPage />;
  if (page === 'Audit Log') return <AuditPage />;
  if (page === 'User Management') return <UsersPage user={user} />;
  if (page === 'Settings') return <SettingsPage theme={theme} onTheme={onTheme} onLanguage={onLanguage} />;
  if (page === 'Store Logo') return <StoreLogoPage />;
  if (page === 'Counters') return <CountersPage />;
  if (page === 'Coupons') return <CouponsPage />;
  if (page === 'Printers') return <PrintersPage />;
  if (page === 'Backups & Status') return <BackupsPage />;
  if (page === 'Shifts & Cash') return <ShiftsPage user={user} />;
  if (page === 'Customers') return <CustomersPage user={user} />;
  if (page === 'Credit Management') return <CreditPage user={user} />;
  if (page === 'Quotations') return <QuotationsPage user={user} onNavigate={onNavigate} />;
  if (page === 'Suppliers') return <SuppliersPage user={user} />;
  if (page === 'Purchases') return <PurchasesPage user={user} />;
  if (page === 'Bills Register') return <BillsPage user={user} />;
  if (page === 'Daily Transactions') return <DailyPage user={user} />;
  if (page === 'Monthly Transactions') return <MonthlyPage user={user} onNavigate={onNavigate} />;
  if (page === 'POS Billing') return <PosPage user={user} onNavigate={onNavigate} />;
  if (page === 'Held Orders') return <HeldOrdersPage onNavigate={onNavigate} />;
  if (page === 'Inventory') return <InventoryPage user={user} />;
  if (page === 'Stock Counts') return <StockCountsPage user={user} />;
  if (page === 'Stock Adjustments') return <StockAdjustmentsPage />;
  if (page === 'Products') return <ProductsPage user={user} />;
  return <ReportsModule user={user} />;
}

// The signed-in account, kept for this window only (like the sign-in token), so a refresh while the
// connection is down reopens the same session instead of a "server unavailable" screen.
const SESSION_USER_KEY = 'rm-pos-session-user';
function savedSessionUser() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_USER_KEY) || 'null');
  } catch {
    return null;
  }
}
function saveSessionUser(user) {
  try {
    if (user) sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(SESSION_USER_KEY);
  } catch {
    // Storage blocked: a refresh asks to sign in again.
  }
}

const CATALOG_REFRESH_MS = 10 * 60 * 1000;

// Keeps this device's copy of the product list fresh, and sends saved drafts, while signed in with the server.
function useOfflineSupport(user, serverSession) {
  const userId = user?.id;
  const keepsCatalog = Boolean(user) && can(user, 'pos.sell', 'quotations.manage');
  useEffect(() => {
    if (!userId || !serverSession) return undefined;
    return startAutoSync(userId);
  }, [userId, serverSession]);
  useEffect(() => {
    if (!keepsCatalog || !serverSession) return undefined;
    syncCatalog();
    const timer = setInterval(syncCatalog, CATALOG_REFRESH_MS);
    const stop = subscribeConnection((online) => { if (online) syncCatalog(); });
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [keepsCatalog, serverSession]);
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
  // False after an offline sign-in: drafts can be saved, but nothing reaches the server until a real sign-in.
  const [serverSession, setServerSession] = useState(() => Boolean(getAuthToken()));

  useEffect(() => applyTheme(theme), [theme]);
  useOfflineSupport(user, serverSession);

  const enter = useCallback((nextUser, { offlineSession = false } = {}) => {
    setUser(nextUser);
    setNotice('');
    setOffline('');
    setServerSession(!offlineSession && Boolean(getAuthToken()));
    saveSessionUser({ ...nextUser, offlineSession });
    if (offlineSession) return;
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
    saveSessionUser(null);
    setServerSession(false);
    setUser(null);
    setChangingPassword(false);
    setNotice(message);
    navigate('');
  }, [navigate]);

  const restoreSession = useCallback(() => {
    const remembered = savedSessionUser();
    if (!getAuthToken()) {
      // A refresh during an offline sign-in keeps that offline session.
      if (remembered?.offlineSession) enter(remembered, { offlineSession: true });
      setAuthReady(true);
      return;
    }
    setOffline('');
    api('/api/auth/me')
      .then(({ user: currentUser }) => enter(currentUser))
      .catch((error) => {
        // A network failure keeps the session, so it can continue once the connection returns.
        if (isNetworkError(error) && remembered) enter(remembered);
        else if (isNetworkError(error)) setOffline(error.message);
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
    if (serverSession) {
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch (error) {
        if (error.status !== 401) console.error('Logout could not reach the server:', error.message);
      }
    }
    clearSavedCart(user?.id);
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
        onOfflineLogin={(offlineUser) => enter(offlineUser, { offlineSession: true })}
      />
    );
  }
  if (user.mustChangePassword || changingPassword) {
    return (
      <ChangePassword
        required={user.mustChangePassword}
        onChanged={() => {
          // The old password must not open an offline session any more.
          forgetSignIn(user).catch(() => {});
          leave('Password changed. Sign in with your new password.');
        }}
        onCancel={user.mustChangePassword ? logout : () => setChangingPassword(false)}
      />
    );
  }

  const home = screensFor(user)[0] || '';
  // An empty address opens the role's home screen. A typed address that isn't allowed is refused.
  const page = slug ? (screen ?? slug) : home;

  return (
    <CartProvider key={user.id} userId={user.id}>
    <Layout
      user={user}
      serverSession={serverSession}
      onSignInAgain={() => leave('Sign in to send the bills and quotations saved on this device.')}
      page={screen ?? (slug ? '' : home)}
      version={version}
      theme={theme}
      onNavigate={navigate}
      onTheme={changeTheme}
      onLanguage={changeLanguage}
      onChangePassword={() => setChangingPassword(true)}
      onLogout={logout}
    >
      <Screen user={user} page={page} onHome={() => navigate(home)} onNavigate={navigate} theme={theme} onTheme={changeTheme} onLanguage={changeLanguage} />
    </Layout>
    </CartProvider>
  );
}
