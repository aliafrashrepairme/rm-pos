-- POS: one all-or-nothing sale, held orders and quick customer creation.

create function public.create_sale(p_sale jsonb, p_cashier uuid) returns jsonb
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
  v_grand numeric;
  v_method public.payment_methods%rowtype;
  v_tendered numeric := (p_sale #>> '{payment,amountTendered}')::numeric;
  v_reference text := coalesce(trim(p_sale #>> '{payment,reference}'), '');
  v_change numeric := 0;
  v_points integer := 0;
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
    select * into v_coupon from public.coupons where code = v_coupon_code and active;
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

  select * into v_method from public.payment_methods where code = p_sale #>> '{payment,method}' and active;
  if not found then raise exception 'Choose a valid payment method.' using errcode = 'P0001'; end if;
  if v_method.is_cash then
    if v_tendered is null or v_tendered < v_grand then
      raise exception 'Cash received is less than the total.' using errcode = 'P0001';
    end if;
    v_change := v_tendered - v_grand;
  else
    v_tendered := null;
    if v_method.requires_reference and v_reference = '' then
      raise exception 'Enter the payment reference.' using errcode = 'P0001';
    end if;
  end if;

  if v_grand > 0 then
    insert into public.payments (sale_id, method_code, amount, amount_tendered, change_given, reference)
    values (v_sale_id, v_method.code, v_grand, v_tendered, v_change, v_reference);
  end if;

  if v_customer_id is not null then
    v_points := floor(v_grand / 100)::integer * v_multiplier;
    update public.customers
    set loyalty_points = loyalty_points + v_points, purchase_count = purchase_count + 1
    where id = v_customer_id;
  end if;

  update public.sales
  set subtotal = v_subtotal, discount_total = v_discount_total, tax_total = v_tax_total, grand_total = v_grand, points_earned = v_points
  where id = v_sale_id;

  return jsonb_build_object('id', v_sale_id, 'billNo', v_bill, 'replayed', false);
end;
$$;

create function public.hold_order(p_order jsonb, p_created_by uuid) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_customer_id uuid := nullif(p_order ->> 'customerId', '')::uuid;
  v_customer_name text := 'Walk-in Customer';
begin
  if jsonb_typeof(p_order -> 'items') is distinct from 'array' or jsonb_array_length(p_order -> 'items') = 0 then
    raise exception 'Add at least one product before holding.' using errcode = 'P0001';
  end if;
  if v_customer_id is not null then
    select name into v_customer_name from public.customers where id = v_customer_id;
    if not found then raise exception 'NOT_FOUND:Customer not found.' using errcode = 'P0001'; end if;
  end if;
  insert into public.held_orders (hold_no, customer_id, customer_name, coupon_code, created_by)
  values (public.next_document_number('H-'), v_customer_id, v_customer_name, nullif(upper(trim(p_order ->> 'couponCode')), ''), p_created_by)
  returning id into v_id;
  insert into public.held_order_items (held_order_id, product_id, qty)
  select v_id, (value ->> 'productId')::uuid, (value ->> 'qty')::numeric from jsonb_array_elements(p_order -> 'items');
  return v_id;
end;
$$;

create function public.create_customer(p_name text, p_phone text) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  insert into public.customers (code, name, phone)
  values (public.next_document_number('CUS-'), trim(p_name), coalesce(trim(p_phone), ''))
  returning id into v_id;
  return v_id;
end;
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array['create_sale(jsonb, uuid)', 'hold_order(jsonb, uuid)', 'create_customer(text, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
