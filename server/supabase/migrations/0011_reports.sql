-- Report totals from real records, in store time. They follow the Daily and Monthly rules:
-- voided bills count for nothing, and a refund counts in the period it was refunded.

create function public.report_period(p_preset text, p_from date, p_to date, p_now timestamptz default now()) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_zone text;
  v_today date;
  v_from date;
  v_to date;
begin
  select time_zone into v_zone from public.store_settings;
  v_today := (p_now at time zone v_zone)::date;
  v_to := v_today;
  case p_preset
    when 'today' then v_from := v_today;
    when 'yesterday' then v_from := v_today - 1; v_to := v_today - 1;
    when 'last7' then v_from := v_today - 6;
    when 'last30' then v_from := v_today - 29;
    when 'thisMonth' then v_from := date_trunc('month', v_today)::date;
    when 'lastMonth' then
      v_from := (date_trunc('month', v_today) - interval '1 month')::date;
      v_to := (date_trunc('month', v_today) - interval '1 day')::date;
    when 'thisYear' then v_from := date_trunc('year', v_today)::date;
    when 'custom' then
      if p_from is null or p_to is null then raise exception 'Choose a start and end date.' using errcode = 'P0001'; end if;
      if p_from > p_to then raise exception 'Start date must not be after end date.' using errcode = 'P0001'; end if;
      if p_to - p_from > 3660 then raise exception 'Choose a period of ten years or less.' using errcode = 'P0001'; end if;
      v_from := p_from;
      v_to := p_to;
    else raise exception 'Choose a valid date range.' using errcode = 'P0001';
  end case;
  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'start', v_from::timestamp at time zone v_zone,
    'end', (v_to + 1)::timestamp at time zone v_zone,
    'timeZone', v_zone
  );
end;
$$;

create function public.report_sales(p_period jsonb, p_group text, p_category text, p_product uuid) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_zone text := p_period ->> 'timeZone';
  v_start timestamptz := (p_period ->> 'start')::timestamptz;
  v_end timestamptz := (p_period ->> 'end')::timestamptz;
  v_group text := case when p_group in ('day', 'week', 'month', 'year') then p_group else 'day' end;
begin
  return (
    with sold as (
      select s.id as sale_id, si.product_id, si.name, si.sku, si.category_name, si.qty, si.line_total as amount,
        date_trunc(v_group, s.created_at at time zone v_zone)::date as bucket
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      where s.status <> 'Voided' and s.created_at >= v_start and s.created_at < v_end
        and (p_category is null or si.category_name = p_category)
        and (p_product is null or si.product_id = p_product)
    ), returned as (
      select si.product_id, si.name, si.sku, si.category_name, ri.qty, ri.amount,
        date_trunc(v_group, r.created_at at time zone v_zone)::date as bucket
      from public.refund_items ri
      join public.refunds r on r.id = ri.refund_id
      join public.sale_items si on si.id = ri.sale_item_id
      where r.created_at >= v_start and r.created_at < v_end
        and (p_category is null or si.category_name = p_category)
        and (p_product is null or si.product_id = p_product)
    ), lines as (
      select product_id, name, sku, category_name, qty, amount, bucket, sale_id from sold
      union all
      select product_id, name, sku, category_name, -qty, -amount, bucket, null from returned
    ), totals as (
      select
        coalesce((select sum(amount) from sold), 0) as gross,
        coalesce((select sum(amount) from returned), 0) as refunds,
        (select count(distinct sale_id) from sold) as orders,
        coalesce((select sum(qty) from lines), 0) as items
    )
    select jsonb_build_object(
      'period', p_period,
      'group', v_group,
      'totals', (select jsonb_build_object(
        'gross', gross, 'refunds', refunds, 'net', gross - refunds, 'orders', orders, 'items', items,
        'average', case when orders > 0 then round(gross / orders, 2) else 0 end
      ) from totals),
      'trend', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'date', moment::date,
          'revenue', coalesce((select sum(amount) from lines l where l.bucket = moment::date), 0),
          'orders', (select count(distinct sale_id) from sold o where o.bucket = moment::date),
          'refunds', coalesce((select sum(amount) from returned b where b.bucket = moment::date), 0)
        ) order by moment), '[]'::jsonb)
        from generate_series(
          date_trunc(v_group, (p_period ->> 'from')::date::timestamp),
          (p_period ->> 'to')::date::timestamp,
          ('1 ' || v_group)::interval
        ) as series(moment)
      ),
      'categories', (
        select coalesce(jsonb_agg(row_to_json(c)::jsonb order by c.revenue desc, c.category), '[]'::jsonb)
        from (select category_name as category, sum(qty) as qty, sum(amount) as revenue from lines group by category_name) c
      ),
      'products', (
        select coalesce(jsonb_agg(row_to_json(p)::jsonb order by p.revenue desc, p.name), '[]'::jsonb)
        from (
          select product_id as "productId", max(name) as name, max(sku) as sku, max(category_name) as category, sum(qty) as qty, sum(amount) as revenue
          from lines group by product_id
        ) p
      )
    )
  );
