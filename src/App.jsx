import { useEffect, useState } from 'react';
import { api, getAuthToken, setAuthToken } from './api.js';
import ReportsModule from './reports/pages/ReportsModule.jsx';

const MENU = {
  Owner: ['Daily Transactions', 'Monthly Transactions', 'Reports'],
  Manager: ['Dashboard', 'Daily Transactions', 'Monthly Transactions', 'Inventory', 'Purchases', 'Suppliers', 'Reports', 'Settings', 'User Management'],
  Cashier: ['POS Billing', 'Barcode Scanner'],
  'Inventory Staff': ['Inventory', 'Purchases', 'Suppliers']
};

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const { user, token, refreshToken } = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      onLogin(user, token, refreshToken);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login">
      <div className="login-brand">
        <div className="mark">RM</div>
        <h1>Smarter store operations start here.</h1>
      </div>
      <form className="login-card" onSubmit={submit}>
        <h2>Welcome back</h2>
        <label>Email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="error">{error}</p>}
        <button type="submit">Sign in to RM POS →</button>
      </form>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [page, setPage] = useState('');
  const [version, setVersion] = useState('');
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    window.rmpos?.getVersion().then(setVersion);
    if (!getAuthToken()) {
      setAuthReady(true);
      return;
    }
    api('/api/auth/me')
      .then(({ user: currentUser }) => {
        setUser(currentUser);
        setPage(MENU[currentUser.role][0]);
      })
      .catch(() => setAuthToken(null))
      .finally(() => setAuthReady(true));
  }, []);

  if (!authReady) return null;
  if (!user) return <Login onLogin={(nextUser, token, refreshToken) => {
    setAuthToken(token, refreshToken);
    setUser(nextUser);
    setPage(MENU[nextUser.role][0]);
  }} />;

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      setAuthToken(null);
      setUser(null);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="mark">RM</span> RM POS</div>
        {MENU[user.role].map((item) => (
          <button key={item} className={item === page ? 'active' : ''} onClick={() => setPage(item)}>{item}</button>
        ))}
        <div className="side-foot">{user.name} · {user.role}{version && ` · v${version}`}</div>
      </aside>
      <main className="main">
        <header className="topbar">
          <b>{page}</b>
          <button onClick={logout}>Log out</button>
        </header>
        <section className="content">
          {page === 'Reports' ? (
            <ReportsModule />
          ) : (
            <>
              <h1>{page}</h1>
              <p>Build this screen next — copy the layout from the HTML prototype.</p>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
