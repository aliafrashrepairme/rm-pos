-- Each scan during a stock count adds one in a single statement, so two scanners can't lose a count.
-- A product the count didn't include is added with its stock at this moment as the expected quantity.

create function public.scan_stock_count(p_count_id uuid, p_product_id uuid) returns numeric
language plpgsql set search_path = public, pg_temp as $$
declare
  v_status text;
  v_counted numeric;
begin
  select status into v_status from public.stock_counts where id = p_count_id for share;
  if not found then raise exception 'NOT_FOUND:Stock count not found.' using errcode = 'P0001'; end if;
  if v_status <> 'In Progress' then
    raise exception 'CONFLICT:This count has already been submitted.' using errcode = 'P0001';
  end if;

  insert into public.stock_count_lines (stock_count_id, product_id, system_qty, counted_qty)
  select p_count_id, id, stock_qty, 1 from public.products where id = p_product_id
  on conflict (stock_count_id, product_id)
  do update set counted_qty = coalesce(public.stock_count_lines.counted_qty, 0) + 1
  returning counted_qty into v_counted;

  if v_counted is null then raise exception 'NOT_FOUND:Product not found.' using errcode = 'P0001'; end if;
  return v_counted;
end;
$$;

revoke all on function public.scan_stock_count(uuid, uuid) from public, anon, authenticated;
grant execute on function public.scan_stock_count(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
