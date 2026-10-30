-- Dashboard figures, calculated from sales, refunds, products and the audit log.
-- Days and months follow the store's time zone, wherever the API is hosted.

alter table public.store_settings add column time_zone text not null default 'Asia/Colombo';

-- Sales made in the period, less money refunded in the period. Voided bills don't count.
create function public.sales_totals(p_start timestamptz, p_end timestamptz) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'gross', sold.gross,
    'refunds', returned.refunds,
    'net', sold.gross - returned.refunds,
    'orders', sold.orders
  )
  from (
    select coalesce(sum(grand_total), 0) as gross, count(*) as orders
    from public.sales
    where status <> 'Voided' and created_at >= p_start and created_at < p_end
  ) sold,
  (
    select coalesce(sum(total), 0) as refunds
    from public.refunds
    where created_at >= p_start and created_at < p_end
  ) returned;
$$;

create function public.dashboard_summary(p_now timestamptz default now()) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_zone text;
  v_local timestamp;
  v_today date;
  v_month date;
  v_today_start timestamptz;
  v_month_start timestamptz;
begin
  select time_zone into v_zone from public.store_settings;
  v_local := p_now at time zone v_zone;
  v_today := v_local::date;
  v_month := date_trunc('month', v_local)::date;
  v_today_start := v_today::timestamp at time zone v_zone;
  v_month_start := v_month::timestamp at time zone v_zone;

  return jsonb_build_object(
    'timeZone', v_zone,
    'today', public.sales_totals(v_today_start, p_now),
    -- Compared up to the same moment, so a morning isn't measured against a whole day.
    'yesterday', public.sales_totals(v_today_start - interval '1 day', p_now - interval '1 day'),
    'month', public.sales_totals(v_month_start, p_now),
    'lastMonth', public.sales_totals(
      (v_month - interval '1 month')::timestamp at time zone v_zone,
      (v_local - interval '1 month') at time zone v_zone
    ),
    'products', (
      select jsonb_build_object(
        'total', count(*),
        'low', count(*) filter (where stock_qty > 0 and stock_qty <= min_stock),
        'out', count(*) filter (where stock_qty <= 0)
      )
      from public.products where active
    ),
    'dailySales', (
      select jsonb_agg(jsonb_build_object(
        'date', day,
        'total', (public.sales_totals(
          day::timestamp at time zone v_zone,
          least((day + 1)::timestamp at time zone v_zone, p_now)
        ) ->> 'net')::numeric
      ) order by day)
      from generate_series(v_today - 13, v_today, interval '1 day') as series(moment)
      cross join lateral (select moment::date as day) as days
    ),
    'lowStock', (
      select coalesce(jsonb_agg(item order by item_rank nulls first, item ->> 'name'), '[]')
      from (
        select
          jsonb_build_object(
            'id', p.id,
            'name', p.name,
            'location', p.location,
            'stock', p.stock_qty,
            'minStock', p.min_stock,
            'unit', p.unit_code,
            'supplier', s.name
          ) as item,
          p.stock_qty / nullif(p.min_stock, 0) as item_rank
        from public.products p
        left join public.suppliers s on s.id = p.preferred_supplier_id
        where p.active and p.stock_qty <= p.min_stock
        order by p.stock_qty / nullif(p.min_stock, 0) nulls first, p.name
        limit 5
      ) ranked
    ),
    'tasks', jsonb_build_object(
      'toReceive', (select count(*) from public.purchases where status in ('Ordered', 'Partially Received')),
      'pendingAdjustments', (select count(*) from public.stock_adjustments where status = 'Pending'),
      'openCounts', (select count(*) from public.stock_counts where status = 'In Progress'),
      'submittedCounts', (select count(*) from public.stock_counts where status = 'Submitted')
    ),
    'recentSales', (
      select coalesce(jsonb_agg(row_data order by created_at desc), '[]')
      from (
        select
          sale.created_at,
          jsonb_build_object(
            'id', sale.id,
            'billNo', sale.bill_no,
            'customer', sale.customer_name,
            'cashier', staff.full_name,
            'total', sale.grand_total,
            'status', sale.status,
            'createdAt', sale.created_at
          ) as row_data
        from public.sales sale
        join public.profiles staff on staff.id = sale.cashier_id
        order by sale.created_at desc
        limit 8
      ) recent
    ),
    -- Sign-ins are left out, because they would crowd out the business events.
    'activity', (
      select coalesce(jsonb_agg(row_data order by id desc), '[]')
      from (
        select
          id,
          jsonb_build_object(
            'id', id,
            'user', user_name,
            'action', action,
            'description', description,
            'createdAt', created_at
          ) as row_data
        from public.audit_logs
        where action not in ('User login', 'User logout', 'Login failed')
        order by id desc
        limit 8
      ) latest
    )
  );
end;
$$;

revoke all on function public.sales_totals(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.dashboard_summary(timestamptz) from public, anon, authenticated;
grant execute on function public.sales_totals(timestamptz, timestamptz) to service_role;
grant execute on function public.dashboard_summary(timestamptz) to service_role;

notify pgrst, 'reload schema';
