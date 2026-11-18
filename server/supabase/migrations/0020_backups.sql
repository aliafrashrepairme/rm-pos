-- Automated backups. backup_snapshot() returns every table in the public schema as one JSON
-- document, read inside a single statement so the copy is consistent (no half-finished sale).
-- The server stores these in private storage; scripts/restore-backup.js loads one back.

create function public.backup_snapshot() returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_table text;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
begin
  for v_table in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by c.relname
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t', v_table) into v_rows;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  return jsonb_build_object('format', 'rm-pos-backup', 'version', 1, 'created_at', now(), 'tables', v_tables);
end;
$$;

revoke all on function public.backup_snapshot() from public, anon, authenticated;
grant execute on function public.backup_snapshot() to service_role;

-- The Manager can see backups, start one and download a copy to keep off site.
insert into public.permissions (code, description) values ('backups.manage', 'View, create and download backups')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code) values ('Manager', 'backups.manage')
on conflict do nothing;

notify pgrst, 'reload schema';
