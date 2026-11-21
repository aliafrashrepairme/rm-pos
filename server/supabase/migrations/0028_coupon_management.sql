-- Coupon management: the Manager adds coupons, switches them on or off, and can limit them to dates.
-- A coupon outside its dates is refused at the till exactly like an unknown code.

alter table public.coupons
  add column valid_from date,
  add column valid_until date,
  add column created_at timestamptz not null default now(),
  add constraint coupons_dates_check check (valid_from is null or valid_until is null or valid_until >= valid_from);

insert into public.permissions (code, description) values
  ('coupons.manage', 'Add, change and switch off coupon codes')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code) values ('Manager', 'coupons.manage')
on conflict do nothing;

-- Today's date in the shop's time zone, so a coupon ends at the shop's midnight.
create function public.shop_today() returns date
language sql stable set search_path = public, pg_temp as $$
  select (now() at time zone (select time_zone from public.store_settings where id))::date;
$$;

revoke all on function public.shop_today() from public, anon, authenticated;
grant execute on function public.shop_today() to service_role;

-- The sale, unchanged from 0026 apart from the coupon's dates being checked.
create or replace function public.create_sale(p_sale jsonb, p_cashier uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_request uuid := (p_sale ->> 'clientRequestId')::uuid;
  v_existing record;
  v_items jsonb := p_sale -> 'items';
  v_customer public.customers%rowtype;
  v_customer_id uuid := nullif(p_sale ->> 'customerId', '')::uuid;
  v_coupon_code text := nullif(upper(trim(p_sale ->> 'couponCode')), '');
  v_coupon public.coupons%rowtype;
  v_rate numeric := 0;
  v_label text := '';
  v_multiplier integer := 1;
  v_regular record;
  v_sale_id uuid := gen_random_uuid();
  v_bill text;
  v_item record;
  v_product record;
  v_qty numeric;
  v_amount numeric;
  v_discount numeric;
  v_tax numeric;
  v_subtotal numeric := 0;
  v_discount_total numeric := 0;
  v_tax_total numeric := 0;
  v_cost_total numeric := 0;
  v_grand numeric;
  v_method public.payment_methods%rowtype;
  v_tendered numeric := (p_sale #>> '{payment,amountTendered}')::numeric;
  v_reference text := coalesce(trim(p_sale #>> '{payment,reference}'), '');
  v_change numeric := 0;
  v_points integer := 0;
  v_redeem integer := coalesce(nullif(p_sale ->> 'pointsToRedeem', '')::integer, 0);
  v_cap integer;
  v_due numeric;
  v_shift uuid;
begin
  if v_request is null then
    raise exception 'A request ID is required.' using errcode = 'P0001';
  end if;

  -- Two identical requests at once take turns, so the second finds the first and returns it.
  perform pg_advisory_xact_lock(hashtextextended(v_request::text, 0));
  select id, bill_no into v_existing from public.sales where client_request_id = v_request;
  if found then
    return jsonb_build_object('id', v_existing.id, 'billNo', v_existing.bill_no, 'replayed', true);
  end if;

  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'The bill is empty. Add a product first.' using errcode = 'P0001';
  end if;
  if (select count(*) <> count(distinct value ->> 'productId') from jsonb_array_elements(v_items)) then
    raise exception 'A product appears twice on this bill.' using errcode = 'P0001';
  end if;

  if v_customer_id is not null then
    select * into v_customer from public.customers where id = v_customer_id for update;
    if not found then raise exception 'NOT_FOUND:Customer not found.' using errcode = 'P0001'; end if;
    if not v_customer.active then raise exception 'CONFLICT:This customer is no longer active.' using errcode = 'P0001'; end if;
  end if;

  if v_coupon_code is not null then
    select * into v_coupon from public.coupons where code = v_coupon_code and active
      and (valid_from is null or valid_from <= public.shop_today())
      and (valid_until is null or valid_until >= public.shop_today());
    if not found then raise exception 'This coupon code is not valid.' using errcode = 'P0001'; end if;
    if v_coupon.first_purchase_only and (v_customer_id is null or v_customer.purchase_count > 0) then
      raise exception '% is only for first-time buyers.', v_coupon.code using errcode = 'P0001';
    end if;
    v_rate := v_coupon.rate;
    v_label := 'Coupon ' || v_coupon.code;
  elsif v_customer_id is not null and v_customer.purchase_count > 0 then
    if v_customer.loyalty_points >= 1000 then
      v_rate := 0.07; v_label := 'Gold member offer'; v_multiplier := 2;
    elsif v_customer.loyalty_points >= 400 then
      v_rate := 0.05; v_label := 'Silver member offer';
    else
      v_rate := 0.03; v_label := 'Bronze member offer';
    end if;
  end if;

  -- Regular customers: enough visits in the recent period earn the regular-customer rate.
  -- Only the best single offer applies, so it wins only when it beats the coupon or member offer.
  if v_customer_id is not null then
    select regular_discount_enabled, regular_min_visits, regular_period_days, regular_discount_rate
      into v_regular from public.store_settings where id;
    if v_regular.regular_discount_enabled and v_regular.regular_discount_rate > v_rate
       and public.recent_visits(v_customer_id, v_regular.regular_period_days) >= v_regular.regular_min_visits then
      v_rate := v_regular.regular_discount_rate;
      v_label := 'Regular customer offer';
      v_coupon_code := null;
      v_multiplier := case when v_customer.loyalty_points >= 1000 then 2 else 1 end;
    end if;
  end if;

  v_bill := public.next_document_number('RM-INV-');
  select id into v_shift from public.shifts where cashier_id = p_cashier and status = 'Open';

  insert into public.sales (id, bill_no, client_request_id, customer_id, customer_name, cashier_id, shift_id, subtotal, grand_total, discount_label, coupon_code)
  values (v_sale_id, v_bill, v_request, v_customer_id, coalesce(v_customer.name, 'Walk-in Customer'), p_cashier, v_shift, 0, 0, v_label, v_coupon_code);

  -- Fixed product order, so two sales at once can't deadlock.
  for v_item in
    select (value ->> 'productId')::uuid as product_id, (value ->> 'qty')::numeric as qty, ordinality as line_no
    from jsonb_array_elements(v_items) with ordinality
    order by 1
  loop
    v_qty := v_item.qty;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
      raise exception 'Enter a valid quantity for every product.' using errcode = 'P0001';
    end if;

    select p.id, p.sku, p.name, p.active, p.selling_price, p.cost_price, t.rate as tax_rate, c.name as category_name
    into v_product
    from public.products p
    join public.tax_rates t on t.id = p.tax_rate_id
    join public.categories c on c.id = p.category_id
    where p.id = v_item.product_id
    for update of p;
    if not found then raise exception 'NOT_FOUND:Product not found.' using errcode = 'P0001'; end if;
    if not v_product.active then
      raise exception 'CONFLICT:% is no longer for sale.', v_product.name using errcode = 'P0001';
    end if;

    v_amount := round(v_product.selling_price * v_qty, 2);
    v_discount := round(v_amount * v_rate, 2);
    v_tax := round((v_amount - v_discount) * v_product.tax_rate / 100, 2);
    v_subtotal := v_subtotal + v_amount;
    v_discount_total := v_discount_total + v_discount;
    v_tax_total := v_tax_total + v_tax;
    v_cost_total := v_cost_total + round(v_product.cost_price * v_qty, 2);

    insert into public.sale_items (sale_id, line_no, product_id, sku, name, category_name, qty, unit_price, unit_cost, tax_rate, discount_amount, tax_amount, line_total)
    values (v_sale_id, v_item.line_no, v_product.id, v_product.sku, v_product.name, v_product.category_name, v_qty,
      v_product.selling_price, v_product.cost_price, v_product.tax_rate, v_discount, v_tax, v_amount - v_discount + v_tax);

    perform public.post_stock_movement(v_product.id, 'Sale', -v_qty, 'POS sale', 'sale', v_sale_id::text, v_bill, p_cashier, v_product.cost_price);
  end loop;

  v_grand := v_subtotal - v_discount_total + v_tax_total;

  -- The cashier told the customer a total. Never charge a different one.
  if (p_sale ->> 'expectedTotal') is null or (p_sale ->> 'expectedTotal')::numeric <> v_grand then
    raise exception 'CONFLICT:Prices or offers have changed. Check the new total and try again.' using errcode = 'P0001';
  end if;

  -- Points: 1 point = LKR 1, capped at the profit on this bill so it is never sold below cost.
  if v_redeem < 0 then raise exception 'Enter a valid number of points.' using errcode = 'P0001'; end if;
  if v_redeem > 0 then
    if v_customer_id is null then
      raise exception 'Choose the customer before using loyalty points.' using errcode = 'P0001';
    end if;
    v_cap := least(v_customer.loyalty_points, greatest(floor(v_subtotal - v_discount_total - v_cost_total), 0), floor(v_grand))::integer;
    if v_redeem > v_cap then
      raise exception 'CONFLICT:Only % points can be used on this bill.', v_cap using errcode = 'P0001';
    end if;
  end if;
  v_due := v_grand - v_redeem;

  select * into v_method from public.payment_methods where code = p_sale #>> '{payment,method}' and active and selectable;
  if not found then raise exception 'Choose a valid payment method.' using errcode = 'P0001'; end if;
  if v_method.is_cash then
    if v_due > 0 and (v_tendered is null or v_tendered < v_due) then
      raise exception 'Cash received is less than the total.' using errcode = 'P0001';
    end if;
    if v_due = 0 then v_tendered := null; end if;
    v_change := coalesce(v_tendered - v_due, 0);
  else
    v_tendered := null;
    if v_method.requires_reference and v_reference = '' and v_due > 0 then
      raise exception 'Enter the payment reference.' using errcode = 'P0001';
    end if;
  end if;

  if v_method.code = 'Credit' and v_due > 0 then
    if v_customer_id is null then
      raise exception 'Choose the customer to sell on credit.' using errcode = 'P0001';
    end if;
    if v_customer.credit_balance + v_due > v_customer.credit_limit then
      raise exception 'CONFLICT:This goes over the customer''s credit limit. Available credit: %.',
        greatest(v_customer.credit_limit - v_customer.credit_balance, 0) using errcode = 'P0001';
    end if;
  end if;

  if v_redeem > 0 then
    insert into public.payments (sale_id, method_code, amount, amount_tendered, change_given, reference)
    values (v_sale_id, 'Loyalty points', v_redeem, null, 0, v_redeem || ' points');
  end if;
  if v_due > 0 then
    insert into public.payments (sale_id, method_code, amount, amount_tendered, change_given, reference)
    values (v_sale_id, v_method.code, v_due, v_tendered, v_change, v_reference);
  end if;

  if v_method.code = 'Credit' and v_due > 0 then
    perform public.post_customer_credit(v_customer_id, 'Sale', v_due, v_sale_id, 'Credit', v_bill, v_shift, p_cashier);
  end if;

  if v_customer_id is not null then
    -- Points are earned on what was paid, not on what was paid with points.
    v_points := floor(v_due / 100)::integer * v_multiplier;
    update public.customers
    set loyalty_points = loyalty_points - v_redeem + v_points, purchase_count = purchase_count + 1
    where id = v_customer_id;
  end if;

  update public.sales
  set subtotal = v_subtotal, discount_total = v_discount_total, tax_total = v_tax_total, grand_total = v_grand,
      points_earned = v_points, points_redeemed = v_redeem
  where id = v_sale_id;

  return jsonb_build_object('id', v_sale_id, 'billNo', v_bill, 'replayed', false);
end;
$$;

notify pgrst, 'reload schema';
