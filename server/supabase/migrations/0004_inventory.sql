-- Stock views, adjustments and stock counts. All stock changes go through post_stock_movement.

create function public.inventory_list(
  p_search text default '',
  p_category_id uuid default null,
  p_state text default 'all',
  p_limit integer default 25,
  p_offset integer default 0
) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with matched as (
    select p.*, c.name as category_name, s.name as supplier_name
    from public.products p
    join public.categories c on c.id = p.category_id
    left join public.suppliers s on s.id = p.preferred_supplier_id
    where p.active
      and (p_category_id is null or p.category_id = p_category_id)
      and (coalesce(p_search, '') = '' or p.name ilike '%' || p_search || '%' or p.sku ilike '%' || p_search || '%' or p.barcode ilike '%' || p_search || '%')
      and case p_state
        when 'out' then p.stock_qty <= 0
        when 'low' then p.stock_qty > 0 and p.stock_qty <= p.min_stock
        when 'in' then p.stock_qty > 0 and p.stock_qty > p.min_stock
        else true
      end
  ), page as (
    select * from matched order by name, id limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'sku', sku, 'barcode', barcode, 'name', name, 'category', category_name, 'location', location,
      'unit', unit_code, 'stock', stock_qty, 'minStock', min_stock, 'costPrice', cost_price,
      'value', round(stock_qty * cost_price, 2), 'supplier', supplier_name
    ) order by name, id) from page), '[]'::jsonb)
  );
$$;

create function public.inventory_summary() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with stock as (
    select p.*, c.name as category_name,
      round(p.stock_qty * p.cost_price, 2) as cost_value,
      round(p.stock_qty * p.selling_price, 2) as retail_value
    from public.products p
    join public.categories c on c.id = p.category_id
    where p.active
  ), by_category as (
    select category_name, count(*) as products, sum(stock_qty) as units, sum(cost_value) as cost_value, sum(retail_value) as retail_value,
      count(*) filter (where stock_qty > 0 and stock_qty <= min_stock) as low,
      count(*) filter (where stock_qty <= 0) as out
    from stock group by category_name
  )
  select jsonb_build_object(
    'products', (select count(*) from stock),
    'units', (select coalesce(sum(stock_qty), 0) from stock),
    'costValue', (select coalesce(sum(cost_value), 0) from stock),
    'retailValue', (select coalesce(sum(retail_value), 0) from stock),
    'low', (select count(*) from stock where stock_qty > 0 and stock_qty <= min_stock),
    'out', (select count(*) from stock where stock_qty <= 0),
    'categories', coalesce((select jsonb_agg(jsonb_build_object(
      'category', category_name, 'products', products, 'units', units, 'costValue', cost_value,
      'retailValue', retail_value, 'low', low, 'out', out
    ) order by cost_value desc, category_name) from by_category), '[]'::jsonb)
  );
$$;

-- Only Managers can adjust stock, so saving an adjustment is also its approval.
create function public.post_stock_adjustment(p_reason text, p_note text, p_lines jsonb, p_created_by uuid) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_no text;
  v_line record;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one product.' using errcode = 'P0001';
  end if;
  v_no := public.next_document_number('ADJ-');
  insert into public.stock_adjustments (adjustment_no, reason, note, status, created_by, decided_by, decided_at)
  values (v_no, p_reason, coalesce(p_note, ''), 'Approved', p_created_by, p_created_by, now())
  returning id into v_id;

  -- Fixed product order, so two adjustments at once can't deadlock.
  for v_line in
    select (value ->> 'productId')::uuid as product_id, (value ->> 'change')::numeric as change_qty
    from jsonb_array_elements(p_lines)
    order by 1
  loop
    insert into public.stock_adjustment_lines (stock_adjustment_id, product_id, change_qty)
    values (v_id, v_line.product_id, v_line.change_qty);
    perform public.post_stock_movement(v_line.product_id, 'Adjustment', v_line.change_qty, p_reason, 'stock_adjustment', v_id::text, v_no, p_created_by);
  end loop;
  return v_id;
end;
$$;

