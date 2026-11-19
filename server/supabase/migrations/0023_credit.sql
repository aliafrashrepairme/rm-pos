-- Credit management:
--   * Customers spend loyalty points on a bill (1 point = LKR 1), never more than the bill's profit,
--     so points can't make the shop sell below cost. Spent points are a payment line, so VAT and revenue are unchanged.
--   * Trusted customers buy on credit up to a limit set by a Manager, and pay it back later.
--   * Supplier credit: what the shop owes on purchases, with due dates from the supplier's terms.

-- ===== Payment methods =====
-- "Loyalty points" is only ever added by create_sale, so it is hidden from the POS method buttons.
alter table public.payment_methods add column selectable boolean not null default true;
insert into public.payment_methods (code, is_cash, requires_reference, sort_order, selectable) values
  ('Credit', false, false, 4, true),
  ('Loyalty points', false, false, 5, false)
on conflict (code) do nothing;

insert into public.number_sequences (prefix, pad_to) values ('CR-', 6) on conflict (prefix) do nothing;

insert into public.permissions (code, description) values
  ('credit.view', 'View customer credit, supplier credit and loyalty points'),
  ('credit.collect', 'Record customer credit repayments'),
  ('credit.manage', 'Set customer credit limits')
on conflict (code) do nothing;
insert into public.role_permissions (role_code, permission_code) values
  ('Manager', 'credit.view'), ('Manager', 'credit.collect'), ('Manager', 'credit.manage'),
  ('Cashier', 'credit.view'), ('Cashier', 'credit.collect'),
  ('Owner', 'credit.view')
on conflict do nothing;

-- ===== Customer credit =====
alter table public.customers
  add column credit_limit numeric(12, 2) not null default 0 check (credit_limit >= 0),
  add column credit_balance numeric(12, 2) not null default 0 check (credit_balance >= 0);

alter table public.sales add column points_redeemed integer not null default 0 check (points_redeemed >= 0);
alter table public.refunds add column points_returned integer not null default 0 check (points_returned >= 0);