end;
$$;

create function public.report_payments(p_period jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_zone text := p_period ->> 'timeZone';
  v_start timestamptz := (p_period ->> 'start')::timestamptz;
  v_end timestamptz := (p_period ->> 'end')::timestamptz;
begin
  return (
    with paid as (
      select p.method_code, p.amount, (p.created_at at time zone v_zone)::date as day
      from public.payments p
      join public.sales s on s.id = p.sale_id
      where s.status <> 'Voided' and p.created_at >= v_start and p.created_at < v_end
    ), returned as (
      select method_code, total as amount, (created_at at time zone v_zone)::date as day
      from public.refunds
      where created_at >= v_start and created_at < v_end
    )
    select jsonb_build_object(
      'period', p_period,
      'totals', jsonb_build_object(
        'collected', coalesce((select sum(amount) from paid), 0),
        'refunds', coalesce((select sum(amount) from returned), 0),
        'net', coalesce((select sum(amount) from paid), 0) - coalesce((select sum(amount) from returned), 0),
        'payments', (select count(*) from paid)
      ),
      'methods', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'method', m.code,
          'payments', (select count(*) from paid where method_code = m.code),
          'collected', coalesce((select sum(amount) from paid where method_code = m.code), 0),
          'refunds', coalesce((select sum(amount) from returned where method_code = m.code), 0)
        ) order by m.code), '[]'::jsonb)
        from public.payment_methods m
      ),
      'trend', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'date', moment::date,
          'revenue', coalesce((select sum(amount) from paid where day = moment::date), 0) - coalesce((select sum(amount) from returned where day = moment::date), 0)
        ) order by moment), '[]'::jsonb)
        from generate_series((p_period ->> 'from')::date::timestamp, (p_period ->> 'to')::date::timestamp, interval '1 day') as series(moment)
      )
    )
  );
end;
$$;

create function public.report_inventory() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with stock as (
    select p.stock_qty, p.min_stock, p.cost_price, c.name as category
    from public.products p
    join public.categories c on c.id = p.category_id
    where p.active
  )
  select jsonb_build_object(
    'products', (select count(*) from stock),
    'low', (select count(*) from stock where stock_qty > 0 and stock_qty <= min_stock),
    'out', (select count(*) from stock where stock_qty <= 0),
    'value', coalesce((select sum(round(stock_qty * cost_price, 2)) from stock), 0),
    'categories', (
      select coalesce(jsonb_agg(row_to_json(g)::jsonb order by g.value desc, g.category), '[]'::jsonb)
      from (
        select category, count(*) as products, sum(stock_qty) as stock, sum(round(stock_qty * cost_price, 2)) as value
        from stock group by category
      ) g
    )
  );
$$;

create function public.report_stock_totals(p_period jsonb, p_product uuid, p_type text) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'stockIn', coalesce(sum(change_qty) filter (where change_qty > 0), 0),
    'stockOut', coalesce(-sum(change_qty) filter (where change_qty < 0), 0)
  )
  from public.inventory_ledger
  where created_at >= (p_period ->> 'start')::timestamptz and created_at < (p_period ->> 'end')::timestamptz
    and (p_product is null or product_id = p_product)
    and (p_type is null or movement_type = p_type);
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'report_period(text, date, date, timestamptz)',
    'report_sales(jsonb, text, text, uuid)',
    'report_payments(jsonb)',
    'report_inventory()',
    'report_stock_totals(jsonb, uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
