# RM POS

Hardware store POS desktop app — **React + Electron** front end with a **Node.js (Express)** API.

## Project structure

```
rm-pos/
├─ electron/        Electron main process + preload (Node side of the desktop app)
├─ src/             React UI (screens, components, styles)
├─ server/          Node.js + Express API (login, products, sales, ...)
├─ docs/            HTML prototype (design reference)
├─ index.html       Vite entry
└─ vite.config.js
```

## Getting started

```bash
npm install
npm --prefix server install
npm run dev
```

The API uses Supabase Auth and Postgres. Copy `.env.example` to `.env`, then set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from your Supabase project. Keep the service-role key private; it is only read by the server.

Run the files in `server/supabase/migrations/` in number order in the Supabase SQL Editor, then confirm the result with `npm --prefix server run db:check`. Create users in Supabase Authentication, then add a matching `profiles` row using that user's Auth ID and one of the roles `Owner`, `Manager`, `Cashier`, or `Inventory Staff`.

For each Auth user, add its application profile in the SQL Editor, replacing the example UUID and account details:

```sql
insert into public.profiles (id, username, full_name, email, role_code)
values ('AUTH_USER_UUID', 'manager', 'Store Manager', 'manager@example.com', 'Manager');
```

`npm run dev` starts three things together: the React dev server (Vite), Electron, and the API on port 4000. The backend requires Node.js 22.13 or newer and loads `.env` from the repository root.

The API lives in `server/`: `app.js` builds it, and `routes/`, `services/`, `middleware/` and `validation/` hold the modules. `docs/architecture.md` explains the design. Business modules are being rebuilt phase by phase, so only login, health checks and report reads are available for now. Start the API by itself with `npm --prefix server run dev`, and run its tests with `npm --prefix server test`. `GET /api/health/ready` reports whether the database can be reached.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development (hot reload) |
| `npm run build` | Build the React UI into `dist/` |
| `npm run dist` | Build a Windows installer into `release/` |

## Team workflow

1. `git pull` before you start work.
2. Make a branch: `git checkout -b feature/pos-billing`
3. Commit small changes: `git commit -m "Add POS bill box"`
4. Push and open a Pull Request: `git push -u origin feature/pos-billing`