-- Every change to what a customer owes. Positive amounts add to the balance, negative ones reduce it.
create table public.customer_credit_entries (
  id uuid primary key default gen_random_uuid(),
  entry_no text not null unique,
  customer_id uuid not null references public.customers(id),
  kind text not null check (kind in ('Sale', 'Payment', 'Refund', 'Void')),
  amount numeric(12, 2) not null check (amount <> 0),
  balance_after numeric(12, 2) not null check (balance_after >= 0),
  sale_id uuid references public.sales(id),
  method_code text references public.payment_methods(code),
  reference text not null default '',
  shift_id uuid references public.shifts(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index customer_credit_entries_customer_idx on public.customer_credit_entries(customer_id, created_at desc);
create index customer_credit_entries_shift_idx on public.customer_credit_entries(shift_id);
create trigger customer_credit_entries_append_only before update or delete on public.customer_credit_entries
  for each row execute function public.reject_change();

alter table public.customer_credit_entries enable row level security;
revoke all on public.customer_credit_entries from public, anon, authenticated;
grant select, insert on public.customer_credit_entries to service_role;

create function public.post_customer_credit(p_customer uuid, p_kind text, p_amount numeric, p_sale uuid, p_method text,
  p_reference text, p_shift uuid, p_user uuid) returns numeric
language plpgsql set search_path = public, pg_temp as $$
declare
  v_balance numeric;
begin
  update public.customers set credit_balance = credit_balance + p_amount where id = p_customer
  returning credit_balance into v_balance;
  insert into public.customer_credit_entries (entry_no, customer_id, kind, amount, balance_after, sale_id, method_code, reference, shift_id, created_by)
  values (public.next_document_number('CR-'), p_customer, p_kind, p_amount, v_balance, p_sale, p_method, coalesce(p_reference, ''), p_shift, p_user);
  return v_balance;
end;
$$;

-- The most points a bill can take: never more than its profit (after offers, before VAT), the bill total,
-- or the customer's points. Used by POS to show the limit; create_sale works it out again itself.
create function public.points_cap(p_items jsonb, p_rate numeric) returns integer
language sql stable set search_path = public, pg_temp as $$
  select greatest(floor(coalesce(sum(
    round(p.selling_price * (i.value ->> 'qty')::numeric, 2)
    - round(round(p.selling_price * (i.value ->> 'qty')::numeric, 2) * coalesce(p_rate, 0), 2)
    - round(p.cost_price * (i.value ->> 'qty')::numeric, 2)
  ), 0)), 0)::integer
  from jsonb_array_elements(p_items) i
  join public.products p on p.id = (i.value ->> 'productId')::uuid;
$$;

-- ===== Sale: points and credit =====
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

-- ===== Void: give back spent points and take the bill off the customer's credit =====
create or replace function public.void_sale(p_sale_id uuid, p_reason text, p_user uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_sale public.sales%rowtype;
  v_item record;
  v_credit numeric;
  v_balance numeric;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Enter a reason.' using errcode = 'P0001';
  end if;
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then raise exception 'NOT_FOUND:Bill not found.' using errcode = 'P0001'; end if;
  if v_sale.status <> 'Paid' then
    raise exception 'CONFLICT:Only an unrefunded paid bill can be voided.' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_credit from public.payments where sale_id = p_sale_id and method_code = 'Credit';
  if v_credit > 0 then
    select credit_balance into v_balance from public.customers where id = v_sale.customer_id for update;
    if v_balance < v_credit then
      raise exception 'CONFLICT:The customer has already paid back part of this credit bill. Use a refund instead.' using errcode = 'P0001';
    end if;
  end if;

  for v_item in
    select product_id, qty, unit_cost from public.sale_items where sale_id = p_sale_id order by product_id
  loop
    perform public.post_stock_movement(v_item.product_id, 'Void', v_item.qty, trim(p_reason), 'sale', p_sale_id::text, v_sale.bill_no, p_user, v_item.unit_cost);
  end loop;

  if v_sale.customer_id is not null then
    update public.customers
    set loyalty_points = greatest(loyalty_points - v_sale.points_earned, 0) + v_sale.points_redeemed,
        purchase_count = greatest(purchase_count - 1, 0)
    where id = v_sale.customer_id;
  end if;
  if v_credit > 0 then
    perform public.post_customer_credit(v_sale.customer_id, 'Void', -v_credit, p_sale_id, 'Credit', v_sale.bill_no, null, p_user);
  end if;

  update public.sales
  set status = 'Voided', voided_at = now(), voided_by = p_user, void_reason = trim(p_reason), points_reversed = v_sale.points_earned
  where id = p_sale_id;
end;
$$;

-- ===== Refund: spent points come back first, the rest is paid out (or taken off credit) =====
create or replace function public.refund_sale(p_refund jsonb, p_user uuid) returns jsonb
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
  v_full boolean;
  v_returned_before integer;
  v_points_back integer;
  v_money numeric;
  v_balance numeric;
begin
  if v_request is null then raise exception 'A request ID is required.' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_request::text, 0));
  select id, refund_no into v_existing from public.refunds where client_request_id = v_request;
  if found then
    return jsonb_build_object('id', v_existing.id, 'refundNo', v_existing.refund_no, 'replayed', true);
  end if;

  if coalesce(v_reason, '') = '' then raise exception 'Enter a reason.' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.payment_methods where code = v_method and active and selectable) then
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
  if v_method = 'Credit' and v_sale.customer_id is null then
    raise exception 'Only a customer''s bill can be refunded to credit.' using errcode = 'P0001';
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

  -- Is this the refund that empties the bill? Then everything left comes back, so nothing is lost to rounding.
  select not exists (
    select 1 from public.sale_items si
    where si.sale_id = v_sale_id
      and si.refunded_qty + coalesce((select sum((e.value ->> 'qty')::numeric) from jsonb_array_elements(v_lines) e
                                      where (e.value ->> 'saleItemId')::uuid = si.id), 0) < si.qty
  ) into v_full;
  select coalesce(sum(total), 0) + v_total, coalesce(sum(points_returned), 0) into v_all_refunded, v_returned_before
  from public.refunds where sale_id = v_sale_id;

  v_points_back := case when v_full then v_sale.points_redeemed
    else least(floor(v_sale.points_redeemed * v_all_refunded / nullif(v_sale.grand_total, 0))::integer, v_sale.points_redeemed) end - v_returned_before;
  v_points_back := least(greatest(coalesce(v_points_back, 0), 0), floor(v_total)::integer);
  v_money := v_total - v_points_back;

  if v_method = 'Credit' and v_money > 0 then
    select credit_balance into v_balance from public.customers where id = v_sale.customer_id for update;
    if v_balance < v_money then
      raise exception 'CONFLICT:The customer only owes %. Refund the rest in cash or by card.', v_balance using errcode = 'P0001';
    end if;
  end if;

  v_refund_no := public.next_document_number('RF-');
  insert into public.refunds (id, refund_no, client_request_id, sale_id, method_code, reason, total, points_returned, created_by)
  values (v_refund_id, v_refund_no, v_request, v_sale_id, v_method, v_reason, v_total, v_points_back, p_user);

  -- Fixed product order, so simultaneous stock changes can't deadlock.
  for v_entry in select value from jsonb_array_elements(v_lines) order by value ->> 'productId' loop
    insert into public.refund_items (refund_id, sale_item_id, qty, amount, restock)
    values (v_refund_id, (v_entry ->> 'saleItemId')::uuid, (v_entry ->> 'qty')::numeric, (v_entry ->> 'amount')::numeric, (v_entry ->> 'restock')::boolean);
    update public.sale_items set refunded_qty = refunded_qty + (v_entry ->> 'qty')::numeric where id = (v_entry ->> 'saleItemId')::uuid;
    if (v_entry ->> 'restock')::boolean then
      perform public.post_stock_movement((v_entry ->> 'productId')::uuid, 'Refund', (v_entry ->> 'qty')::numeric, v_reason, 'refund', v_refund_id::text, v_refund_no, p_user, (v_entry ->> 'unitCost')::numeric);
    end if;
  end loop;

  v_status := case when v_full then 'Refunded' else 'Partially Refunded' end;
  v_points := case when v_status = 'Refunded' then v_sale.points_earned
    else least(round(v_sale.points_earned * v_all_refunded / nullif(v_sale.grand_total, 0))::integer, v_sale.points_earned) end - v_sale.points_reversed;
  v_points := greatest(coalesce(v_points, 0), 0);

  if v_sale.customer_id is not null and (v_points > 0 or v_points_back > 0) then
    update public.customers set loyalty_points = greatest(loyalty_points - v_points, 0) + v_points_back where id = v_sale.customer_id;
  end if;
  if v_method = 'Credit' and v_money > 0 then
    perform public.post_customer_credit(v_sale.customer_id, 'Refund', -v_money, v_sale_id, 'Credit', v_refund_no, null, p_user);
  end if;
  update public.sales set status = v_status, points_reversed = points_reversed + v_points where id = v_sale_id;

  return jsonb_build_object('id', v_refund_id, 'refundNo', v_refund_no, 'total', v_total, 'pointsReturned', v_points_back,
    'paidOut', v_money, 'status', v_status, 'replayed', false);
