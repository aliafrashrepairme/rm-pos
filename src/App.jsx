import { useCallback, useEffect, useState } from 'react';
import { api, getAuthToken, setAuthToken, SESSION_EXPIRED_EVENT } from './api.js';
import { canOpen, screensFor } from './app/access.js';
import ChangePassword from './app/ChangePassword.jsx';
import Login from './app/Login.jsx';
import ReportsModule from './reports/pages/ReportsModule.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [page, setPage] = useState('');
  const [version, setVersion] = useState('');
  const [authReady, setAuthReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [offline, setOffline] = useState('');

  const enter = useCallback((nextUser) => {
    setUser(nextUser);
    setPage(screensFor(nextUser)[0] || '');
    setNotice('');
    setOffline('');
  }, []);

  const leave = useCallback((message = '') => {
    setAuthToken(null);
    setUser(null);
    setPage('');
    setChangingPassword(false);
    setNotice(message);
  }, []);

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
          <h2>Server unavailable</h2>
          <p className="error" role="alert">{offline}</p>
          <button type="button" onClick={restoreSession}>Try again</button>
        </div>
      </div>
    );
  }
  if (!user) {
    return (
      <Login
        notice={notice}
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

  const screens = screensFor(user);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="mark">RM</span> RM POS</div>
        {screens.map((item) => (
          <button key={item} className={item === page ? 'active' : ''} onClick={() => setPage(item)}>{item}</button>
        ))}
        <div className="side-foot">{user.name} · {user.role}{version && ` · v${version}`}</div>
      </aside>
      <main className="main">
        <header className="topbar">
          <b>{page}</b>
          <span className="top-actions">
            <button onClick={() => setChangingPassword(true)}>Change password</button>
            <button onClick={logout}>Log out</button>
          </span>
        </header>
        <section className="content">
          {!canOpen(user, page) ? (
            <p className="error" role="alert">Your role does not have access to this section.</p>
          ) : page === 'Reports' ? (
            <ReportsModule user={user} />
          ) : (
            <>
              <h1>{page}</h1>
              <p>This screen is not built yet. It is scheduled in a later development phase.</p>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
