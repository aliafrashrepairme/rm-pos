-- The shop does not want Managers to see AI Invoice Scan or Monthly Transactions.
-- Monthly figures get their own permission, kept for the Owner, so Managers keep Daily Transactions.
-- AI Invoice Scan stays in the code, so granting ai_scan.use again switches it back on.

update public.permissions set description = 'View daily transactions' where code = 'transactions.view';

insert into public.permissions (code, description) values ('transactions.monthly', 'View monthly transactions')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code) values ('Owner', 'transactions.monthly')
on conflict do nothing;

delete from public.role_permissions where role_code = 'Manager' and permission_code = 'ai_scan.use';