end;
$$;

-- ===== Repayments and limits =====
create function public.record_credit_payment(p_payment jsonb, p_user uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_customer public.customers%rowtype;
  v_amount numeric := (p_payment ->> 'amount')::numeric;
  v_method public.payment_methods%rowtype;
  v_reference text := coalesce(trim(p_payment ->> 'reference'), '');
  v_shift uuid;
  v_balance numeric;
begin
  select * into v_customer from public.customers where id = (p_payment ->> 'customerId')::uuid for update;
  if not found then raise exception 'NOT_FOUND:Customer not found.' using errcode = 'P0001'; end if;
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
    raise exception 'Enter a valid amount.' using errcode = 'P0001';
  end if;
  if v_amount > v_customer.credit_balance then
    raise exception 'CONFLICT:The customer only owes %.', v_customer.credit_balance using errcode = 'P0001';
  end if;
  select * into v_method from public.payment_methods
  where code = p_payment ->> 'method' and active and selectable and code <> 'Credit';
  if not found then raise exception 'Choose a valid payment method.' using errcode = 'P0001'; end if;
  if v_method.requires_reference and v_reference = '' then
    raise exception 'Enter the payment reference.' using errcode = 'P0001';
  end if;
  -- Linked to the collector's open shift for its report. Only cash counts in the drawer's expected cash.
  select id into v_shift from public.shifts where cashier_id = p_user and status = 'Open';
  v_balance := public.post_customer_credit(v_customer.id, 'Payment', -v_amount, null, v_method.code, v_reference, v_shift, p_user);
  return jsonb_build_object('customer', v_customer.name, 'amount', v_amount, 'balance', v_balance, 'inShift', v_shift is not null);
end;
$$;

create function public.set_credit_limit(p_customer uuid, p_limit numeric) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_old numeric;
  v_name text;
begin
  if p_limit is null or p_limit < 0 or p_limit <> round(p_limit, 2) then
    raise exception 'Enter a valid credit limit.' using errcode = 'P0001';
  end if;
  select credit_limit, name into v_old, v_name from public.customers where id = p_customer for update;
  if not found then raise exception 'NOT_FOUND:Customer not found.' using errcode = 'P0001'; end if;
  update public.customers set credit_limit = p_limit where id = p_customer;
  return jsonb_build_object('customer', v_name, 'from', v_old, 'to', p_limit);
end;
$$;

-- ===== Supplier credit: what is owed on each purchase, and when it falls due =====
-- Due date = goods received (or ordered) + the days in the supplier's terms, e.g. "Credit 30 days". Cash terms are due at once.
create function public.supplier_payables() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with owed as (
    select po.id, po.po_no, po.status, po.total, po.paid_total, s.id as supplier_id, s.name as supplier, s.payment_terms,
      coalesce((select min(g.received_at) from public.goods_receipts g where g.purchase_id = po.id), po.ordered_at, po.created_at)::date as start_date,
      coalesce(substring(s.payment_terms from '(\d+)')::integer, 0) as terms_days
    from public.purchases po
    join public.suppliers s on s.id = po.supplier_id
    where po.status not in ('Draft', 'Cancelled') and po.total > po.paid_total
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'poNo', po_no, 'status', status, 'supplierId', supplier_id, 'supplier', supplier, 'terms', payment_terms,
    'total', total, 'paid', paid_total, 'balance', total - paid_total,
    'dueDate', start_date + terms_days, 'daysOverdue', greatest(current_date - (start_date + terms_days), 0)
  ) order by start_date + terms_days, po_no), '[]'::jsonb)
  from owed;
