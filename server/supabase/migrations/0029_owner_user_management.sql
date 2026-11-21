-- Owners can manage staff accounts while keeping their other operational permissions unchanged.
insert into public.role_permissions (role_code, permission_code)
values ('Owner', 'users.manage')
on conflict do nothing;

update public.roles
set description = 'Store owner: view reports and manage users, counters, printers and the store logo'
where code = 'Owner';

notify pgrst, 'reload schema';
