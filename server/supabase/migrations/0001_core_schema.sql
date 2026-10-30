-- RM POS core schema. See docs/architecture.md for the reasoning.
-- Replaces the starter tables in server/supabase/schema.sql.
-- Refuses to run if the starter tables hold real users or transactions.

do $$
declare
  v_table text;
  v_count bigint;
begin
  foreach v_table in array array['profiles', 'sales', 'purchases', 'suppliers', 'stock_movements'] loop
    if to_regclass('public.' || v_table) is not null then
      execute format('select count(*) from public.%I', v_table) into v_count;
      if v_count > 0 then
        raise exception 'Starter table % has % row(s). Migrate this data by hand before running 0001.', v_table, v_count;
      end if;
    end if;
  end loop;
end;
$$;

drop function if exists public.create_product(text, text, text, text, numeric, numeric, integer, integer, uuid);
drop function if exists public.adjust_stock(text, text, integer, text, text, uuid);
drop function if exists public.create_sale(jsonb, text, text, uuid);
drop function if exists public.receive_purchase(uuid, jsonb, uuid);
drop table if exists public.purchase_items, public.purchases, public.stock_movements,
  public.sale_items, public.sales, public.suppliers, public.products, public.profiles;

-- ===== Shared helpers =====

create function public.set_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function public.reject_change() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'APPEND_ONLY:% records cannot be changed or deleted.', tg_table_name using errcode = 'P0001';
end;
$$;

-- Gap-free document numbers: the row lock is released, and the number kept, only on commit.
create table public.number_sequences (
  prefix text primary key,
  next_value bigint not null default 1 check (next_value > 0),
  pad_to integer not null default 6 check (pad_to between 1 and 12)
);

create function public.next_document_number(p_prefix text) returns text
language plpgsql set search_path = public, pg_temp as $$
declare
  v_value bigint;
  v_pad integer;
begin
  update public.number_sequences set next_value = next_value + 1
  where prefix = p_prefix
  returning next_value - 1, pad_to into v_value, v_pad;
  if not found then
    raise exception 'NOT_FOUND:Unknown document prefix %.', p_prefix using errcode = 'P0001';
  end if;
  return p_prefix || lpad(v_value::text, v_pad, '0');
end;
$$;

-- ===== Access control =====

create table public.roles (
  code text primary key,
  description text not null default ''
);

create table public.permissions (
  code text primary key,
  description text not null default ''
);

create table public.role_permissions (
  role_code text not null references public.roles(code),
  permission_code text not null references public.permissions(code),
  primary key (role_code, permission_code)
);

-- Staff with history are disabled rather than deleted, so auth.users deletes are restricted.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  username text not null check (username = lower(username) and username ~ '^[a-z0-9._-]{3,40}$'),
  full_name text not null check (length(trim(full_name)) > 0),
  email text not null,
  role_code text not null references public.roles(code),
  active boolean not null default true,
  must_change_password boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_username_key on public.profiles(username);
create unique index profiles_email_key on public.profiles(lower(email));
create index profiles_role_idx on public.profiles(role_code);

create table public.user_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  language text not null default 'en' check (language in ('en', 'ta', 'si')),
  theme text not null default 'dark' check (theme in ('light', 'dark')),
  updated_at timestamptz not null default now()
);

-- ===== Lists and settings =====

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index categories_name_key on public.categories(lower(name));

create table public.units (
  code text primary key,
  allow_decimal_qty boolean not null default false,
  active boolean not null default true
);

create table public.tax_rates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  rate numeric(5, 2) not null check (rate between 0 and 100),
  is_default boolean not null default false,
  active boolean not null default true
);
create unique index tax_rates_one_default on public.tax_rates(is_default) where is_default;

create table public.payment_methods (
  code text primary key,
  is_cash boolean not null default false,
  requires_reference boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 0
);

create table public.coupons (
  code text primary key check (code = upper(code)),
  description text not null default '',
  rate numeric(5, 4) not null check (rate > 0 and rate <= 1),
  first_purchase_only boolean not null default false,
  active boolean not null default true
);

