-- Product creation: generated SKUs and barcodes, with opening stock posted through the ledger.

create extension if not exists pg_trgm with schema extensions;

-- Search matches anywhere in these fields, which a normal index can't speed up.
create index products_name_search_idx on public.products using gin (name extensions.gin_trgm_ops);
create index products_sku_search_idx on public.products using gin (sku extensions.gin_trgm_ops);
create index products_barcode_search_idx on public.products using gin (barcode extensions.gin_trgm_ops);

insert into public.number_sequences (prefix, pad_to) values ('BC-', 10) on conflict do nothing;

create function public.ean13_check_digit(p_first_twelve text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select ((10 - sum(substr(p_first_twelve, position, 1)::int * case when position % 2 = 0 then 3 else 1 end)::int % 10) % 10)::text
  from generate_series(1, 12) as position;
$$;

-- EAN-13 codes starting 20 are reserved for use inside a store, so they can't clash with
-- a manufacturer's barcode. The loop skips any code someone has already entered by hand.
create function public.next_store_barcode() returns text
language plpgsql set search_path = public, pg_temp as $$
declare
  v_first_twelve text;
  v_barcode text;
begin
  loop
    v_first_twelve := '20' || substr(public.next_document_number('BC-'), 4);
    v_barcode := v_first_twelve || public.ean13_check_digit(v_first_twelve);
    exit when not exists (select 1 from public.products where barcode = v_barcode);
  end loop;
  return v_barcode;
end;
$$;

create function public.create_product(p_product jsonb, p_created_by uuid) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_sku text := nullif(trim(p_product ->> 'sku'), '');
  v_barcode text := nullif(trim(p_product ->> 'barcode'), '');
  v_opening numeric(12, 3) := coalesce((p_product ->> 'openingStock')::numeric, 0);
  v_cost numeric(12, 2) := coalesce((p_product ->> 'costPrice')::numeric, 0);
begin
  if v_opening < 0 then
    raise exception 'Opening stock cannot be negative.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.categories where id = (p_product ->> 'categoryId')::uuid and active) then
    raise exception 'Choose an active category.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.units where code = p_product ->> 'unitCode' and active) then
    raise exception 'Choose an active unit.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.tax_rates where id = (p_product ->> 'taxRateId')::uuid and active) then
    raise exception 'Choose an active tax rate.' using errcode = 'P0001';
  end if;

  if v_sku is null then
    loop
      v_sku := public.next_document_number('RM-');
      exit when not exists (select 1 from public.products where sku = v_sku);
    end loop;
  end if;
  v_barcode := coalesce(v_barcode, public.next_store_barcode());

  insert into public.products (sku, barcode, name, description, category_id, unit_code, cost_price, selling_price,
    tax_rate_id, min_stock, location, preferred_supplier_id, created_by)
  values (v_sku, v_barcode, trim(p_product ->> 'name'), coalesce(p_product ->> 'description', ''),
    (p_product ->> 'categoryId')::uuid, p_product ->> 'unitCode', v_cost, (p_product ->> 'sellingPrice')::numeric,
    (p_product ->> 'taxRateId')::uuid, coalesce((p_product ->> 'minStock')::numeric, 0), coalesce(p_product ->> 'location', ''),
    nullif(p_product ->> 'preferredSupplierId', '')::uuid, p_created_by)
  returning id into v_id;

  if v_opening > 0 then
    perform public.post_stock_movement(v_id, 'Opening', v_opening, 'Opening stock', 'product', v_id::text, v_sku, p_created_by, v_cost);
  end if;
  return v_id;
end;
$$;

revoke all on function public.ean13_check_digit(text) from public, anon, authenticated;
revoke all on function public.next_store_barcode() from public, anon, authenticated;
revoke all on function public.create_product(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.ean13_check_digit(text) to service_role;
grant execute on function public.next_store_barcode() to service_role;
grant execute on function public.create_product(jsonb, uuid) to service_role;

notify pgrst, 'reload schema';
