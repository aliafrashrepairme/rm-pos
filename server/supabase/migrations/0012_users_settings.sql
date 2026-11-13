-- Staff changes and tax defaults, kept safe against two people acting at once.

-- Owner accounts can't be changed here, nobody can change their own role or status,
-- and the store always keeps at least one active Manager.
create function public.update_staff(p_actor uuid, p_target uuid, p_changes jsonb) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_target public.profiles%rowtype;
  v_role text := p_changes ->> 'role';
  v_active boolean := (p_changes ->> 'active')::boolean;
begin
  perform 1 from public.profiles where role_code = 'Manager' and active order by id for update;
  select * into v_target from public.profiles where id = p_target for update;
  if not found then raise exception 'NOT_FOUND:User not found.' using errcode = 'P0001'; end if;
  if v_target.role_code = 'Owner' then raise exception 'CONFLICT:Owner accounts cannot be changed here.' using errcode = 'P0001'; end if;
  if v_role = 'Owner' then raise exception 'CONFLICT:Owner accounts cannot be created here.' using errcode = 'P0001'; end if;
  if p_actor = p_target and (v_role is distinct from null and v_role <> v_target.role_code or v_active is false) then
    raise exception 'CONFLICT:You cannot change your own role or disable your own account.' using errcode = 'P0001';
  end if;
  if v_target.role_code = 'Manager' and v_target.active
    and (coalesce(v_role, v_target.role_code) <> 'Manager' or v_active is false)
    and not exists (select 1 from public.profiles where role_code = 'Manager' and active and id <> p_target) then
    raise exception 'CONFLICT:The store must keep at least one active Manager.' using errcode = 'P0001';
  end if;

  update public.profiles
  set full_name = coalesce(nullif(trim(p_changes ->> 'fullName'), ''), full_name),
      email = coalesce(p_changes ->> 'email', email),
      role_code = coalesce(v_role, role_code),
      active = coalesce(v_active, active)
  where id = p_target
  returning * into v_target;
  return to_jsonb(v_target);
end;
$$;

create function public.set_default_tax_rate(p_rate uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.tax_rates where id = p_rate and active) then
    raise exception 'NOT_FOUND:Tax rate not found.' using errcode = 'P0001';
  end if;
  update public.tax_rates set is_default = false where is_default and id <> p_rate;
  update public.tax_rates set is_default = true where id = p_rate;
end;
$$;

-- The receipt's existing behaviour stays the default until the Manager changes it.
update public.store_settings
set receipt = '{"size": "80mm", "showTax": true, "showBalance": true, "printAfterSale": false, "footer": ""}'::jsonb || receipt;

do $$
declare
  v_function text;
begin
  foreach v_function in array array['update_staff(uuid, uuid, jsonb)', 'set_default_tax_rate(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
