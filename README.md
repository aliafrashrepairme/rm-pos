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

`npm run dev` starts three things together: the React dev server (Vite), the Electron window, and the API on port 4000.

Demo login: `manager@rmpos.lk` / `manager123`

If the window does not open and you see "Electron failed to install correctly", run
`node node_modules/electron/install.js` once to download the Electron binary.

## Barcode scanner

Screen: **Barcode Scanner** (Cashier login: `cashier@rmpos.lk` / `cashier123`). Scan a product and its
name, price, stock, location and supplier appear on screen.

Ways to scan — all go through the same lookup:

| Input | How it works |
|---|---|
| USB / Bluetooth scanner | Acts as a keyboard. Works anywhere on the screen; fast key bursts ending in Enter are treated as a scan, normal typing is ignored. |
| Camera (webcam) | Decoded live with [ZXing](https://github.com/zxing-js/browser). Same barcode is reported once while it stays in view. |
| Photo | Upload a picture of a barcode. |
| Manual | Type a barcode or SKU (e.g. `RM-1003`). |

No AI model is trained or needed: barcodes are a fixed standard, and ZXing decodes them exactly.
EAN-13 / EAN-8 / UPC-A check digits are verified, so a misread shows **"Barcode misread"** instead of
the wrong product. Supported: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, ITF, QR.

API: `GET /api/products/lookup?code=<barcode or SKU>` → `200 { product }`, `404` not in catalog,
`422` failed check digit, `400` missing code. Demo products use barcodes `4791234` + SKU number + check
digit (e.g. LED Bulb `RM-1003` → `4791234010038`), the same as the prototype's printed labels.

Code: `src/scanner/` (screen, camera, USB-scanner hook, decoder), `shared/barcode.js` (validation,
used by UI and API), `server/data/catalog.js` (temporary product data — swap for the database).

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
