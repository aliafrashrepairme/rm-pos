# Going live

## Offline LAN installation

The offline installer (`npm run dist:offline`) carries its own API server and PGlite database. No Docker, Supabase project or internet connection is needed.

1. Build the installer with `npm run dist:offline`. It is saved as `release\RM POS Setup <version>.exe`.
2. Close any running RM POS, then run the installer on the shop PC.
3. Open RM POS. On the first start it creates the database in `%APPDATA%\RM POS\database` and four accounts: `owner`, `manager`, `inventory` and `cashier`. The starting passwords are in `server/local-db.js`.
4. Sign in as each account and change its password straight away.
5. Sign in as `manager` (or `inventory`) to add categories and products. Sell as `cashier` after opening a shift.
6. Back up by closing RM POS and copying the whole `%APPDATA%\RM POS\database` folder to a USB drive or cloud drive. Do it daily. The in-app backup screen does not work in offline mode yet.

### Installing on another PC

The installer holds everything RM POS needs: the app, its own copy of Node.js, the API server, the PGlite database engine and all table definitions. The other PC does not need Node.js, Git, PostgreSQL, Docker or this project folder.

| | |
|---|---|
| Operating system | Windows 10 or 11, 64-bit (x64). Windows on ARM, macOS and Linux installers are not built |
| Memory | 4 GB RAM minimum, 8 GB recommended |
| Disk | About 400 MB for the app, plus room for the shop's data (it starts at about 30 MB) |
| Screen | 1280 × 720 or larger |
| Camera (optional) | Any webcam, for camera scanning. A USB barcode scanner works without setup and is faster |
| Printer (optional) | Any Windows printer driver; receipt printers are chosen in Settings |
| Internet | Not needed |

First run on a new PC:

1. Copy `RM POS Setup <version>.exe` to the PC (USB drive or download) and run it. It installs for the current Windows user only, so it does not need administrator rights.
2. The installer is not code-signed, so Windows SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**.
3. On first opening, Windows Firewall may ask whether RM POS can use networks. Click **Cancel** (or allow only Private networks): a single PC does not need network access, and blocking it keeps other devices from reaching the sign-in page.
4. RM POS creates an empty database with the four starting accounts. Each PC has its own data; nothing is copied from the PC the installer was built on.
5. Change all four passwords before real use.

To move a shop's data to a new PC, close RM POS on both PCs and copy the whole `%APPDATA%\RM POS\database` folder across.

To set a forgotten password, close RM POS and run `npm --prefix server run local:password-reset -- USERNAME NEWPASSWORD` from the project folder.

**One PC only.** Every PC with the offline build starts its own server and keeps its own separate database. Installing it on two counters gives two shops' worth of data that never meet. A shared second counter needs a build that points at the first PC's address, which this installer does not do.

This puts RM POS into real use with a new, empty database. The app has three parts:

- **Database (Supabase):** holds all the shop's records.
- **API server (Render):** checks logins and permissions, and holds the secret keys.
- **Desktop app (installer):** runs on each shop PC and talks to the API server.

Never paste passwords or keys into chat, and never commit them to Git. The service-role key and the database address stay off the shop PCs.

Prices below were checked in November 2026. Confirm them on each company's pricing page.

## 1. Create the database

1. In Supabase, create a **new project** in the Singapore region. Do not reuse the test project, which holds test sales.
2. Use the **Pro plan** (from $25 a month). It gives daily backups kept for 7 days. Free projects have no daily backups and pause after a week of inactivity.
3. On your PC, run `npm --prefix server run db:bundle`. This creates `server/supabase/fresh-project.sql`.
4. Paste that whole file into the new project's SQL Editor and run it once.
5. Under **Authentication > Sign In / Providers**, turn off **Allow new users to sign up**. Staff accounts are only created through the app or the command below.
6. There is no emailed password reset. A Manager resets staff passwords from User Management, and the person then picks a new one at their next sign-in. The Owner's password is reset from the Supabase dashboard (Authentication > Users).

## 2. Save the live settings on your PC

Create a file named `.env.live` in the project folder. Git ignores it.

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

Fill these in from the new project's API settings. Your normal `.env` stays on the test project, so development can't touch real records. Then check the database:

```
npm --prefix server run live:db-check
```

## 3. Host the API server

1. Push this code to GitHub.
2. In Render, choose **New > Blueprint**, pick this repository and branch. It reads `render.yaml`.
3. Enter the three Supabase values when asked.
4. The Starter plan is $7 a month. Do not use the free plan: it sleeps after 15 minutes without use, so the first sale afterwards can wait about a minute.
5. Open `https://YOUR-SERVER.onrender.com/api/health/ready`. It must show `"database":"connected"`.

## 4. Build the installer

Create a file named `.env.production` in the project folder, with your server's address:

```
VITE_API_URL=https://YOUR-SERVER.onrender.com
```

Then run `npm run dist`. It refuses to build unless the address is a hosted `https` one. The installer is in `release/`.

## 5. Create the first account

```
npm --prefix server run live:user-create
```

Choose **Owner** first, then create a **Manager**, who can add the other staff from the app. The Owner role can view reports but cannot change settings.

## 6. Set up the shop

Install the app on each PC. Windows shows a SmartScreen warning because the installer is not code-signed: choose **More info > Run anyway**. Then sign in as the Manager and:

1. Enter the store name, address, phone and VAT number in **Settings**. These start blank and print on receipts.
2. Check tax rates, payment methods and receipt options.
3. Review the `WELCOME10` first-purchase coupon, which comes with the system.
4. Import or add categories, products with opening stock, suppliers and customers.

## 7. Check before the first real sale

Try these on the shop's real equipment:

- Scan known and unknown barcodes with the scanner, and the webcam if you will use it.
- Print a receipt and a barcode label. Check the thermal printer doesn't feed blank paper.
- Open and close a shift, make a sale, refund it and count the cash.
- Sign in with each role.

Keep the shop PCs on mains power with a steady connection. The app needs the internet and does not queue sales offline. If the connection drops during checkout, the bill stays on screen; after service returns, retry the sale. A request ID makes that retry safe if the server saved the sale but its reply was lost.

## Updating later

1. **Database changes:** run only the new migration files on the live project's SQL Editor, in number order. Never run `fresh-project.sql` again.
2. **Server changes:** in Render, choose **Manual Deploy** on the service. Automatic deploys are off, so a push can't change the live shop by accident.
3. **Desktop changes:** raise the version in `package.json`, run `npm run dist` and install it on each PC.

## Backups and problems

- Supabase keeps the daily backups under **Database > Backups**. Also use **Import / Export** for regular CSV copies you keep yourself.
- If the app can't connect, open `/api/health/ready`. A `503` means the server can't reach the database, so check the Supabase dashboard. No reply means the server is down, so check Render's logs.
- Never run `npm --prefix server run test:live` against the live project. It's only for the test project.
- If a key may have leaked, create a new one in Supabase, then update Render and `.env.live`.