create table public.counters (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active boolean not null default true
);

-- Exactly one row. Rarely queried groups stay in jsonb; business rules get real columns.
create table public.store_settings (
  id boolean primary key default true check (id),
  store_name text not null default 'RM Hardware Store',
  address text not null default '',
  phone text not null default '',
  vat_registration text not null default '',
  currency_code text not null default 'LKR',
  receipt jsonb not null default '{}',
  adjustment_approval_limit numeric(12, 2) not null default 10000 check (adjustment_approval_limit >= 0),
  blind_counts_default boolean not null default true,
  update_cost_from_invoices boolean not null default true,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

-- ===== Parties =====

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (length(trim(name)) > 0),
  contact_person text not null default '',
  phone text not null default '',
  email text not null default '',
  address text not null default '',
  city text not null default '',
  payment_terms text not null default 'Cash',
  lead_time_days integer not null default 5 check (lead_time_days >= 0),
  rating numeric(2, 1) check (rating between 0 and 5),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index suppliers_name_idx on public.suppliers(lower(name));

-- Walk-in sales have sales.customer_id = null, so no placeholder customer exists.
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (length(trim(name)) > 0),
  phone text not null default '',
  email text not null default '',
  address text not null default '',
  loyalty_points integer not null default 0 check (loyalty_points >= 0),
  purchase_count integer not null default 0 check (purchase_count >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_name_idx on public.customers(lower(name));
create index customers_phone_idx on public.customers(phone);

-- ===== Products and the inventory ledger =====

create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  barcode text unique check (barcode ~ '^[0-9A-Za-z-]{4,32}$'),
  name text not null check (length(trim(name)) > 0),
  description text not null default '',
  category_id uuid not null references public.categories(id),
  unit_code text not null references public.units(code),
  cost_price numeric(12, 2) not null default 0 check (cost_price >= 0),
  selling_price numeric(12, 2) not null check (selling_price >= 0),
  tax_rate_id uuid not null references public.tax_rates(id),
  stock_qty numeric(12, 3) not null default 0 check (stock_qty >= 0),
  min_stock numeric(12, 3) not null default 0 check (min_stock >= 0),
  location text not null default '',
  preferred_supplier_id uuid references public.suppliers(id),
  image_path text,
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_category_idx on public.products(category_id);
create index products_supplier_idx on public.products(preferred_supplier_id);
create index products_name_idx on public.products(lower(name));
create index products_low_stock_idx on public.products(stock_qty, min_stock) where active;

create table public.inventory_ledger (
  id bigint generated always as identity primary key,
  product_id uuid not null references public.products(id),
  movement_type text not null check (movement_type in
    ('Opening', 'Sale', 'Refund', 'Void', 'Purchase', 'Adjustment', 'Count', 'Import')),
  previous_qty numeric(12, 3) not null,
  change_qty numeric(12, 3) not null check (change_qty <> 0),
  new_qty numeric(12, 3) not null check (new_qty >= 0),
  unit_cost numeric(12, 2),
  reason text not null check (length(trim(reason)) > 0),
  reference_type text not null default '',
  reference_id text not null default '',
  reference_no text not null default '',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  check (new_qty = previous_qty + change_qty)
);
create index inventory_ledger_product_idx on public.inventory_ledger(product_id, created_at desc);
create index inventory_ledger_date_idx on public.inventory_ledger(created_at desc);
create index inventory_ledger_reference_idx on public.inventory_ledger(reference_type, reference_id);

create trigger inventory_ledger_append_only before update or delete on public.inventory_ledger
  for each row execute function public.reject_change();
create trigger inventory_ledger_no_truncate before truncate on public.inventory_ledger
  for each statement execute function public.reject_change();

-- Stock may only change through post_stock_movement, so stock and ledger can never disagree.
create function public.guard_product_stock() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' and new.stock_qty <> 0 then
    raise exception 'STOCK_GUARD:New products start at zero; post opening stock as a movement.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.stock_qty <> old.stock_qty
    and current_setting('rmpos.stock_write', true) is distinct from 'on' then
    raise exception 'STOCK_GUARD:Stock can only change through a ledger movement.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger products_guard_stock before insert or update of stock_qty on public.products
  for each row execute function public.guard_product_stock();

-- Callers changing several products must pass them in product_id order to avoid deadlocks.
create function public.post_stock_movement(
  p_product_id uuid,
  p_movement_type text,
  p_change_qty numeric,
  p_reason text,
  p_reference_type text,
  p_reference_id text,
  p_reference_no text,
  p_created_by uuid,
  p_unit_cost numeric default null
) returns bigint
language plpgsql set search_path = public, pg_temp as $$
declare
  v_product public.products%rowtype;
  v_allow_decimal boolean;
  v_new_qty numeric(12, 3);
  v_ledger_id bigint;
begin
  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'NOT_FOUND:Product not found.' using errcode = 'P0001';
  end if;

  select allow_decimal_qty into v_allow_decimal from public.units where code = v_product.unit_code;
  if not v_allow_decimal and p_change_qty <> trunc(p_change_qty) then
    raise exception 'INVALID_QTY:% is sold in whole units.', v_product.name using errcode = 'P0001';
  end if;

  v_new_qty := v_product.stock_qty + p_change_qty;
  if v_new_qty < 0 then
    raise exception 'INSUFFICIENT_STOCK:Only % of % in stock.', v_product.stock_qty, v_product.name using errcode = 'P0001';
  end if;

  perform set_config('rmpos.stock_write', 'on', true);
  update public.products set stock_qty = v_new_qty, updated_at = now() where id = p_product_id;
  perform set_config('rmpos.stock_write', 'off', true);

  insert into public.inventory_ledger (product_id, movement_type, previous_qty, change_qty, new_qty,
    unit_cost, reason, reference_type, reference_id, reference_no, created_by)
  values (p_product_id, p_movement_type, v_product.stock_qty, p_change_qty, v_new_qty,
    p_unit_cost, p_reason, coalesce(p_reference_type, ''), coalesce(p_reference_id, ''), coalesce(p_reference_no, ''), p_created_by)
  returning id into v_ledger_id;
  return v_ledger_id;
end;
$$;

-- ===== Shifts and expenses =====

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  shift_no text not null unique,
  counter_id uuid not null references public.counters(id),
  cashier_id uuid not null references public.profiles(id),
  status text not null default 'Open' check (status in ('Open', 'Closed')),
  opening_cash numeric(12, 2) not null check (opening_cash >= 0),
  expected_cash numeric(12, 2),
  counted_cash numeric(12, 2) check (counted_cash >= 0),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.profiles(id),
  check ((status = 'Closed') = (closed_at is not null))
);
create unique index shifts_one_open_per_counter on public.shifts(counter_id) where status = 'Open';
create unique index shifts_one_open_per_cashier on public.shifts(cashier_id) where status = 'Open';
create index shifts_opened_idx on public.shifts(opened_at desc);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  expense_no text not null unique,
  category text not null,
  description text not null check (length(trim(description)) > 0),
  amount numeric(12, 2) not null check (amount > 0),
  paid_from_cash boolean not null default true,
  shift_id uuid references public.shifts(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index expenses_date_idx on public.expenses(created_at desc);
create index expenses_shift_idx on public.expenses(shift_id);

-- ===== Sales =====
-- client_request_id is generated once per checkout attempt, so a retried request cannot sell twice.
-- Names, prices and tax are copied onto each line so old bills never change.

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  bill_no text not null unique,
  client_request_id uuid not null unique,
  status text not null default 'Paid' check (status in ('Paid', 'Partially Refunded', 'Refunded', 'Voided')),
  customer_id uuid references public.customers(id),
  customer_name text not null default 'Walk-in Customer',
  cashier_id uuid not null references public.profiles(id),
  shift_id uuid references public.shifts(id),
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  discount_total numeric(12, 2) not null default 0 check (discount_total >= 0),
  discount_label text not null default '',
  coupon_code text references public.coupons(code),
  tax_total numeric(12, 2) not null default 0 check (tax_total >= 0),
  grand_total numeric(12, 2) not null check (grand_total >= 0),
  points_earned integer not null default 0 check (points_earned >= 0),
  voided_at timestamptz,
  voided_by uuid references public.profiles(id),
  void_reason text,
  created_at timestamptz not null default now(),
  check (grand_total = subtotal - discount_total + tax_total),
  check ((status = 'Voided') = (voided_at is not null))
);
create index sales_date_idx on public.sales(created_at desc);
create index sales_status_date_idx on public.sales(status, created_at desc);
create index sales_customer_idx on public.sales(customer_id, created_at desc);
create index sales_cashier_idx on public.sales(cashier_id, created_at desc);
create index sales_shift_idx on public.sales(shift_id);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  line_no integer not null check (line_no > 0),
  product_id uuid not null references public.products(id),
  sku text not null,
  name text not null,
  category_name text not null,
  qty numeric(12, 3) not null check (qty > 0),
  refunded_qty numeric(12, 3) not null default 0 check (refunded_qty >= 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  unit_cost numeric(12, 2) not null check (unit_cost >= 0),
  tax_rate numeric(5, 2) not null check (tax_rate >= 0),
  discount_amount numeric(12, 2) not null default 0 check (discount_amount >= 0),
  tax_amount numeric(12, 2) not null default 0 check (tax_amount >= 0),
  line_total numeric(12, 2) not null check (line_total >= 0),
  unique (sale_id, line_no),
  check (refunded_qty <= qty)
);
create index sale_items_product_idx on public.sale_items(product_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  method_code text not null references public.payment_methods(code),
  amount numeric(12, 2) not null check (amount > 0),
  amount_tendered numeric(12, 2),
  change_given numeric(12, 2) not null default 0 check (change_given >= 0),
  reference text not null default '',
  created_at timestamptz not null default now(),
  check (amount_tendered is null or amount_tendered = amount + change_given)
);
create index payments_sale_idx on public.payments(sale_id);
create index payments_method_date_idx on public.payments(method_code, created_at desc);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  refund_no text not null unique,
  client_request_id uuid not null unique,
  sale_id uuid not null references public.sales(id) on delete restrict,
  method_code text not null references public.payment_methods(code),
  reason text not null check (length(trim(reason)) > 0),
  total numeric(12, 2) not null check (total > 0),
  shift_id uuid references public.shifts(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index refunds_sale_idx on public.refunds(sale_id);
create index refunds_date_idx on public.refunds(created_at desc);

create table public.refund_items (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.refunds(id) on delete restrict,
  sale_item_id uuid not null references public.sale_items(id),
  qty numeric(12, 3) not null check (qty > 0),
  amount numeric(12, 2) not null check (amount >= 0),
  restock boolean not null default true,
  unique (refund_id, sale_item_id)
);
create index refund_items_sale_item_idx on public.refund_items(sale_item_id);

-- Held orders reserve no stock and take fresh prices on resume; stock is checked at sale time.
create table public.held_orders (
  id uuid primary key default gen_random_uuid(),
  hold_no text not null unique,
  status text not null default 'Held' check (status in ('Held', 'Resumed', 'Cancelled')),
  customer_id uuid references public.customers(id),
  customer_name text not null default 'Walk-in Customer',
  coupon_code text references public.coupons(code),
  note text not null default '',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'Held') = (closed_at is null))
);
create index held_orders_open_idx on public.held_orders(created_at desc) where status = 'Held';

