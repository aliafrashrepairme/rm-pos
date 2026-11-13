-- Refunds, voids and the figures behind Daily and Monthly Transactions.

alter table public.sales add column points_reversed integer not null default 0 check (points_reversed >= 0);

-- Cancels a whole bill. It only applies before any refund, so stock can't be returned twice.
create function public.void_sale(p_sale_id uuid, p_reason text, p_user uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_sale public.sales%rowtype;
  v_item record;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Enter a reason.' using errcode = 'P0001';
  end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then raise exception 'NOT_FOUND:Bill not found.' using errcode = 'P0001'; end if;
  if v_sale.status <> 'Paid' then
    raise exception 'CONFLICT:Only an unrefunded paid bill can be voided.' using errcode = 'P0001';
  end if;

  for v_item in
    select product_id, qty, unit_cost from public.sale_items where sale_id = p_sale_id order by product_id
  loop
    perform public.post_stock_movement(v_item.product_id, 'Void', v_item.qty, trim(p_reason), 'sale', p_sale_id::text, v_sale.bill_no, p_user, v_item.unit_cost);
  end loop;

  if v_sale.customer_id is not null then
    update public.customers
    set loyalty_points = greatest(loyalty_points - v_sale.points_earned, 0), purchase_count = greatest(purchase_count - 1, 0)
    where id = v_sale.customer_id;
  end if;

  update public.sales
  set status = 'Voided', voided_at = now(), voided_by = p_user, void_reason = trim(p_reason), points_reversed = v_sale.points_earned
  where id = p_sale_id;
end;
$$;

-- Chosen quantities of chosen lines. Damaged goods aren't returned to stock.
-- The last refund of a line takes whatever remains, so rounding can't lose or create a cent.
create function public.refund_sale(p_refund jsonb, p_user uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_request uuid := (p_refund ->> 'clientRequestId')::uuid;
  v_sale_id uuid := (p_refund ->> 'saleId')::uuid;
  v_reason text := trim(p_refund ->> 'reason');
  v_method text := p_refund ->> 'method';
  v_existing record;
  v_sale public.sales%rowtype;
  v_refund_id uuid := gen_random_uuid();
  v_refund_no text;
  v_line record;
  v_item record;
  v_remaining numeric;
  v_previous numeric;
  v_amount numeric;
  v_total numeric := 0;
  v_lines jsonb := '[]';
  v_entry jsonb;
  v_status text;
  v_all_refunded numeric;
  v_points integer;
begin
  if v_request is null then raise exception 'A request ID is required.' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_request::text, 0));
  select id, refund_no into v_existing from public.refunds where client_request_id = v_request;
  if found then
    return jsonb_build_object('id', v_existing.id, 'refundNo', v_existing.refund_no, 'replayed', true);
  end if;

  if coalesce(v_reason, '') = '' then raise exception 'Enter a reason.' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.payment_methods where code = v_method and active) then
    raise exception 'Choose a valid refund method.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_refund -> 'lines') is distinct from 'array' or jsonb_array_length(p_refund -> 'lines') = 0 then
    raise exception 'Choose at least one item to refund.' using errcode = 'P0001';
  end if;

  select * into v_sale from public.sales where id = v_sale_id for update;
  if not found then raise exception 'NOT_FOUND:Bill not found.' using errcode = 'P0001'; end if;
  if v_sale.status not in ('Paid', 'Partially Refunded') then
    raise exception 'CONFLICT:This bill has already been fully refunded or voided.' using errcode = 'P0001';
  end if;

  for v_line in
    select (value ->> 'saleItemId')::uuid as sale_item_id, (value ->> 'qty')::numeric as qty, coalesce((value ->> 'restock')::boolean, true) as restock
    from jsonb_array_elements(p_refund -> 'lines')
  loop
    select si.*, u.allow_decimal_qty into v_item
    from public.sale_items si
    join public.products p on p.id = si.product_id
    join public.units u on u.code = p.unit_code
    where si.id = v_line.sale_item_id and si.sale_id = v_sale_id;
    if not found then raise exception 'NOT_FOUND:This item is not on the bill.' using errcode = 'P0001'; end if;
    if v_line.qty is null or v_line.qty <= 0 or v_line.qty <> round(v_line.qty, 3) then
      raise exception 'Enter a valid refund quantity.' using errcode = 'P0001';
    end if;
    if not v_item.allow_decimal_qty and v_line.qty <> trunc(v_line.qty) then
      raise exception 'INVALID_QTY:% is refunded in whole units.', v_item.name using errcode = 'P0001';
    end if;
    v_remaining := v_item.qty - v_item.refunded_qty;
    if v_line.qty > v_remaining then
      raise exception 'CONFLICT:Only % of % can still be refunded.', v_remaining, v_item.name using errcode = 'P0001';
    end if;

    select coalesce(sum(amount), 0) into v_previous from public.refund_items where sale_item_id = v_item.id;
    v_amount := case when v_line.qty = v_remaining then v_item.line_total - v_previous
      else round(v_item.line_total * v_line.qty / v_item.qty, 2) end;
    v_total := v_total + v_amount;
    v_lines := v_lines || jsonb_build_object(
      'saleItemId', v_item.id, 'productId', v_item.product_id, 'qty', v_line.qty, 'amount', v_amount,
      'restock', v_line.restock, 'unitCost', v_item.unit_cost
    );
  end loop;

  if v_total <= 0 then raise exception 'There is nothing to refund on these items.' using errcode = 'P0001'; end if;

  v_refund_no := public.next_document_number('RF-');
  insert into public.refunds (id, refund_no, client_request_id, sale_id, method_code, reason, total, created_by)
  values (v_refund_id, v_refund_no, v_request, v_sale_id, v_method, v_reason, v_total, p_user);

  -- Fixed product order, so simultaneous stock changes can't deadlock.
  for v_entry in select value from jsonb_array_elements(v_lines) order by value ->> 'productId' loop
    insert into public.refund_items (refund_id, sale_item_id, qty, amount, restock)
    values (v_refund_id, (v_entry ->> 'saleItemId')::uuid, (v_entry ->> 'qty')::numeric, (v_entry ->> 'amount')::numeric, (v_entry ->> 'restock')::boolean);
    update public.sale_items set refunded_qty = refunded_qty + (v_entry ->> 'qty')::numeric where id = (v_entry ->> 'saleItemId')::uuid;
    if (v_entry ->> 'restock')::boolean then
      perform public.post_stock_movement((v_entry ->> 'productId')::uuid, 'Refund', (v_entry ->> 'qty')::numeric, v_reason, 'refund', v_refund_id::text, v_refund_no, p_user, (v_entry ->> 'unitCost')::numeric);
    end if;
  end loop;

  v_status := case when exists (select 1 from public.sale_items where sale_id = v_sale_id and refunded_qty < qty) then 'Partially Refunded' else 'Refunded' end;
  select sum(total) into v_all_refunded from public.refunds where sale_id = v_sale_id;
  v_points := case when v_status = 'Refunded' then v_sale.points_earned
    else least(round(v_sale.points_earned * v_all_refunded / nullif(v_sale.grand_total, 0))::integer, v_sale.points_earned) end - v_sale.points_reversed;
  v_points := greatest(coalesce(v_points, 0), 0);

  if v_sale.customer_id is not null and v_points > 0 then
    update public.customers set loyalty_points = greatest(loyalty_points - v_points, 0) where id = v_sale.customer_id;
  end if;
  update public.sales set status = v_status, points_reversed = points_reversed + v_points where id = v_sale_id;

  return jsonb_build_object('id', v_refund_id, 'refundNo', v_refund_no, 'total', v_total, 'status', v_status, 'replayed', false);
