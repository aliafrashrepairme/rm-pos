# Going live

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
6. Under **Authentication > Emails > Reset Password**, include `{{ .Token }}` in the template, because the app asks for a code rather than opening a link.

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
3. Enter the three Supabase values when asked. Add `ANTHROPIC_API_KEY` only if you want AI invoice scanning.
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
- If AI scanning is on, scan one real invoice and check every line. Invoice files are sent to Anthropic to be read.

Keep the shop PCs on mains power with a steady connection. The app needs the internet: an offline sale keeps its cart and only completes once the connection returns.

## Updating later

1. **Database changes:** run only the new migration files on the live project's SQL Editor, in number order. Never run `fresh-project.sql` again.
2. **Server changes:** in Render, choose **Manual Deploy** on the service. Automatic deploys are off, so a push can't change the live shop by accident.
3. **Desktop changes:** raise the version in `package.json`, run `npm run dist` and install it on each PC.

## Backups and problems

- Supabase keeps the daily backups under **Database > Backups**. Also use **Import / Export** for regular CSV copies you keep yourself.
- If the app can't connect, open `/api/health/ready`. A `503` means the server can't reach the database, so check the Supabase dashboard. No reply means the server is down, so check Render's logs.
- Never run `npm --prefix server run test:live` against the live project. It's only for the test project.
- If a key may have leaked, create a new one in Supabase or Anthropic, then update Render and `.env.live`.