create table public.held_order_items (
  id uuid primary key default gen_random_uuid(),
  held_order_id uuid not null references public.held_orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  qty numeric(12, 3) not null check (qty > 0),
  unique (held_order_id, product_id)
);

-- ===== Purchasing =====
-- Stock moves only when a goods receipt is posted, never when a purchase is created.

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  po_no text not null unique,
  supplier_id uuid not null references public.suppliers(id),
  status text not null default 'Draft' check (status in ('Draft', 'Ordered', 'Partially Received', 'Received', 'Cancelled')),
  source text not null default 'Manual' check (source in ('Manual', 'Auto-reorder', 'AI Scan')),
  supplier_invoice_no text,
  ordered_at timestamptz,
  expected_at date,
  subtotal numeric(12, 2) not null default 0 check (subtotal >= 0),
  tax_total numeric(12, 2) not null default 0 check (tax_total >= 0),
  total numeric(12, 2) not null default 0 check (total >= 0),
  paid_total numeric(12, 2) not null default 0 check (paid_total >= 0),
  note text not null default '',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (paid_total <= total)
);
create unique index purchases_supplier_invoice_key on public.purchases(supplier_id, lower(supplier_invoice_no))
  where supplier_invoice_no is not null and status <> 'Cancelled';
create index purchases_supplier_idx on public.purchases(supplier_id, created_at desc);
create index purchases_status_idx on public.purchases(status, created_at desc);

