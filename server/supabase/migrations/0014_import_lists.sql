-- CSV imports save all rows or none, and the Audit Log can list which actions exist.

create function public.import_records(p_type text, p_rows jsonb, p_user uuid) returns integer
language plpgsql set search_path = public, pg_temp as $$
declare
  v_row jsonb;
  v_count integer := 0;
begin
  if p_type not in ('products', 'customers', 'suppliers') then
    raise exception 'Choose what to import.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no rows to import.' using errcode = 'P0001';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) with ordinality order by ordinality loop
    case p_type
      when 'products' then perform public.create_product(v_row, p_user);
      when 'customers' then perform public.add_customer(v_row);
      when 'suppliers' then perform public.create_supplier(v_row);
    end case;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create function public.audit_actions() returns text[]
language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(action order by action), '{}') from (select distinct action from public.audit_logs) found;
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array['import_records(text, jsonb, uuid)', 'audit_actions()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
