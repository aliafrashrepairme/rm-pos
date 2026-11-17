create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null check (role in ('Owner', 'Manager', 'Cashier', 'Inventory Staff')),
  email text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id text primary key,
  name text not null,
  sku text not null unique,
  category text not null,
  unit_cost numeric(12, 2) not null check (unit_cost >= 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  stock integer not null default 0 check (stock >= 0),
  reorder_level integer not null default 0 check (reorder_level >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null default '',
  email text not null default '',
  address text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  transaction_id text not null unique,
  date timestamptz not null default now(),
  total numeric(12, 2) not null default 0 check (total >= 0),
  status text not null default 'Completed' check (status in ('Completed', 'Refunded', 'Cancelled')),
  payment_method text not null check (payment_method in ('Cash', 'Card', 'Bank Transfer')),
  customer text not null default 'Walk-in Customer',
  created_by uuid references public.profiles(id)
);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id text not null references public.products(id),
  name text not null,
  category text not null,
  qty integer not null check (qty > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  line_total numeric(12, 2) not null check (line_total >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  date timestamptz not null default now(),
  product_id text not null references public.products(id),
  name text not null,
  type text not null check (type in ('Stock In', 'Stock Out')),
  quantity integer not null check (quantity > 0),
  reference_id text not null default '',
  note text not null default '',
  created_by uuid references public.profiles(id)
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  supplier_id uuid not null references public.suppliers(id),
  date timestamptz not null default now(),
  total numeric(12, 2) not null default 0 check (total >= 0),
  status text not null default 'Received' check (status in ('Received', 'Cancelled')),
  created_by uuid references public.profiles(id)
);

create table if not exists public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  product_id text not null references public.products(id),
  name text not null,
  qty integer not null check (qty > 0),
  unit_cost numeric(12, 2) not null check (unit_cost >= 0),
  line_total numeric(12, 2) not null check (line_total >= 0)
);

create index if not exists sales_date_idx on public.sales(date desc);
create index if not exists stock_movements_date_idx on public.stock_movements(date desc);
create index if not exists purchases_date_idx on public.purchases(date desc);
create index if not exists sale_items_sale_id_idx on public.sale_items(sale_id);
create index if not exists purchase_items_purchase_id_idx on public.purchase_items(purchase_id);

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.suppliers enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.stock_movements enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;

grant all on public.profiles, public.products, public.suppliers, public.sales,
  public.sale_items, public.stock_movements, public.purchases, public.purchase_items to service_role;

create or replace function public.create_product(
  p_product_id text,
  p_name text,
  p_sku text,
  p_category text,
  p_unit_cost numeric,
  p_unit_price numeric,
  p_initial_stock integer,
  p_reorder_level integer,
  p_created_by uuid
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_initial_stock < 0 or p_reorder_level < 0 then
    raise exception 'Initial stock and reorder level must not be negative.' using errcode = 'P0001';
  end if;

  insert into public.products (id, name, sku, category, unit_cost, unit_price, stock, reorder_level)
  values (p_product_id, p_name, p_sku, p_category, p_unit_cost, p_unit_price, p_initial_stock, p_reorder_level);

  if p_initial_stock > 0 then
    insert into public.stock_movements (product_id, name, type, quantity, note, created_by)
    values (p_product_id, p_name, 'Stock In', p_initial_stock, 'Opening stock', p_created_by);
  end if;

  return p_product_id;
end;
$$;

create or replace function public.adjust_stock(
  p_product_id text,
  p_type text,
  p_quantity integer,
  p_reference_id text,
  p_note text,
  p_created_by uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products%rowtype;
  v_movement_id uuid;
  v_next_stock integer;
begin
  if p_type not in ('Stock In', 'Stock Out') or p_quantity <= 0 then
    raise exception 'Invalid stock movement.' using errcode = 'P0001';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then raise exception 'NOT_FOUND:Product not found.' using errcode = 'P0001'; end if;

  v_next_stock := v_product.stock + case when p_type = 'Stock In' then p_quantity else -p_quantity end;
  if v_next_stock < 0 then
    raise exception 'INSUFFICIENT_STOCK:Stock cannot fall below zero.' using errcode = 'P0001';
  end if;

  update public.products set stock = v_next_stock, updated_at = now() where id = p_product_id;
  insert into public.stock_movements (product_id, name, type, quantity, reference_id, note, created_by)
  values (p_product_id, v_product.name, p_type, p_quantity, coalesce(p_reference_id, ''), coalesce(p_note, ''), p_created_by)
  returning id into v_movement_id;

  return v_movement_id;
end;
$$;

create or replace function public.create_sale(
  p_items jsonb,
  p_payment_method text,
  p_customer text,
  p_created_by uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale_id uuid := gen_random_uuid();
  v_order_id text := 'ORD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  v_transaction_id text := 'TXN-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  v_item jsonb;
  v_product public.products%rowtype;
  v_product_id text;
  v_quantity integer;
  v_line_total numeric(12, 2);
  v_total numeric(12, 2) := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one sale item is required.' using errcode = 'P0001';
  end if;
  if p_payment_method not in ('Cash', 'Card', 'Bank Transfer') then
    raise exception 'Unsupported payment method.' using errcode = 'P0001';
  end if;

  insert into public.sales (id, order_id, transaction_id, total, payment_method, customer, created_by)
  values (v_sale_id, v_order_id, v_transaction_id, 0, p_payment_method, coalesce(nullif(p_customer, ''), 'Walk-in Customer'), p_created_by);

  for v_item in select value from jsonb_array_elements(p_items) as items(value) loop
    v_product_id := v_item ->> 'productId';
    v_quantity := (v_item ->> 'qty')::integer;
    if v_product_id is null or v_quantity <= 0 then
      raise exception 'Invalid sale item.' using errcode = 'P0001';
    end if;
    select * into v_product from public.products where id = v_product_id for update;
    if not found then raise exception 'NOT_FOUND:Product not found.' using errcode = 'P0001'; end if;
    if v_product.stock < v_quantity then
      raise exception 'INSUFFICIENT_STOCK:Insufficient stock for %.', v_product.name using errcode = 'P0001';
    end if;

    v_line_total := round(v_product.unit_price * v_quantity, 2);
    v_total := v_total + v_line_total;
    update public.products set stock = stock - v_quantity, updated_at = now() where id = v_product_id;
    insert into public.sale_items (sale_id, product_id, name, category, qty, unit_price, line_total)
    values (v_sale_id, v_product.id, v_product.name, v_product.category, v_quantity, v_product.unit_price, v_line_total);
    insert into public.stock_movements (product_id, name, type, quantity, reference_id, note, created_by)
    values (v_product.id, v_product.name, 'Stock Out', v_quantity, v_order_id, 'POS sale', p_created_by);
  end loop;

  update public.sales set total = v_total where id = v_sale_id;
  return v_sale_id;
end;
$$;

create or replace function public.receive_purchase(
  p_supplier_id uuid,
  p_items jsonb,
  p_created_by uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_purchase_id uuid := gen_random_uuid();
  v_reference text := 'PO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  v_item jsonb;
  v_product public.products%rowtype;
  v_product_id text;
  v_quantity integer;
  v_unit_cost numeric(12, 2);
  v_line_total numeric(12, 2);
  v_total numeric(12, 2) := 0;
begin
  if not exists (select 1 from public.suppliers where id = p_supplier_id) then
    raise exception 'NOT_FOUND:Supplier not found.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one purchase item is required.' using errcode = 'P0001';
  end if;

  insert into public.purchases (id, reference, supplier_id, total, created_by)
  values (v_purchase_id, v_reference, p_supplier_id, 0, p_created_by);

  for v_item in select value from jsonb_array_elements(p_items) as items(value) loop
    v_product_id := v_item ->> 'productId';
    v_quantity := (v_item ->> 'qty')::integer;
    v_unit_cost := (v_item ->> 'unitCost')::numeric(12, 2);
    if v_product_id is null or v_quantity <= 0 or v_unit_cost < 0 then
      raise exception 'Invalid purchase item.' using errcode = 'P0001';
    end if;
    select * into v_product from public.products where id = v_product_id for update;
    if not found then raise exception 'NOT_FOUND:Product not found.' using errcode = 'P0001'; end if;

    v_line_total := round(v_unit_cost * v_quantity, 2);
    v_total := v_total + v_line_total;
    update public.products set stock = stock + v_quantity, unit_cost = v_unit_cost, updated_at = now() where id = v_product_id;
    insert into public.purchase_items (purchase_id, product_id, name, qty, unit_cost, line_total)
    values (v_purchase_id, v_product.id, v_product.name, v_quantity, v_unit_cost, v_line_total);
    insert into public.stock_movements (product_id, name, type, quantity, reference_id, note, created_by)
    values (v_product.id, v_product.name, 'Stock In', v_quantity, v_reference, 'Supplier purchase', p_created_by);
  end loop;

  update public.purchases set total = v_total where id = v_purchase_id;
  return v_purchase_id;
end;
$$;

revoke all on function public.create_product(text, text, text, text, numeric, numeric, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.adjust_stock(text, text, integer, text, text, uuid) from public, anon, authenticated;
revoke all on function public.create_sale(jsonb, text, text, uuid) from public, anon, authenticated;
revoke all on function public.receive_purchase(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.create_product(text, text, text, text, numeric, numeric, integer, integer, uuid) to service_role;
grant execute on function public.adjust_stock(text, text, integer, text, text, uuid) to service_role;
grant execute on function public.create_sale(jsonb, text, text, uuid) to service_role;
grant execute on function public.receive_purchase(uuid, jsonb, uuid) to service_role;

insert into public.products (id, name, sku, category, unit_cost, unit_price, stock, reorder_level)
values
  ('P-1001', 'Claw Hammer 16oz', 'HT-1001', 'Hand Tools', 850, 1450, 42, 15),
  ('P-1002', 'Adjustable Wrench 10in', 'HT-1002', 'Hand Tools', 620, 1100, 8, 10),
  ('P-1003', 'Cordless Drill 18V', 'PT-2001', 'Power Tools', 7800, 12900, 14, 5),
  ('P-1004', 'Angle Grinder 850W', 'PT-2002', 'Power Tools', 6200, 9800, 0, 6),
  ('P-1005', 'PVC Pipe 1in (3m)', 'PL-3001', 'Plumbing', 320, 520, 180, 40),
  ('P-1006', 'Brass Tap Fitting', 'PL-3002', 'Plumbing', 410, 690, 26, 20),
  ('P-1007', 'MCB Circuit Breaker 20A', 'EL-4001', 'Electrical', 540, 890, 60, 25),
  ('P-1008', 'LED Bulb 12W', 'EL-4002', 'Electrical', 180, 350, 9, 30),
  ('P-1009', 'Emulsion Paint 4L (White)', 'PT-5001', 'Paint', 2400, 3600, 22, 10),
  ('P-1010', 'Enamel Paint 1L (Red)', 'PT-5002', 'Paint', 780, 1250, 4, 8),
  ('P-1011', 'Hex Bolt M8x40 (Box 100)', 'FA-6001', 'Fasteners', 950, 1500, 35, 12),
  ('P-1012', 'Wood Screw 2in (Box 200)', 'FA-6002', 'Fasteners', 680, 1080, 50, 15),
  ('P-1013', 'Safety Helmet', 'SG-7001', 'Safety Gear', 650, 1100, 18, 10),
  ('P-1014', 'Work Gloves (Pair)', 'SG-7002', 'Safety Gear', 220, 420, 3, 20),
  ('P-1015', 'Measuring Tape 5m', 'HT-1003', 'Hand Tools', 310, 550, 60, 20)
on conflict (id) do nothing;