create table public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  line_no integer not null check (line_no > 0),
  product_id uuid not null references public.products(id),
  qty_ordered numeric(12, 3) not null check (qty_ordered > 0),
  qty_received numeric(12, 3) not null default 0 check (qty_received >= 0),
  unit_cost numeric(12, 2) not null check (unit_cost >= 0),
  tax_rate numeric(5, 2) not null default 0 check (tax_rate >= 0),
  unique (purchase_id, line_no),
  check (qty_received <= qty_ordered)
);
create index purchase_items_product_idx on public.purchase_items(product_id);

create table public.goods_receipts (
  id uuid primary key default gen_random_uuid(),
  grn_no text not null unique,
  client_request_id uuid not null unique,
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  note text not null default '',
  received_by uuid not null references public.profiles(id),
  received_at timestamptz not null default now()
);
create index goods_receipts_purchase_idx on public.goods_receipts(purchase_id);

create table public.goods_receipt_items (
  id uuid primary key default gen_random_uuid(),
  goods_receipt_id uuid not null references public.goods_receipts(id) on delete restrict,
  purchase_item_id uuid not null references public.purchase_items(id) on delete restrict,
  qty numeric(12, 3) not null check (qty > 0),
  unique (goods_receipt_id, purchase_item_id)
);
create index goods_receipt_items_purchase_item_idx on public.goods_receipt_items(purchase_item_id);

