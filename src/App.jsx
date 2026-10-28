import { useEffect, useState } from 'react';
import { api } from './api.js';

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
      const { user } = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      onLogin(user);
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
        <p className="hint">Demo: manager@rmpos.lk / manager123</p>
      </form>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [page, setPage] = useState('');
  const [version, setVersion] = useState('');

  useEffect(() => {
    window.rmpos?.getVersion().then(setVersion);
  }, []);

  if (!user) return <Login onLogin={(u) => { setUser(u); setPage(MENU[u.role][0]); }} />;

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
          <button onClick={() => setUser(null)}>Log out</button>
        </header>
        <section className="content">
          <h1>{page}</h1>
          <p>Build this screen next — copy the layout from the HTML prototype.</p>
        </section>
      </main>
    </div>
  );
}
