-- Quotations: a priced offer to a customer that changes no stock and takes no money.
-- Draft → Sent → Accepted → Converted (a POS bill), or Rejected / Cancelled / Expired on the way.

insert into public.number_sequences (prefix, pad_to) values ('QT-', 6) on conflict (prefix) do nothing;

insert into public.permissions (code, description) values
  ('quotations.view', 'View quotations'),
  ('quotations.manage', 'Create, send and update quotations')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code) values
  ('Manager', 'quotations.view'), ('Manager', 'quotations.manage'),
  ('Cashier', 'quotations.view'), ('Cashier', 'quotations.manage')
on conflict do nothing;

create table public.quotations (
  id uuid primary key default gen_random_uuid(),
  quote_no text not null unique,
  status text not null default 'Draft'
    check (status in ('Draft', 'Sent', 'Accepted', 'Rejected', 'Converted', 'Expired', 'Cancelled')),
  customer_id uuid references public.customers(id),
  customer_name text not null default '',
  customer_phone text not null default '',
  valid_until date not null,
  note text not null default '',
  subtotal numeric(14,2) not null default 0 check (subtotal >= 0),
  tax_total numeric(14,2) not null default 0 check (tax_total >= 0),
  grand_total numeric(14,2) not null default 0 check (grand_total >= 0),
  sale_id uuid unique references public.sales(id),
  sent_at timestamptz,
  decided_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'Converted') = (sale_id is not null))
);
create index quotations_status_idx on public.quotations(status, created_at desc);
create index quotations_customer_idx on public.quotations(customer_id);
create trigger quotations_updated_at before update on public.quotations for each row execute function public.set_updated_at();

-- Prices are copied onto the quote, so later price changes don't rewrite what the customer was offered.
create table public.quotation_items (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null references public.quotations(id) on delete cascade,
  line_no integer not null,
  product_id uuid not null references public.products(id),
  qty numeric(14,3) not null check (qty > 0),
  unit_price numeric(14,2) not null check (unit_price >= 0),
  tax_rate numeric(5,2) not null default 0 check (tax_rate >= 0),
  unique (quotation_id, line_no),
  unique (quotation_id, product_id)
);
create index quotation_items_product_idx on public.quotation_items(product_id);

alter table public.quotations enable row level security;
alter table public.quotation_items enable row level security;
revoke all on public.quotations, public.quotation_items from public, anon, authenticated;
grant select, insert, update, delete on public.quotations, public.quotation_items to service_role;

-- Creates a quote, or replaces a draft's details and lines when an id is given.
create function public.save_quotation(p_quote jsonb, p_user uuid) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid := nullif(p_quote ->> 'id', '')::uuid;
  v_items jsonb := p_quote -> 'items';
  v_customer uuid := nullif(p_quote ->> 'customerId', '')::uuid;
  v_name text := coalesce(trim(p_quote ->> 'customerName'), '');
  v_phone text := coalesce(trim(p_quote ->> 'customerPhone'), '');
  v_valid date := nullif(p_quote ->> 'validUntil', '')::date;
  v_item record;
  v_product record;
  v_amount numeric;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
begin
  if v_valid is null or v_valid < current_date then
    raise exception 'Choose a valid-until date from today onwards.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Add at least one product.' using errcode = 'P0001';
  end if;
  if (select count(*) <> count(distinct value ->> 'productId') from jsonb_array_elements(v_items)) then
    raise exception 'A product appears twice on this quotation.' using errcode = 'P0001';
  end if;
  if v_customer is not null then
    select name, phone into v_product from public.customers where id = v_customer and active;
    if not found then raise exception 'Choose an active customer.' using errcode = 'P0001'; end if;
    if v_name = '' then v_name := v_product.name; end if;
    if v_phone = '' then v_phone := v_product.phone; end if;
  end if;
  if v_name = '' then
    raise exception 'Enter the customer''s name.' using errcode = 'P0001';
  end if;

  if v_id is null then
    v_id := gen_random_uuid();
    insert into public.quotations (id, quote_no, customer_id, customer_name, customer_phone, valid_until, note, created_by)
    values (v_id, public.next_document_number('QT-'), v_customer, v_name, v_phone, v_valid, coalesce(trim(p_quote ->> 'note'), ''), p_user);
  else
    perform 1 from public.quotations where id = v_id and status = 'Draft' for update;
    if not found then
      raise exception 'CONFLICT:Only a draft quotation can be edited.' using errcode = 'P0001';
    end if;
    update public.quotations
    set customer_id = v_customer, customer_name = v_name, customer_phone = v_phone, valid_until = v_valid,
        note = coalesce(trim(p_quote ->> 'note'), '')
    where id = v_id;
    delete from public.quotation_items where quotation_id = v_id;
  end if;

  for v_item in
    select (value ->> 'productId')::uuid as product_id, (value ->> 'qty')::numeric as qty, ordinality as line_no
    from jsonb_array_elements(v_items) with ordinality
  loop
    if v_item.qty is null or v_item.qty <= 0 or v_item.qty <> round(v_item.qty, 3) then
      raise exception 'Enter a valid quantity for every product.' using errcode = 'P0001';
    end if;
    select p.selling_price, coalesce(t.rate, 0) as rate, u.allow_decimal_qty into v_product
    from public.products p
    join public.units u on u.code = p.unit_code
    left join public.tax_rates t on t.id = p.tax_rate_id
    where p.id = v_item.product_id and p.active;
    if not found then raise exception 'A product on this quotation is not active.' using errcode = 'P0001'; end if;
    if not v_product.allow_decimal_qty and v_item.qty <> trunc(v_item.qty) then
      raise exception 'INVALID_QTY:This product is sold in whole units.' using errcode = 'P0001';
    end if;
    insert into public.quotation_items (quotation_id, line_no, product_id, qty, unit_price, tax_rate)
    values (v_id, v_item.line_no, v_item.product_id, v_item.qty, v_product.selling_price, v_product.rate);
    v_amount := round(v_item.qty * v_product.selling_price, 2);
    v_subtotal := v_subtotal + v_amount;
    v_tax := v_tax + round(v_amount * v_product.rate / 100, 2);
  end loop;

  update public.quotations set subtotal = v_subtotal, tax_total = v_tax, grand_total = v_subtotal + v_tax where id = v_id;
  return v_id;