create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  payment_no text not null unique,
  supplier_id uuid not null references public.suppliers(id),
  purchase_id uuid references public.purchases(id),
  amount numeric(12, 2) not null check (amount > 0),
  method text not null check (method in ('Cash', 'Bank transfer', 'Cheque')),
  reference text not null default '',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index supplier_payments_supplier_idx on public.supplier_payments(supplier_id, created_at desc);
create index supplier_payments_purchase_idx on public.supplier_payments(purchase_id);

-- ===== Stock counts and adjustments =====

create table public.stock_counts (
  id uuid primary key default gen_random_uuid(),
  count_no text not null unique,
  name text not null check (length(trim(name)) > 0),
  scope text not null,
  blind boolean not null default true,
  status text not null default 'In Progress' check (status in ('In Progress', 'Submitted', 'Approved', 'Rejected')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  decided_by uuid references public.profiles(id),
  decided_at timestamptz
);
create index stock_counts_status_idx on public.stock_counts(status, created_at desc);

create table public.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  stock_count_id uuid not null references public.stock_counts(id) on delete cascade,
  product_id uuid not null references public.products(id),
  system_qty numeric(12, 3) not null,
  counted_qty numeric(12, 3) check (counted_qty >= 0),
  unique (stock_count_id, product_id)
);
create index stock_count_lines_product_idx on public.stock_count_lines(product_id);

