# RM POS architecture

The design agreed in Phase 2. `docs/prototype.html` remains the reference for screens and wording. Where the prototype and this document differ on business rules, this document wins.

## System overview

```text
Shop PCs (Electron + React)
        |  HTTPS, signed-in user's token
        v
Hosted Node API (Express)      <- checks login and permissions, holds the secret key
        |
        v
Supabase (Auth, Postgres, Storage)
        ^
Invoice extraction provider    <- called only by the API
```

- **The secret key stays on the server.** The Supabase service-role key can do anything in the database, so it is never placed in the desktop app. The app only knows the API's address.
- **The browser never talks to the database.** Every table has row level security on and no access for public roles.
- **Cloud mode needs internet.** The hosted API is unavailable when the internet is down, and cloud mode blocks sales while disconnected.
- **Offline mode runs the API and a PGlite database inside the desktop app.** It needs no internet or Supabase. Data is stored in `%APPDATA%\RM POS\database` on that PC; each installed PC has its own database. `server/local-db.js` answers the same query calls the services make to Supabase, so the services do not change between modes.

## Roles

Permissions are stored in the database and enforced by the API. Hiding a menu item is only a convenience.

| Area | Owner | Manager | Cashier | Inventory Staff |
|---|---|---|---|---|
| Dashboard | | Yes | | |
| Daily Transactions | View | View | | |
| Monthly Transactions | View | | | |
| Sales and payment reports | View, print, export | Yes | | |
| Inventory reports | View, print, export | Yes | | Yes |
| POS, held orders, payments | | | Yes | |
| Bills Register | | View | Yes | |
| Print or download customer bills | | | Yes | |
| Refund and void | | Yes | | |
| Own shift and its expenses | | | Yes | |
| All shifts, all expenses | | Yes | | |
| Customers | | Yes | Yes | |
| Barcode scanner | | Yes | Yes | Yes |
| Barcode labels | | Yes | | |
| Products, including cost prices | | Yes | | Yes |
| Stock counts | | Create, approve | | Create, submit |
| Stock adjustments | | Yes | | |
| Purchases, receiving, suppliers | | Yes | | Yes |
| Supplier payments | | Yes | | |
| Import/Export, lists, settings | | Yes | | |
| User management, audit log | | Yes | | |
| Store logo | Change | | | |

Cashiers read the selling catalogue through a separate response that leaves out cost prices.

Sessions:
- Tokens last for the app window, so closing it on a shared PC signs the person out.
- Five failed attempts lock that account from that address for 15 minutes.
- A temporary password allows only the account routes until it is changed.

Account rules:
- Nobody can change their own role or disable themselves.
- A Manager cannot view, edit or create Owner accounts.
- Staff with any history are disabled, not deleted.

## Business rules

**Money**
- Prices exclude VAT, and the default rate is 18%.
- Amounts are stored to the cent and never rounded to whole rupees.
- The API calculates every total from database prices, and ignores totals sent by the app.
- Discount per line = line amount x discount rate. VAT applies to the amount after discount. Each is rounded per line, and the bill total is the sum of the lines.

**Sales**
- A sale runs as one database transaction: bill number, lines, payments, stock and loyalty points. If any part fails, nothing is saved.
- Each checkout attempt carries a unique request ID, so a retry returns the first sale instead of creating another.
- Selling more than the available stock is rejected.
- Products are locked in a fixed order, so two sales at once can't deadlock.
- A void cancels a whole bill and restores all its stock. A refund covers chosen items and quantities, and the Manager decides whether each returns to stock. Damaged goods don't.
- Reports count money refunded in the period it was refunded.

**Stock**
- Stock changes only through `post_stock_movement`, which also writes the ledger. Database triggers block any other route.
- Ledger and audit records cannot be edited or deleted.
- Counts snapshot system quantities when created. On approval, the variance is posted against the stock at that moment, so sales made during the count aren't lost.

**Purchasing**
- `Draft -> Ordered -> Partially Received -> Received`, or `Cancelled` before anything is received.
- Stock is added only when a goods receipt is posted, so creating a purchase changes nothing.
- Each receipt has a unique request ID and can't exceed the quantity still outstanding, so it can't add stock twice.
- A supplier invoice number can only be used once per supplier.

**AI invoice scan (removed)**
- The screen, its API routes and the Anthropic reader were removed at the shop's request. Supplier invoices are entered by hand in Purchases.
- Its tables and database functions (migration 0013) stay, because applied migrations are never edited and old purchase orders created from a scan still show an AI badge.

**Identifiers**
- Document numbers are sequential and gap-free, such as `RM-INV-000123`.
- SKUs default to `RM-000123`.
- Generated barcodes are EAN-13 in the in-store range starting with `2`. Manufacturer barcodes can be entered instead.

## Backend structure

```text
server/
  index.js            starts the server
  app.js              builds the Express app, so tests can run it
  config.js           reads and checks environment settings
  db.js               cloud mode: creates the Supabase clients
  local-db.js         offline mode: PGlite database, first-start setup, Supabase-style query adapter
  data/               development-only offline database (ignored by git)
  middleware/         auth, requirePermission, login limit, security headers and request limit, errors
  routes/             one file per module: thin, HTTP only
  services/           business logic and database calls, including the invoice extractor
  validation/         input checks shared by routes
  supabase/migrations numbered SQL files, never edited once applied
  scripts/            database check and setup bundle, staff creation, end-to-end live check
  test/
```

