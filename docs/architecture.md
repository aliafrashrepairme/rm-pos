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
- **Version 1 needs internet.** If the API can't be reached, POS shows a clear message and blocks sales. It does not queue them.

## Roles

Permissions are stored in the database and enforced by the API. Hiding a menu item is only a convenience.

| Area | Owner | Manager | Cashier | Inventory Staff |
|---|---|---|---|---|
| Dashboard | | Yes | | |
| Daily and Monthly Transactions | View | View | | |
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
| AI Invoice Scan | | Yes | | |
| Import/Export, lists, settings | | Yes | | |
| User management, audit log | | Yes | | |

Cashiers read the selling catalogue through a separate response that leaves out cost prices.

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

**AI invoice scan**
- `Uploaded -> Processing -> Extracted or Failed -> Approved or Rejected`.
- Approval creates a purchase, and stock then moves through normal receiving.
- Lines below 80% confidence need a person to confirm them.
- With no provider configured, the screen says so and offers manual entry. It never shows sample results.

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
  middleware/         auth, requirePermission, rate limit, errors
  routes/             one file per module: thin, HTTP only
  services/           business logic and database calls
  validation/         input checks shared by routes
  providers/          invoice extraction interface and implementations
  supabase/migrations numbered SQL files, never edited once applied
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
  app/          routes, login state, permission checks
  components/   shared table, modal, card, toast (ported from the prototype)
  features/     pos, products, inventory, purchases, suppliers, customers,
                transactions, reports, users, settings, aiscan, ...
  i18n/         t() function using the prototype's English, Tamil and Sinhala text
  styles/       the prototype's CSS
```

- The prototype's CSS and page layouts are ported as they are.
- Its generated HTML strings and page-rewriting translator are replaced by React components and `t()`.
- Pages and buttons check permissions from the signed-in user. The API checks again.

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

Migrations in `server/supabase/migrations/` are applied in number order. `0001` refuses to run if the starter tables hold real users or transactions. `server/supabase/schema.sql` and `server/data/rm-pos.sqlite` are removed once the API has moved over in Phase 3.