create table public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  adjustment_no text not null unique,
  reason text not null check (reason in
    ('Damaged', 'Expired', 'Theft / Loss', 'Found stock', 'Supplier return', 'Internal use', 'Data correction')),
  note text not null default '',
  status text not null default 'Pending' check (status in ('Pending', 'Approved', 'Rejected')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz
);
create index stock_adjustments_status_idx on public.stock_adjustments(status, created_at desc);

create table public.stock_adjustment_lines (
  id uuid primary key default gen_random_uuid(),
  stock_adjustment_id uuid not null references public.stock_adjustments(id) on delete cascade,
  product_id uuid not null references public.products(id),
  change_qty numeric(12, 3) not null check (change_qty <> 0),
  unique (stock_adjustment_id, product_id)
);
create index stock_adjustment_lines_product_idx on public.stock_adjustment_lines(product_id);

-- ===== AI invoice scanning =====

create table public.invoice_scans (
  id uuid primary key default gen_random_uuid(),
  file_path text not null,
  file_name text not null,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  status text not null default 'Uploaded' check (status in ('Uploaded', 'Processing', 'Extracted', 'Failed', 'Approved', 'Rejected')),
  provider text,
  error_message text,
  supplier_text text,
  supplier_id uuid references public.suppliers(id),
  invoice_no text,
  invoice_date date,
  overall_confidence numeric(5, 2) check (overall_confidence between 0 and 100),
  raw_result jsonb,
  purchase_id uuid references public.purchases(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index invoice_scans_status_idx on public.invoice_scans(status, created_at desc);

create table public.invoice_scan_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_scan_id uuid not null references public.invoice_scans(id) on delete cascade,
  line_no integer not null check (line_no > 0),
  raw_text text not null,
  qty numeric(12, 3) check (qty > 0),
  unit_cost numeric(12, 2) check (unit_cost >= 0),
  confidence numeric(5, 2) check (confidence between 0 and 100),
  matched_product_id uuid references public.products(id),
  confirmed boolean not null default false,
  unique (invoice_scan_id, line_no)
);

-- ===== Audit log =====
-- user_name is copied so the record stays readable if the account changes.

create table public.audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id),
  user_name text not null,
  action text not null,
  description text not null default '',
  entity_type text not null default '',
  entity_id text not null default '',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_logs_date_idx on public.audit_logs(created_at desc);