$$;

-- ===== Shift cash: credit repayments in cash go in; refunds pay out only the part not given back as points =====
create or replace function public.shift_figures(p_shift uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with paid as (
    select p.method_code, p.amount, m.is_cash
    from public.payments p
    join public.sales s on s.id = p.sale_id
    join public.payment_methods m on m.code = p.method_code
    where s.shift_id = p_shift and s.status <> 'Voided'
  ), returned as (
    select r.total, r.total - r.points_returned as paid_out, m.is_cash
    from public.refunds r
    join public.payment_methods m on m.code = r.method_code
    where r.shift_id = p_shift
  ), spent as (
    select amount, paid_from_cash from public.expenses where shift_id = p_shift
  ), collected as (
    select -e.amount as amount, m.is_cash
    from public.customer_credit_entries e
    join public.payment_methods m on m.code = e.method_code
    where e.shift_id = p_shift and e.kind = 'Payment'
  ), figures as (
    select
      coalesce((select sum(amount) from paid where is_cash), 0) as cash_sales,
      coalesce((select sum(paid_out) from returned where is_cash), 0) as cash_refunds,
      coalesce((select sum(amount) from spent where paid_from_cash), 0) as cash_expenses,
      coalesce((select sum(amount) from collected where is_cash), 0) as cash_collected
  )
  select jsonb_build_object(
    'bills', (select count(*) from public.sales where shift_id = p_shift and status <> 'Voided'),
    'sales', coalesce((select sum(amount) from paid), 0),
    'byMethod', (select coalesce(jsonb_object_agg(method_code, total), '{}'::jsonb) from (select method_code, sum(amount) as total from paid group by method_code) m),
    'refunds', coalesce((select sum(total) from returned), 0),
    'expenses', coalesce((select sum(amount) from spent), 0),
    'creditCollected', coalesce((select sum(amount) from collected), 0),
    'cashSales', cash_sales,
    'cashRefunds', cash_refunds,
    'cashExpenses', cash_expenses,
    'cashCollected', cash_collected,
    'expectedCash', (select opening_cash from public.shifts where id = p_shift) + cash_sales + cash_collected - cash_refunds - cash_expenses
  )
  from figures;
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'post_customer_credit(uuid, text, numeric, uuid, text, text, uuid, uuid)',
    'points_cap(jsonb, numeric)',
    'create_sale(jsonb, uuid)',
    'void_sale(uuid, text, uuid)',
    'refund_sale(jsonb, uuid)',
    'record_credit_payment(jsonb, uuid)',
    'set_credit_limit(uuid, numeric)',
    'supplier_payables()',
    'shift_figures(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
