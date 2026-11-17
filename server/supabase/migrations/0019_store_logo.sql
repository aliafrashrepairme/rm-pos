-- The Owner can replace the store logo shown in the sidebar, on the sign-in screen and on printed bills.
-- The image lives in private storage; this column holds its path, and '' means the built-in logo.

alter table public.store_settings add column logo_path text not null default '';

insert into public.permissions (code, description) values ('settings.logo', 'Change the store logo')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code) values ('Owner', 'settings.logo')
on conflict do nothing;
