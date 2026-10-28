// RM POS API (Node + Express)
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// TEMPORARY demo users — replace with a real database and hashed passwords (bcrypt) before going live.
const users = [
  { name: 'Store Owner', role: 'Owner', email: 'owner@rmpos.lk', password: 'owner123' },
  { name: 'R. Manager', role: 'Manager', email: 'manager@rmpos.lk', password: 'manager123' },
  { name: 'N. Perera', role: 'Cashier', email: 'cashier@rmpos.lk', password: 'cashier123' },
  { name: 'K. Fernando', role: 'Inventory Staff', email: 'inventory@rmpos.lk', password: 'inventory123' }
];

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'rm-pos-server' }));

app.post('/api/auth/login', (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const user = users.find((u) => u.email === email.trim().toLowerCase() && u.password === password);
  if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });
  const { password: _hidden, ...safe } = user;
  res.json({ user: safe });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`RM POS API running on http://localhost:${PORT}`));
