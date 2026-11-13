# RM POS

Hardware store POS desktop app — **React + Electron** front end with a **Node.js (Express)** API.

To put it into real use, follow [docs/deployment.md](docs/deployment.md).

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

Run the files in `server/supabase/migrations/` in number order in the Supabase SQL Editor, then confirm the result with `npm --prefix server run db:check`. Create staff accounts with `npm --prefix server run user:create`, which keeps the password hidden. This is the only way to create an Owner.

For email password resets, edit the **Reset Password** template under Supabase Authentication > Emails so it includes `{{ .Token }}`, because the desktop app asks for a code rather than opening a link. Staff without an email ask their Manager for a reset.

`npm run dev` starts three things together: the React dev server (Vite), Electron, and the API on port 4000. The backend requires Node.js 22.13 or newer and loads `.env` from the repository root.

The API lives in `server/`: `app.js` builds it, and `routes/`, `services/`, `middleware/` and `validation/` hold the modules. `docs/architecture.md` explains the design. Start the API by itself with `npm --prefix server run dev`, and run its tests with `npm --prefix server test`. `npm --prefix server run test:live` checks login and permissions against the real Supabase project using disabled `smoke.*` accounts. `GET /api/health/ready` reports whether the database can be reached.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development (hot reload) |
| `npm run build` | Build the React UI into `dist/` |
| `npm run dist` | Build a Windows installer into `release/`, connected to the hosted server |
| `npm test` | Run the front-end tests |
| `npm --prefix server test` | Run the API and database tests |
| `npm --prefix server run db:bundle` | Join the migrations into one file for a new Supabase project |

## Team workflow

1. `git pull` before you start work.
2. Make a branch: `git checkout -b feature/pos-billing`
3. Commit small changes: `git commit -m "Add POS bill box"`
4. Push and open a Pull Request: `git push -u origin feature/pos-billing`
