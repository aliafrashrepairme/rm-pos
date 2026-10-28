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
