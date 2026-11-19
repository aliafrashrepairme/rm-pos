# RM POS

Point-of-sale and stock system for RM Hardware Store: billing, cash shifts, products, stock, purchasing, suppliers, customers, reports and staff, in English, Tamil and Sinhala. It runs as a Windows desktop app that talks to its own API server, which keeps the data in Supabase.

To put it into real use in a shop, follow [docs/deployment.md](docs/deployment.md).

## Technology

| Part | Technology |
|---|---|
| Desktop app | Electron 45, with a React 19 interface built by Vite 8 |
| API server | Node.js 22.13+ with Express 5 |
| Database and sign-in | Supabase (Postgres, Auth, private Storage for product photos) |
| Barcodes | ZXing reader (camera, photo, USB scanner); store barcodes generated as EAN-13 starting 20 |
| Tests | Node's built-in test runner; PGlite runs the SQL migrations in memory |

## How it fits together

```text
RM POS window (Electron + React)
   │  HTTPS, signed-in token
   ▼
API server (Express) ── checks sign-in and permission on every request
   │  secret key, server only
   ▼
Supabase (Postgres functions for anything touching money or stock)
```

- The desktop app only ever holds the public address of the API. It never holds a database key.
- Every route checks the signed-in user's role on the server. The screens hide what a role can't use, and the API refuses it again.
- Sales, refunds, stock changes, deliveries and shift closing run as single Postgres functions, so two tills can't oversell or double-post.

The design and business rules are in [docs/architecture.md](docs/architecture.md). The original screen design is [docs/prototype.html](docs/prototype.html).

## Folder structure

```text
rm-pos/
├─ electron/                 Desktop shell: opens the window, printing, PDF saving, camera permission
├─ src/                      React interface
│  ├─ main.jsx, App.jsx      Start-up and the screen switcher
│  ├─ api.js                 The one place the app calls the API (sign-in token, refresh, errors)
│  ├─ app/                   App-wide pieces: sign-in screens, layout and menu, role checks,
│  │                         formatting, barcode helpers, list loading and screen refresh hooks
│  ├─ components/            Shared UI: modal, pager, status badge, toast, barcode image, printing
│  ├─ features/              One folder per screen or module
│  │  ├─ pos/                POS billing, held orders, customer picker, camera scan
│  │  ├─ products/           Product list and form
│  │  ├─ inventory/          Stock, movements, adjustments, stock counts
│  │  ├─ purchases/          Purchase orders and deliveries
│  │  ├─ suppliers/, customers/
│  │  ├─ transactions/       Bills register, daily and monthly transactions
│  │  ├─ shifts/             Cash shifts and expenses
│  │  ├─ reports/            Sales, payment and inventory reports
│  │  ├─ barcode/            Barcode scanner, barcode generation and label printing
│  │  ├─ dashboard/, users/, settings/, data/ (import, export, audit log)
│  ├─ i18n/                  English, Tamil and Sinhala text and the t() function
│  ├─ styles/                The prototype's CSS and app styles
│  └─ assets/                Logo
├─ server/                   API server
│  ├─ index.js, app.js       Start-up, and the Express app (built separately so tests can run it)
│  ├─ config.js, db.js       Reads and checks the settings; creates the Supabase clients
│  ├─ middleware/            Sign-in, permissions, security headers, rate limits, errors
│  ├─ routes/                One file per module, HTTP only
│  ├─ services/              Business logic and database calls
│  ├─ validation/            Input checks shared by routes
│  ├─ supabase/migrations/   Numbered SQL files; never edit one that has been applied
│  ├─ scripts/               Database check, migrations, create staff, end-to-end live check
│  └─ test/                  API, permission and database tests
├─ scripts/                  Build checks (the installer refuses a local or non-HTTPS API address)
├─ build/                    Installer icon
├─ docs/                     Architecture, deployment guide, design prototype
├─ render.yaml               Hosting settings for the API server on Render
└─ .env.example              Names of every setting, with no real values
```

Barcodes: a scanned code that is already saved shows its product, and a product can never be saved with a barcode another product uses (the message names that product). Products saved without a barcode get one from **Barcode labels → Generate missing barcodes**; products that have a barcode keep it. Daily backups, restore and monitoring are described in [docs/recovery.md](docs/recovery.md).

## Getting started

You need Node.js 22.13 or newer, Git, and internet the first time Electron starts (it downloads itself then).

```bash
git clone https://github.com/aliafrashrepairme/rm-pos.git
cd rm-pos
git switch dev
npm install
npm --prefix server install
```

On Windows PowerShell, type `npm.cmd` instead of `npm` if scripts are blocked.

## Settings files

The app reads its settings from files in the project folder. They hold secret keys, so git ignores them and they are never committed.

| File | Used by | Points to |
|---|---|---|
| `.env` | `npm run dev` | A **test** Supabase project |
| `.env.live` | `npm run live` | The **real shop's** Supabase project |
| `.env.production` | `npm run dist` | Only `VITE_API_URL`, the hosted API's HTTPS address |