A request goes through: route, login check, permission check, validation, service, then a Postgres function for anything touching money or stock.

API conventions:
- All routes sit under `/api`.
- Errors are `{ "error": "message" }` with a matching status: 400 invalid, 401 not signed in, 403 not allowed, 404 missing, 409 conflict.
- Lists accept `page`, `pageSize`, `q` and `sort`, and return a total count. Results are never silently cut off.
- Report totals are calculated in the database.

## Frontend structure

```text
src/
  api.js        the one place that calls the API: token, refresh, errors
  app/          sign-in screens, layout and menu, permission checks, formatting,
                list loading and screen refresh hooks
  components/   shared modal, pager, status badge, toast, barcode image, printing
  features/     one folder per module: pos, products, inventory, purchases,
                suppliers, customers, transactions, shifts, reports, barcode,
                dashboard, users, settings, data
  i18n/         t() function using the prototype's English, Tamil and Sinhala text
  styles/       the prototype's CSS
```

- The prototype's CSS and page layouts are ported as they are.
- Its generated HTML strings and page-rewriting translator are replaced by React components and `t()`.
- Pages and buttons check permissions from the signed-in user. The API checks again.

## Offline drafts (cloud mode)

When the server can't be reached, billing and quotations keep working from data saved on the device. Final posting needs the server: offline work is a **draft** until it is sent.

| Saved on the device (IndexedDB, `src/offline/store.js`) | Purpose |
|---|---|
| Products for sale and POS options (no cost prices) | Search, scan and price bills offline. Refreshed at sign-in, every 10 minutes and when the connection returns |
| Draft bills and quotations (the outbox) | Sent automatically when the connection returns |
| The bill being rung up (`localStorage`, per user) | Survives closing the app, a refresh or a power cut. Signing out clears it |
| An offline sign-in record per person | A PBKDF2-SHA-256 hash (310,000 rounds) of the password from the last online sign-in, never the password itself |

Rules:

- **No duplicates.** Each draft carries the request ID the online screen would have sent. The server keeps one record per ID (`sales.client_request_id`, `quotations.client_request_id` from migration 0030) and returns the same bill or quotation when it is sent again, so a lost reply or a retry never makes a copy.
- **Bill numbers and dates are given when the draft reaches the server**, and the server checks stock, prices, coupons and the open shift at that moment, exactly as for an online sale.
- **Status:** each draft is waiting, sending, sent or failed (the top bar shows it). A dropped connection, a server restart or an expired sign-in leaves it waiting. A refusal from the server (for example, the price changed) marks it failed with the reason, and it waits for a person: **Try again**, or **Open in POS** to ring it up again (this removes the refused draft first, so it can't be sent twice). A waiting draft can't be removed.
- **Who sends it.** Drafts are sent only while the person who made them is signed in with the server, so every bill is recorded under the cashier who made it.
- **Offline sign-in** works for staff who signed in online on the device in the last 14 days, with the same password. It opens a session without a server token: drafts only. Changing the password on the device removes the old record. A password reset or a disabled account elsewhere takes effect at the next online sign-in, and the server refuses that person's drafts until then.
- **Needs a connection:** credit sales and loyalty points (they depend on balances only the server knows), holding a bill, editing a quotation, and every other screen.
- Two devices selling the last item offline both succeed locally; the second draft fails at the server with "not enough stock" and waits for a person.

## Desktop app

- The renderer has context isolation and the sandbox on, Node integration off, a content security policy, and blocked navigation to other sites.
- The preload script exposes only named actions, such as printing a receipt.
- Pages load through a custom `app://` protocol rather than `file://`, which gives camera access and CORS a stable origin.
- Installer output goes to `release/`, separate from Vite's `dist/`.

## Hardware and external services

| Need | Approach | Requires from the store |
|---|---|---|
| USB barcode scanner | Reads as fast keyboard input | A scanner in keyboard mode |
| Camera scanning | Decoding library, because `BarcodeDetector` isn't expected on Windows | A webcam |
| Receipts | Electron printing | An 80mm printer |
| Tamil and Sinhala PDFs | Rendered by Electron from the receipt page, which keeps these scripts intact | Nothing extra |
| Card payments | Recorded manually with a reference; no terminal connection | Any card terminal |
| Invoice extraction | Replaceable provider, Claude API first | An API key, paid per scan |

## Delivery

Work follows the 21 phases in order, on `feature/mayuriga`. Each phase ends with tests and a commit. Changes reach `dev` by pull request, and nothing is pushed directly to `main`.

Migrations in `server/supabase/migrations/` are applied in number order. `0001` refuses to run if the starter tables hold real users or transactions. The original starter schema is kept only as a test fixture in `server/test/fixtures/`. `server/data/rm-pos.sqlite` is no longer used. `npm --prefix server run db:check` confirms the live database matches the migrations.