end;
$$;

-- Profit on goods sold, less the profit given back by refunds. Goods not returned to stock lose their cost.
create function public.gross_profit(p_start timestamptz, p_end timestamptz) returns numeric
language sql stable set search_path = public, pg_temp as $$
  select
    coalesce((
      select sum(si.line_total - si.tax_amount - round(si.unit_cost * si.qty, 2))
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      where s.status <> 'Voided' and s.created_at >= p_start and s.created_at < p_end
    ), 0)
    - coalesce((
      select sum(
        round(ri.amount * (si.line_total - si.tax_amount) / nullif(si.line_total, 0), 2)
        - case when ri.restock then round(si.unit_cost * ri.qty, 2) else 0 end
      )
      from public.refund_items ri
      join public.refunds r on r.id = ri.refund_id
      join public.sale_items si on si.id = ri.sale_item_id
      where r.created_at >= p_start and r.created_at < p_end
    ), 0);
$$;

create function public.transactions_daily(p_date date, p_now timestamptz default now()) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_zone text;
  v_today date;
  v_date date;
  v_start timestamptz;
begin
  select time_zone into v_zone from public.store_settings;
  v_today := (p_now at time zone v_zone)::date;
  v_date := least(coalesce(p_date, v_today), v_today);
  v_start := v_date::timestamp at time zone v_zone;
  return jsonb_build_object(
    'timeZone', v_zone,
    'date', v_date,
    'today', v_today,
    'day', public.sales_totals(v_start, (v_date + 1)::timestamp at time zone v_zone),
    'previous', public.sales_totals((v_date - 1)::timestamp at time zone v_zone, v_start),
    'refundCount', (select count(*) from public.refunds where created_at >= v_start and created_at < (v_date + 1)::timestamp at time zone v_zone),
    'days', (
      select jsonb_agg(jsonb_build_object(
        'date', day,
        'total', (public.sales_totals(day::timestamp at time zone v_zone, (day + 1)::timestamp at time zone v_zone) ->> 'net')::numeric
      ) order by day)
      from generate_series(v_date - 13, v_date, interval '1 day') as series(moment)
      cross join lateral (select moment::date as day) as days
    )
  );