Copy `.env.example` to `.env` and fill in:

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the publishable key) and `SUPABASE_SERVICE_ROLE_KEY` (the secret key), from the Supabase project's settings.
- `VITE_API_URL`, the API address the app calls. Leave it as `http://localhost:4000` for development.
- Optional: `CORS_ORIGINS` and `TRUST_PROXY` for hosting.

The server stops at start-up if a required setting is missing. Only `VITE_` settings reach the app's screens, so never give a secret a `VITE_` name.

## Database setup

For a new Supabase project:

1. Run `npm --prefix server run db:bundle`. It joins every migration into `server/supabase/fresh-project.sql`.
2. Paste that file into the project's **SQL Editor** and run it **once**. A second run stops with a "depends on" error and changes nothing.
3. In **Authentication**, turn off **Allow new users to sign up**. Staff accounts are made by the app, not by sign-up.
4. Check the result with `npm --prefix server run db:check`.
5. Create the first accounts with `npm --prefix server run user:create`. It hides the password, and it's the only way to create an Owner.

For an existing project, run only the new files in `server/supabase/migrations/`, in number order. Tables can only be read through the API server: the public key is refused everywhere.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app on the test database (`.env`), with the API on port 4000 |
| `npm run live` | Run the app on the real shop's database (`.env.live`), with the API on port 4100 |
| `npm test` | Front-end tests |
| `npm --prefix server test` | API, permission and database tests |
| `npm --prefix server run test:live` | End-to-end check against the `.env` project. Add `-- --with-sales` to include sales, which stay in that database |
| `npm --prefix server run db:check` | Confirm the database has every table and function |
| `npm --prefix server run db:bundle` | Build the one-file setup script for a new project |
| `npm --prefix server run user:create` | Create a staff account on the `.env` project (`live:user-create` for `.env.live`) |
| `npm run build` | Build the interface into `dist/` |
| `npm run dist` | Build the Windows installer into `release/`, connected to the hosted API |

Only one copy of the app can run at a time. Close one before starting the other.

If the server tests run out of memory on a busy PC, run them one file at a time: `cd server`, then `node --test --test-concurrency=1`.

## Production build and deployment

1. Host the API server, for example with [render.yaml](render.yaml) on Render, and give it the `.env.live` values as environment variables.
2. Put the hosted HTTPS address in `.env.production` as `VITE_API_URL`.
3. Run `npm run dist`. It refuses a local or non-HTTPS address, so an installer can't point at a test server.

The full checklist is in [docs/deployment.md](docs/deployment.md).

## API

All routes are under `/api`. `GET /api/health` and `GET /api/logo` answer without signing in; everything else needs a signed-in token.

| Prefix | Module |
|---|---|
| `/api/auth` | Sign in, refresh, sign out, change and reset password, preferences |
| `/api/dashboard` | Dashboard figures |
| `/api/products`, `/api/categories` | Products and categories |
| `/api/inventory` | Stock, movements, adjustments, counts |
| `/api/barcode` | Barcode lookup, count scanning, generating missing barcodes, labels |
| `/api/pos` | Catalogue, sales, held orders, POS customers |
| `/api/transactions` | Bills, refunds, voids, daily and monthly figures |
| `/api/purchases`, `/api/suppliers`, `/api/customers` | Purchasing, suppliers, customers |
| `/api/shifts` | Cash shifts and expenses |
| `/api/reports` | Sales, payment and inventory reports |
| `/api/users`, `/api/settings`, `/api/lists` | Staff, store settings, lists such as units and tax rates |
| `/api/logo` | Store logo: anyone can read it, only the Owner changes it |
| `/api/backups` | List, make and download daily backups (Manager) |
| `/api/system/status` | Database health, backup age, uptime and errors (Manager) |
| `/api/data`, `/api/audit` | Import, export, audit log |

Errors are always `{ "error": "message" }` with a matching status code. The request rules are in [docs/architecture.md](docs/architecture.md), and each module's routes are in `server/routes/`.

## Security notes

- Passwords are stored by Supabase Auth (bcrypt). The app never sees or stores them.
- The database's secret key stays on the API server. The installer contains no keys.
- Every table has row-level security with no policies, so the public key can't read or change anything.
- The API sends security headers, limits each address to 600 requests a minute, and locks an account from an address for 15 minutes after 5 wrong passwords.
- Important actions (sign-ins, sales, refunds, stock changes, staff changes) are written to the audit log, which can't be edited.
- The desktop window is sandboxed and may only use the camera.

## Team workflow

1. Work on your own branch, for example `feature/your-name`, and `git pull` before you start.
2. Commit small changes with clear messages, such as `fix(pos): ...` or `feat(reports): ...`.
3. Push your branch and open a pull request into `dev`. The testing team tests `dev`.
4. `main` gets a pull request from `dev` only for a release.
5. Never commit `.env`, `.env.live` or `.env.production`.
