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

Run `server/supabase/schema.sql` in the Supabase SQL Editor to create the tables, row-level security policies, and transactional inventory functions. Create users in Supabase Authentication, then add a matching `profiles` row using that user's Auth ID and one of the roles `Owner`, `Manager`, `Cashier`, or `Inventory Staff`.

For each Auth user, add its application profile in the SQL Editor, replacing the example UUID and account details:

```sql
insert into public.profiles (id, name, role, email)
values ('AUTH_USER_UUID', 'Store Manager', 'Manager', 'manager@example.com');
```

`npm run dev` starts three things together: the React dev server (Vite), Electron, and the API on port 4000. The backend requires Node.js 22.13 or newer and loads `.env` from the repository root.

The API includes authenticated product, sales, stock movement, supplier, purchase, and report routes. Sale, purchase, and inventory-adjustment writes use Postgres functions so stock changes and their history records commit atomically. Start the API by itself with `npm --prefix server run dev`; run its local startup checks with `npm --prefix server test`.

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