end;
$$;

create function public.transactions_monthly(p_year integer, p_month integer, p_now timestamptz default now()) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_zone text;
  v_local timestamp;
  v_this_month date;
  v_month date;
  v_next date;
  v_start timestamptz;
  v_end timestamptz;
  v_compare_end timestamptz;
begin
  select time_zone into v_zone from public.store_settings;
  v_local := p_now at time zone v_zone;
  v_this_month := date_trunc('month', v_local)::date;
  v_month := least(coalesce(make_date(p_year, p_month, 1), v_this_month), v_this_month);
  v_next := (v_month + interval '1 month')::date;
  v_start := v_month::timestamp at time zone v_zone;
  v_end := least(v_next::timestamp at time zone v_zone, p_now);
  -- An unfinished month is compared with the same days of the month before.
  v_compare_end := case when v_month = v_this_month then (v_local - interval '1 month') at time zone v_zone else v_start end;

  return jsonb_build_object(
    'timeZone', v_zone,
    'year', extract(year from v_month)::integer,
    'month', extract(month from v_month)::integer,
    'isCurrent', v_month = v_this_month,
    'totals', public.sales_totals(v_start, v_end),
    'previous', public.sales_totals((v_month - interval '1 month')::timestamp at time zone v_zone, v_compare_end),
    'grossProfit', public.gross_profit(v_start, v_end),
    'refundCount', (select count(*) from public.refunds where created_at >= v_start and created_at < v_end),
    'months', (
      select jsonb_agg(jsonb_build_object(
        'year', extract(year from moment)::integer,
        'month', extract(month from moment)::integer,
        'total', (public.sales_totals(moment::timestamp at time zone v_zone, least((moment + interval '1 month')::timestamp at time zone v_zone, p_now)) ->> 'net')::numeric
      ) order by moment)
      from generate_series(v_this_month - interval '11 months', v_this_month, interval '1 month') as series(moment)
    ),
    'days', (
      select jsonb_agg(jsonb_build_object('date', day, 'totals', public.sales_totals(day::timestamp at time zone v_zone, (day + 1)::timestamp at time zone v_zone)) order by day)
      from generate_series(v_month, least((v_next - 1)::date, v_local::date), interval '1 day') as series(moment)
      cross join lateral (select moment::date as day) as days
    )
  );
end;
$$;

create function public.store_day_bounds(p_date date) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('start', p_date::timestamp at time zone time_zone, 'end', (p_date + 1)::timestamp at time zone time_zone)
  from public.store_settings;
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'void_sale(uuid, text, uuid)',
    'refund_sale(jsonb, uuid)',
    'gross_profit(timestamptz, timestamptz)',
    'transactions_daily(date, timestamptz)',
    'transactions_monthly(integer, integer, timestamptz)',
    'store_day_bounds(date)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
