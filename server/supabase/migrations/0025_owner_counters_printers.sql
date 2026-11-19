-- Counters and printers are set up by the Owner.
-- Counters live in the database. Printers belong to each computer, so the desktop app keeps that
-- choice on the computer itself; printers.manage only decides who sees the Printers screen.

insert into public.permissions (code, description) values
  ('counters.manage', 'Add, rename and switch off cash counters'),
  ('printers.manage', 'Choose the receipt, label and document printers on a computer')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code) values
  ('Owner', 'counters.manage'), ('Owner', 'printers.manage')
on conflict do nothing;

-- Adds a counter, or renames / switches one on or off when an id is given.
-- A counter someone is working on can't be switched off, or their open shift would be stranded.
create function public.save_counter(p_id uuid, p_name text, p_active boolean) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_name text := nullif(trim(p_name), '');
  v_old public.counters%rowtype;
  v_id uuid := p_id;
begin
  if v_name is null or length(v_name) > 40 then
    raise exception 'Enter a counter name of up to 40 characters.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.counters where lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'CONFLICT:A counter with this name already exists.' using errcode = 'P0001';
  end if;

  if p_id is null then
    insert into public.counters (name, active) values (v_name, coalesce(p_active, true)) returning id into v_id;
    return jsonb_build_object('id', v_id, 'name', v_name, 'created', true);
  end if;

  select * into v_old from public.counters where id = p_id for update;
  if not found then raise exception 'NOT_FOUND:Counter not found.' using errcode = 'P0001'; end if;
  if v_old.active and not coalesce(p_active, true)
     and exists (select 1 from public.shifts where counter_id = p_id and status = 'Open') then
    raise exception 'CONFLICT:A shift is open on this counter. Close it before switching the counter off.' using errcode = 'P0001';
  end if;
  update public.counters set name = v_name, active = coalesce(p_active, active) where id = p_id;
  return jsonb_build_object('id', p_id, 'name', v_name, 'oldName', v_old.name, 'wasActive', v_old.active, 'active', coalesce(p_active, v_old.active), 'created', false);
end;
$$;

revoke all on function public.save_counter(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.save_counter(uuid, text, boolean) to service_role;

notify pgrst, 'reload schema';
