# Backup, recovery and monitoring

What RM POS does on its own, what someone has to set up once, and what to do when something breaks.

## Automated backups

- The API server makes a full backup of the database once a day: every table, read in one
  statement so the copy is consistent. It checks every hour and backs up when the newest copy is
  a day old, so a server that was asleep catches up as soon as it wakes.
- Backups are JSON files in the private `backups` storage bucket of the Supabase project. The
  newest 14 are kept; older ones are deleted.
- A Manager can see them in **Backups & Status**, make one with **Back up now**, and **Download**
  a copy. Download one at least once a week and keep it off the cloud (USB drive or a private
  drive folder): if the whole Supabase project were lost, the bucket would go with it.
- Product photos and the store logo are not inside the backup file; they stay in their own
  storage buckets. Products without photos still work after a restore.
- `BACKUPS=off` in the server settings turns the schedule off, for example on a developer PC.

With the Supabase **Pro plan**, Supabase also keeps its own daily backups and can add
point-in-time recovery. Turn this on for the live project before launch.

## Restoring a backup

A restore **replaces all data** with the backup. It runs in one transaction: if anything fails,
nothing changes.

1. Download the backup to restore (Backups & Status > Download, or from the `backups` bucket in the
   Supabase dashboard).
2. Make sure the target database has every migration: `npm --prefix server run db:migrate`.
3. Put `SUPABASE_DB_URL` for the target project in `.env` (Project Settings > Database).
4. Run `npm --prefix server run db:restore -- path\to\rm-pos-backup-....json --yes`.
5. Sign in and check today's bills, stock of a few products, and the user list.

Restoring into the **same** project (the usual case, after wrong data was saved) brings everything
back and staff sign in as before. Restoring into a **new** project brings back all shop data, but
staff sign-ins live in Supabase Auth, which the backup does not hold: the developer must create
each account again with the same user ID as its old profile, and staff then set new passwords.

## Monitoring

- `GET /api/health` answers when the API is up; `GET /api/health/ready` also checks the database.
- Every API request writes one JSON line to the server log (method, path, status, time). Errors
  are marked `"level":"error"`. On Render these are under the service's **Logs** tab.
- **Backups & Status** shows database connection, last backup (and whether it is overdue),
  uptime, requests, server errors and slow requests since the server started.
- Every sale, refund, stock change, user change, backup and download is in the **Audit Log**.

### Uptime alerts (set up once)

1. Create a free account at an uptime service such as UptimeRobot or Better Stack.
2. Add an HTTP monitor for `https://<your-api-address>/api/health/ready`, checking every 5 minutes.
3. Add the owner's and developer's email (or phone) as alert contacts.
4. On Render, also turn on **Notifications** for failed deploys and crashes.

## When something goes wrong

| What you see | First step |
| --- | --- |
| App says it cannot reach the server | Open `/api/health` in a browser. No answer: check Render's Logs and restart the service. |
| `/api/health` works but `/api/health/ready` does not | Supabase is down or paused: open the Supabase dashboard and restore or resume the project. |
| Wrong data was saved or deleted | Find the change in the Audit Log. Fix it by hand if small; otherwise restore the last good backup. |
| Backup shows **Overdue** | Check the server log for `backup.failed`, then press **Back up now**. |
| Supabase project lost | Create a new project, run the migrations, recreate staff accounts, restore the newest downloaded backup. |