-- Records system quantities now, so later sales are not lost when the count is approved.
create function public.start_stock_count(p_name text, p_category_id uuid, p_low_only boolean, p_blind boolean, p_created_by uuid) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_scope text := 'Full store';
begin
  if p_low_only then v_scope := 'Below reorder level'; end if;
  if p_category_id is not null then
    select name into v_scope from public.categories where id = p_category_id;
    if not found then raise exception 'NOT_FOUND:Category not found.' using errcode = 'P0001'; end if;
  end if;

  insert into public.stock_counts (count_no, name, scope, blind, created_by)
  values (public.next_document_number('SC-'), p_name, v_scope, p_blind, p_created_by)
  returning id into v_id;

  insert into public.stock_count_lines (stock_count_id, product_id, system_qty)
  select v_id, id, stock_qty from public.products
  where active
    and (p_category_id is null or category_id = p_category_id)
    and (not coalesce(p_low_only, false) or stock_qty <= min_stock);

  if not exists (select 1 from public.stock_count_lines where stock_count_id = v_id) then
    raise exception 'No products match this scope.' using errcode = 'P0001';
  end if;
  return v_id;
end;
$$;

create function public.set_stock_count_line(p_count_id uuid, p_product_id uuid, p_counted numeric) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_status text;
  v_allow_decimal boolean;
begin
  select status into v_status from public.stock_counts where id = p_count_id for share;
  if not found then raise exception 'NOT_FOUND:Stock count not found.' using errcode = 'P0001'; end if;
  if v_status <> 'In Progress' then
    raise exception 'CONFLICT:This count has already been submitted.' using errcode = 'P0001';
  end if;
  select u.allow_decimal_qty into v_allow_decimal
  from public.products p join public.units u on u.code = p.unit_code where p.id = p_product_id;
  if p_counted is not null and not coalesce(v_allow_decimal, false) and p_counted <> trunc(p_counted) then
    raise exception 'INVALID_QTY:This product is counted in whole units.' using errcode = 'P0001';
  end if;
  update public.stock_count_lines set counted_qty = p_counted
  where stock_count_id = p_count_id and product_id = p_product_id;
  if not found then raise exception 'NOT_FOUND:This product is not part of the count.' using errcode = 'P0001'; end if;
end;
$$;

-- Items left uncounted keep their system quantity, as the screen warns before submitting.
create function public.submit_stock_count(p_count_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  select status into v_status from public.stock_counts where id = p_count_id for update;
  if not found then raise exception 'NOT_FOUND:Stock count not found.' using errcode = 'P0001'; end if;
  if v_status <> 'In Progress' then
    raise exception 'CONFLICT:This count has already been submitted.' using errcode = 'P0001';
  end if;
  update public.stock_count_lines set counted_qty = system_qty where stock_count_id = p_count_id and counted_qty is null;
  update public.stock_counts set status = 'Submitted', submitted_at = now() where id = p_count_id;
end;
$$;

create function public.reopen_stock_count(p_count_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  update public.stock_counts set status = 'In Progress', submitted_at = null where id = p_count_id and status = 'Submitted';
  if not found then raise exception 'CONFLICT:Only a submitted count can be re-opened.' using errcode = 'P0001'; end if;
end;
$$;

-- The row lock and status check mean a count can only ever post once.
-- Sales during the count stay counted: the difference is applied to the stock at this moment.
create function public.approve_stock_count(p_count_id uuid, p_decided_by uuid) returns integer
language plpgsql set search_path = public, pg_temp as $$
declare
  v_count public.stock_counts%rowtype;
  v_line record;
  v_current numeric;
  v_change numeric;
  v_posted integer := 0;
begin
  select * into v_count from public.stock_counts where id = p_count_id for update;
  if not found then raise exception 'NOT_FOUND:Stock count not found.' using errcode = 'P0001'; end if;
  if v_count.status <> 'Submitted' then
    raise exception 'CONFLICT:Only a submitted count can be approved.' using errcode = 'P0001';
  end if;

  for v_line in
    select product_id, counted_qty - system_qty as variance
    from public.stock_count_lines
    where stock_count_id = p_count_id and counted_qty <> system_qty
    order by product_id
  loop
    select stock_qty into v_current from public.products where id = v_line.product_id for update;
    v_change := greatest(v_line.variance, -v_current);
    if v_change <> 0 then
      perform public.post_stock_movement(v_line.product_id, 'Count', v_change, 'Stock count ' || v_count.name, 'stock_count', p_count_id::text, v_count.count_no, p_decided_by);
      v_posted := v_posted + 1;
    end if;
  end loop;

  update public.stock_counts set status = 'Approved', decided_by = p_decided_by, decided_at = now() where id = p_count_id;
  return v_posted;
end;
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'inventory_list(text, uuid, text, integer, integer)',
    'inventory_summary()',
    'post_stock_adjustment(text, text, jsonb, uuid)',
    'start_stock_count(text, uuid, boolean, boolean, uuid)',
    'set_stock_count_line(uuid, uuid, numeric)',
    'submit_stock_count(uuid)',
    'reopen_stock_count(uuid)',
    'approve_stock_count(uuid, uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