create index audit_logs_user_idx on public.audit_logs(user_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs(entity_type, entity_id);

create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function public.reject_change();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function public.reject_change();

-- ===== updated_at triggers =====

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger user_preferences_updated_at before update on public.user_preferences for each row execute function public.set_updated_at();
create trigger store_settings_updated_at before update on public.store_settings for each row execute function public.set_updated_at();
create trigger suppliers_updated_at before update on public.suppliers for each row execute function public.set_updated_at();
create trigger customers_updated_at before update on public.customers for each row execute function public.set_updated_at();
create trigger products_updated_at before update on public.products for each row execute function public.set_updated_at();
create trigger purchases_updated_at before update on public.purchases for each row execute function public.set_updated_at();
create trigger invoice_scans_updated_at before update on public.invoice_scans for each row execute function public.set_updated_at();

-- ===== Reference data =====

insert into public.roles (code, description) values
  ('Owner', 'View only: daily transactions, monthly transactions and reports'),
  ('Manager', 'Runs the store: stock approvals, purchasing, reports, settings and staff'),
  ('Cashier', 'Billing, payments, receipts, customers and barcode scanning'),
  ('Inventory Staff', 'Products, stock counts, purchases, suppliers and inventory reports');

insert into public.permissions (code, description) values
  ('dashboard.view', 'Open the store dashboard'),
  ('transactions.view', 'View daily and monthly transactions'),
  ('reports.sales', 'View sales and payment reports'),
  ('reports.inventory', 'View inventory reports'),
  ('reports.export', 'Print and export reports'),
  ('pos.sell', 'Create sales and read the selling catalogue'),
  ('held.manage', 'Hold, resume and cancel orders'),
  ('bills.view', 'Open the bills register'),
  ('bills.print', 'Print or download customer bills'),
  ('refunds.process', 'Refund and void bills'),
  ('shifts.own', 'Open and close your own shift, and record its expenses'),
  ('shifts.manage', 'View all shifts and manage expenses'),
  ('customers.view', 'View customers and their history'),
  ('customers.manage', 'Add and edit customers'),
  ('barcode.scan', 'Use the barcode scanner'),
  ('barcode.labels', 'Generate and print barcode labels'),
  ('products.view', 'View products, including cost prices'),
  ('products.manage', 'Add, edit and deactivate products'),
  ('inventory.view', 'View stock and the inventory ledger'),
  ('counts.manage', 'Create and submit stock counts'),
  ('counts.approve', 'Approve stock counts'),
  ('adjustments.manage', 'Create and approve stock adjustments'),
  ('purchases.view', 'View purchases'),
  ('purchases.manage', 'Create purchases and receive goods'),
  ('suppliers.view', 'View suppliers'),
  ('suppliers.manage', 'Add and edit suppliers'),
  ('supplier_payments.manage', 'Record supplier payments'),
  ('ai_scan.use', 'Scan and approve supplier invoices'),
  ('import_export.use', 'Import and export store data'),
  ('lists.manage', 'Manage categories, units, tax rates and payment methods'),
  ('settings.manage', 'Change store settings'),
  ('users.manage', 'Manage staff accounts'),
  ('audit.view', 'Read the audit log');

insert into public.role_permissions (role_code, permission_code)
select 'Owner', code from public.permissions
where code in ('transactions.view', 'reports.sales', 'reports.inventory', 'reports.export')
union all
select 'Manager', code from public.permissions
where code not in ('pos.sell', 'held.manage', 'shifts.own', 'bills.print')
union all
select 'Cashier', code from public.permissions
where code in ('pos.sell', 'held.manage', 'bills.view', 'bills.print', 'shifts.own',
  'customers.view', 'customers.manage', 'barcode.scan')
union all
select 'Inventory Staff', code from public.permissions
where code in ('reports.inventory', 'barcode.scan', 'products.view', 'products.manage', 'inventory.view',
  'counts.manage', 'purchases.view', 'purchases.manage', 'suppliers.view', 'suppliers.manage');

insert into public.units (code, allow_decimal_qty) values
  ('Piece', false), ('Bag', false), ('Length', false), ('Pack', false),
  ('Roll', false), ('Tin', false), ('Set', false), ('Pair', false),
  ('Metre', true), ('Kg', true);

insert into public.tax_rates (name, rate, is_default) values ('Standard VAT', 18, true), ('Zero rated', 0, false);

insert into public.payment_methods (code, is_cash, requires_reference, sort_order) values
  ('Cash', true, false, 1), ('Card', false, false, 2), ('Bank transfer', false, true, 3);

insert into public.coupons (code, description, rate, first_purchase_only) values
  ('WELCOME10', 'First-time buyer coupon', 0.10, true);

insert into public.counters (name) values ('Counter 01'), ('Counter 02');

insert into public.store_settings (address, phone, vat_registration)
values ('Jaffna, Sri Lanka', '021 222 3344', '114 223 344-7000');

insert into public.number_sequences (prefix, pad_to) values
  ('RM-INV-', 6), ('RF-', 6), ('H-', 6), ('PO-', 6), ('GRN-', 6), ('SP-', 6),
  ('SC-', 6), ('ADJ-', 6), ('SH-', 6), ('EXP-', 6), ('RM-', 6), ('SUP-', 4), ('CUS-', 6);

-- ===== Lock everything down: only the API's service role reaches these tables =====

do $$
declare
  v_table record;
begin
  for v_table in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', v_table.tablename);
    execute format('revoke all on public.%I from public, anon, authenticated', v_table.tablename);
    execute format('grant select, insert, update, delete on public.%I to service_role', v_table.tablename);
  end loop;
end;
$$;

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
grant usage on all sequences in schema public to service_role;
