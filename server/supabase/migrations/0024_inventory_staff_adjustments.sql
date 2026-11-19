-- Stock counts and stock adjustments are for Managers and Inventory Staff only.
-- Managers already have both; Inventory Staff had counts but not adjustments.
-- Approving a count stays with Managers. Safe to run more than once.

insert into public.role_permissions (role_code, permission_code) values ('Inventory Staff', 'adjustments.manage')
on conflict do nothing;