end;
$$;

-- Open quotes past their valid-until date become Expired. Safe to run as often as needed.
create function public.expire_quotations() returns integer
language plpgsql set search_path = public, pg_temp as $$
declare
  v_count integer;
begin
  update public.quotations set status = 'Expired', decided_at = now()
  where status in ('Draft', 'Sent', 'Accepted') and valid_until < current_date;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The allowed moves. Converted is reached only through convert_quotation, with a real bill.
create function public.set_quotation_status(p_quote uuid, p_status text) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_quote public.quotations%rowtype;
begin
  perform public.expire_quotations();
  select * into v_quote from public.quotations where id = p_quote for update;
  if not found then raise exception 'NOT_FOUND:Quotation not found.' using errcode = 'P0001'; end if;
  if not (
    (v_quote.status = 'Draft' and p_status in ('Sent', 'Cancelled')) or
    (v_quote.status = 'Sent' and p_status in ('Accepted', 'Rejected', 'Cancelled')) or
    (v_quote.status = 'Accepted' and p_status = 'Cancelled')
  ) then
    raise exception 'CONFLICT:A % quotation cannot be marked %.', lower(v_quote.status), lower(p_status) using errcode = 'P0001';
  end if;
  update public.quotations
  set status = p_status,
      sent_at = case when p_status = 'Sent' then now() else sent_at end,
      decided_at = case when p_status in ('Accepted', 'Rejected', 'Cancelled') then now() else decided_at end
  where id = p_quote;
  return jsonb_build_object('quoteNo', v_quote.quote_no, 'from', v_quote.status, 'to', p_status);
end;
$$;

-- Links an accepted quote to the bill made from it in POS.
create function public.convert_quotation(p_quote uuid, p_sale uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_quote public.quotations%rowtype;
  v_bill text;
begin
  select * into v_quote from public.quotations where id = p_quote for update;
  if not found then raise exception 'NOT_FOUND:Quotation not found.' using errcode = 'P0001'; end if;
  if v_quote.status = 'Converted' and v_quote.sale_id = p_sale then
    return jsonb_build_object('quoteNo', v_quote.quote_no, 'billNo', (select bill_no from public.sales where id = p_sale), 'replayed', true);
  end if;
  if v_quote.status <> 'Accepted' then
    raise exception 'CONFLICT:Only an accepted quotation can be converted. This one is %.', lower(v_quote.status) using errcode = 'P0001';
  end if;
  select bill_no into v_bill from public.sales where id = p_sale and status <> 'Voided';
  if not found then raise exception 'NOT_FOUND:Bill not found.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.quotations where sale_id = p_sale) then
    raise exception 'CONFLICT:That bill is already linked to another quotation.' using errcode = 'P0001';
  end if;
  update public.quotations set status = 'Converted', sale_id = p_sale, decided_at = now() where id = p_quote;
  return jsonb_build_object('quoteNo', v_quote.quote_no, 'billNo', v_bill, 'replayed', false);
end;
$$;

create function public.quotation_counts() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
  from (select status, count(*) as n from public.quotations group by status) s;
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'save_quotation(jsonb, uuid)',
    'expire_quotations()',
    'set_quotation_status(uuid, text)',
    'convert_quotation(uuid, uuid)',
    'quotation_counts()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
