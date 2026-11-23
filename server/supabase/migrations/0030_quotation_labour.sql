-- Quotations can carry one technician work / labour fee: a description and a price, added to the total without VAT.
alter table public.quotations
  add column labour_description text not null default '',
  add column labour_fee numeric(14,2) not null default 0 check (labour_fee >= 0);

create or replace function public.save_quotation(p_quote jsonb, p_user uuid) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid := nullif(p_quote ->> 'id', '')::uuid;
  v_items jsonb := p_quote -> 'items';
  v_customer uuid := nullif(p_quote ->> 'customerId', '')::uuid;
  v_name text := coalesce(trim(p_quote ->> 'customerName'), '');
  v_phone text := coalesce(trim(p_quote ->> 'customerPhone'), '');
  v_valid date := nullif(p_quote ->> 'validUntil', '')::date;
  v_labour_fee numeric := coalesce(nullif(p_quote ->> 'labourFee', '')::numeric, 0);
  v_labour_text text := left(coalesce(trim(p_quote ->> 'labourDescription'), ''), 200);
  v_item record;
  v_product record;
  v_amount numeric;
  v_subtotal numeric := 0;
  v_tax numeric := 0;
begin
  if v_valid is null or v_valid < current_date then
    raise exception 'Choose a valid-until date from today onwards.' using errcode = 'P0001';
  end if;
  if v_labour_fee < 0 or v_labour_fee > 999999999 or v_labour_fee <> round(v_labour_fee, 2) then
    raise exception 'Enter a valid labour fee.' using errcode = 'P0001';
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
    insert into public.quotations (id, quote_no, customer_id, customer_name, customer_phone, valid_until, note, labour_description, labour_fee, created_by)
    values (v_id, public.next_document_number('QT-'), v_customer, v_name, v_phone, v_valid, coalesce(trim(p_quote ->> 'note'), ''), v_labour_text, v_labour_fee, p_user);
  else
    perform 1 from public.quotations where id = v_id and status = 'Draft' for update;
    if not found then
      raise exception 'CONFLICT:Only a draft quotation can be edited.' using errcode = 'P0001';
    end if;
    update public.quotations
    set customer_id = v_customer, customer_name = v_name, customer_phone = v_phone, valid_until = v_valid,
        note = coalesce(trim(p_quote ->> 'note'), ''), labour_description = v_labour_text, labour_fee = v_labour_fee
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

  update public.quotations set subtotal = v_subtotal, tax_total = v_tax, grand_total = v_subtotal + v_tax + v_labour_fee where id = v_id;
  return v_id;
end;
$$;

notify pgrst, 'reload schema';
