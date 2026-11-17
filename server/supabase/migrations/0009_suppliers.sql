-- Supplier figures from real orders. Two active suppliers can't share a name.

create unique index suppliers_active_name_key on public.suppliers (lower(name)) where active;

-- On time: fully received by the expected date. An open order past its date counts as late.
-- Orders with no expected date, or not yet due, can't be judged and are left out.
create function public.supplier_stats(p_supplier uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with settings as (
    select time_zone, (now() at time zone time_zone)::date as today from public.store_settings
  ), orders as (
    select po.id, po.status, po.expected_at, po.total, po.paid_total,
      (select (max(gr.received_at) at time zone s.time_zone)::date from public.goods_receipts gr where gr.purchase_id = po.id) as delivered_on,
      s.today
    from public.purchases po cross join settings s
    where po.supplier_id = p_supplier
  ), judged as (
    select case
      when status = 'Received' and expected_at is not null then delivered_on <= expected_at
      when status in ('Ordered', 'Partially Received') and expected_at < today then false
    end as on_time
    from orders
  )
  select jsonb_build_object(
    'orders', (select count(*) from orders where status <> 'Cancelled'),
    'openOrders', (select count(*) from orders where status in ('Ordered', 'Partially Received')),
    'purchased', coalesce((select sum(total) from orders where status not in ('Draft', 'Cancelled')), 0),
    'paid', coalesce((select sum(paid_total) from orders where status not in ('Draft', 'Cancelled')), 0),
    'balance', coalesce((select sum(total - paid_total) from orders where status not in ('Draft', 'Cancelled')), 0),
    'judged', (select count(*) from judged where on_time is not null),
    'onTimePercent', (select round(100.0 * count(*) filter (where on_time) / nullif(count(*), 0)) from judged where on_time is not null),
    'products', (select count(*) from public.products where preferred_supplier_id = p_supplier and active)
  );
$$;

create function public.supplier_list(p_search text, p_status text, p_limit integer, p_offset integer) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with matched as (
    select * from public.suppliers s
    where (p_status = 'all' or s.active = (p_status = 'active'))
      and (coalesce(p_search, '') = '' or s.name ilike '%' || p_search || '%' or s.code ilike '%' || p_search || '%'
        or s.contact_person ilike '%' || p_search || '%' or s.phone ilike '%' || p_search || '%' or s.city ilike '%' || p_search || '%')
  ), page as (
    select * from matched order by lower(name), id limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'balance', coalesce((select sum(po.total - po.paid_total) from public.purchases po join matched m on m.id = po.supplier_id where po.status not in ('Draft', 'Cancelled')), 0),
    'rows', coalesce((select jsonb_agg(to_jsonb(page) || jsonb_build_object('stats', public.supplier_stats(page.id)) order by lower(page.name), page.id) from page), '[]'::jsonb)
  );
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array['supplier_stats(uuid)', 'supplier_list(text, text, integer, integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
