-- Purchase orders, receiving and supplier payments. Stock only moves when goods are received.

create function public.create_supplier(p_supplier jsonb) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  insert into public.suppliers (code, name, contact_person, phone, email, address, city, payment_terms, lead_time_days)
  values (
    public.next_document_number('SUP-'), trim(p_supplier ->> 'name'), coalesce(trim(p_supplier ->> 'contactPerson'), ''),
    coalesce(trim(p_supplier ->> 'phone'), ''), coalesce(trim(p_supplier ->> 'email'), ''), coalesce(trim(p_supplier ->> 'address'), ''),
    coalesce(trim(p_supplier ->> 'city'), ''), coalesce(nullif(trim(p_supplier ->> 'paymentTerms'), ''), 'Cash'),
    coalesce((p_supplier ->> 'leadTimeDays')::integer, 5)
  )
  returning id into v_id;
  return v_id;
end;
$$;

create function public.create_purchase(p_purchase jsonb, p_user uuid) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid := gen_random_uuid();
  v_status text := coalesce(p_purchase ->> 'status', 'Draft');
  v_source text := coalesce(p_purchase ->> 'source', 'Manual');
  v_supplier uuid := (p_purchase ->> 'supplierId')::uuid;
  v_items jsonb := p_purchase -> 'items';
  v_item record;
  v_total numeric := 0;
begin
  if v_status not in ('Draft', 'Ordered') then
    raise exception 'A new purchase must be a draft or an order.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.suppliers where id = v_supplier and active) then
    raise exception 'Choose an active supplier.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Add at least one product.' using errcode = 'P0001';
  end if;
  if (select count(*) <> count(distinct value ->> 'productId') from jsonb_array_elements(v_items)) then
    raise exception 'A product appears twice on this order.' using errcode = 'P0001';
  end if;

  insert into public.purchases (id, po_no, supplier_id, status, source, supplier_invoice_no, ordered_at, expected_at, note, created_by)
  values (
    v_id, public.next_document_number('PO-'), v_supplier, v_status, v_source, nullif(trim(p_purchase ->> 'supplierInvoiceNo'), ''),
    case when v_status = 'Ordered' then now() end, nullif(p_purchase ->> 'expectedAt', '')::date, coalesce(p_purchase ->> 'note', ''), p_user
  );

  for v_item in
    select (value ->> 'productId')::uuid as product_id, (value ->> 'qty')::numeric as qty, (value ->> 'unitCost')::numeric as unit_cost, ordinality as line_no
    from jsonb_array_elements(v_items) with ordinality
  loop
    if v_item.qty is null or v_item.qty <= 0 or v_item.qty <> round(v_item.qty, 3) then
      raise exception 'Enter a valid quantity for every product.' using errcode = 'P0001';
    end if;
    if v_item.unit_cost is null or v_item.unit_cost < 0 then
      raise exception 'Enter a valid cost for every product.' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.products where id = v_item.product_id and active) then
      raise exception 'A product on this order is not active.' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.products p join public.units u on u.code = p.unit_code
      where p.id = v_item.product_id and (u.allow_decimal_qty or v_item.qty = trunc(v_item.qty))
    ) then
      raise exception 'INVALID_QTY:This product is ordered in whole units.' using errcode = 'P0001';
    end if;
    insert into public.purchase_items (purchase_id, line_no, product_id, qty_ordered, unit_cost)
    values (v_id, v_item.line_no, v_item.product_id, v_item.qty, v_item.unit_cost);
    v_total := v_total + round(v_item.qty * v_item.unit_cost, 2);
  end loop;

  update public.purchases set subtotal = v_total, total = v_total where id = v_id;
  return v_id;
end;
$$;

-- Each request ID posts once, and the row lock means two deliveries can't exceed what was ordered.
create function public.receive_purchase(p_receipt jsonb, p_user uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_request uuid := (p_receipt ->> 'clientRequestId')::uuid;
  v_purchase_id uuid := (p_receipt ->> 'purchaseId')::uuid;
  v_lines jsonb := p_receipt -> 'lines';
  v_existing record;
  v_purchase public.purchases%rowtype;
  v_receipt_id uuid := gen_random_uuid();
  v_grn text;
  v_line record;
  v_matched integer := 0;
  v_status text;
begin
  if v_request is null then raise exception 'A request ID is required.' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_request::text, 0));
  select id, grn_no into v_existing from public.goods_receipts where client_request_id = v_request;
  if found then
    return jsonb_build_object('id', v_existing.id, 'grnNo', v_existing.grn_no, 'replayed', true);
  end if;

  select * into v_purchase from public.purchases where id = v_purchase_id for update;
  if not found then raise exception 'NOT_FOUND:Purchase order not found.' using errcode = 'P0001'; end if;
  if v_purchase.status not in ('Ordered', 'Partially Received') then
    raise exception 'CONFLICT:Only an open order can be received. This one is %.', v_purchase.status using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'Enter the quantity delivered for at least one product.' using errcode = 'P0001';
  end if;
  if (select count(*) <> count(distinct value ->> 'purchaseItemId') from jsonb_array_elements(v_lines)) then
    raise exception 'A product appears twice on this delivery.' using errcode = 'P0001';
  end if;

  v_grn := public.next_document_number('GRN-');
  insert into public.goods_receipts (id, grn_no, client_request_id, purchase_id, note, received_by)
  values (v_receipt_id, v_grn, v_request, v_purchase_id, coalesce(p_receipt ->> 'note', ''), p_user);

  -- Fixed product order, so simultaneous stock changes can't deadlock.
  for v_line in
    select pi.id, pi.product_id, pi.qty_ordered, pi.qty_received, pi.unit_cost, p.name, (entry.value ->> 'qty')::numeric as qty
    from jsonb_array_elements(v_lines) as entry(value)
    join public.purchase_items pi on pi.id = (entry.value ->> 'purchaseItemId')::uuid and pi.purchase_id = v_purchase_id
    join public.products p on p.id = pi.product_id
    order by pi.product_id
  loop
    v_matched := v_matched + 1;
    if v_line.qty is null or v_line.qty <= 0 or v_line.qty <> round(v_line.qty, 3) then
      raise exception 'Enter a valid quantity for every product.' using errcode = 'P0001';
    end if;
    if v_line.qty > v_line.qty_ordered - v_line.qty_received then
      raise exception 'CONFLICT:Only % of % is still due on this order.', v_line.qty_ordered - v_line.qty_received, v_line.name using errcode = 'P0001';
    end if;
    insert into public.goods_receipt_items (goods_receipt_id, purchase_item_id, qty) values (v_receipt_id, v_line.id, v_line.qty);
    update public.purchase_items set qty_received = qty_received + v_line.qty where id = v_line.id;
    perform public.post_stock_movement(v_line.product_id, 'Purchase', v_line.qty, 'Goods received', 'goods_receipt', v_receipt_id::text, v_grn, p_user, v_line.unit_cost);
    -- The latest delivery sets the cost used for stock value and profit from now on.
    update public.products set cost_price = v_line.unit_cost where id = v_line.product_id;
  end loop;

  if v_matched <> jsonb_array_length(v_lines) then
    raise exception 'NOT_FOUND:A product on this delivery is not on the order.' using errcode = 'P0001';
  end if;

  v_status := case when exists (select 1 from public.purchase_items where purchase_id = v_purchase_id and qty_received < qty_ordered)
    then 'Partially Received' else 'Received' end;
  update public.purchases set status = v_status where id = v_purchase_id;

  return jsonb_build_object('id', v_receipt_id, 'grnNo', v_grn, 'status', v_status, 'replayed', false);
end;
$$;

create function public.pay_supplier(p_payment jsonb, p_user uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_purchase public.purchases%rowtype;
  v_amount numeric := (p_payment ->> 'amount')::numeric;
  v_method text := p_payment ->> 'method';
  v_no text;
begin
  select * into v_purchase from public.purchases where id = (p_payment ->> 'purchaseId')::uuid for update;
  if not found then raise exception 'NOT_FOUND:Purchase order not found.' using errcode = 'P0001'; end if;
  if v_purchase.status in ('Draft', 'Cancelled') then
    raise exception 'CONFLICT:This order cannot take a payment while it is %.', v_purchase.status using errcode = 'P0001';
  end if;
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
    raise exception 'Enter a valid amount.' using errcode = 'P0001';
  end if;
  if v_amount > v_purchase.total - v_purchase.paid_total then
    raise exception 'CONFLICT:Only % is still owed on this order.', v_purchase.total - v_purchase.paid_total using errcode = 'P0001';
  end if;
  if v_method not in ('Cash', 'Bank transfer', 'Cheque') then
    raise exception 'Choose a valid payment method.' using errcode = 'P0001';
  end if;
  v_no := public.next_document_number('SP-');
  insert into public.supplier_payments (payment_no, supplier_id, purchase_id, amount, method, reference, created_by)
  values (v_no, v_purchase.supplier_id, v_purchase.id, v_amount, v_method, coalesce(trim(p_payment ->> 'reference'), ''), p_user);
  update public.purchases set paid_total = paid_total + v_amount where id = v_purchase.id;
  return jsonb_build_object('paymentNo', v_no, 'paidTotal', v_purchase.paid_total + v_amount, 'total', v_purchase.total);
end;
$$;

-- Low items for a supplier that aren't already on an open order, up to twice the reorder level.
create function public.reorder_suggestions(p_supplier uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', p.id, 'name', p.name, 'sku', p.sku, 'unit', p.unit_code, 'stock', p.stock_qty,
    'minStock', p.min_stock, 'unitCost', p.cost_price, 'qty', greatest(p.min_stock * 2 - p.stock_qty, p.min_stock, 1)
  ) order by p.name), '[]'::jsonb)
  from public.products p
  where p.active and p.preferred_supplier_id = p_supplier and p.stock_qty <= p.min_stock
    and not exists (
      select 1 from public.purchase_items pi
      join public.purchases po on po.id = pi.purchase_id
      where pi.product_id = p.id and po.status in ('Draft', 'Ordered', 'Partially Received') and pi.qty_received < pi.qty_ordered
    );
$$;

create function public.auto_reorder(p_user uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_supplier record;
  v_lines jsonb;
  v_id uuid;
  v_created jsonb := '[]';
begin
  for v_supplier in select id from public.suppliers where active order by name loop
    v_lines := public.reorder_suggestions(v_supplier.id);
    if jsonb_array_length(v_lines) > 0 then
      v_id := public.create_purchase(jsonb_build_object('supplierId', v_supplier.id, 'status', 'Draft', 'source', 'Auto-reorder', 'items', v_lines), p_user);
      v_created := v_created || to_jsonb((select po_no from public.purchases where id = v_id));
    end if;
  end loop;
  return jsonb_build_object(
    'created', v_created,
    -- Low items with no supplier can't be ordered automatically, so the screen says so.
    'withoutSupplier', (select count(*) from public.products where active and stock_qty <= min_stock and preferred_supplier_id is null)
  );
end;
$$;

create function public.purchases_summary() returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'awaiting', coalesce((
      select sum(round((pi.qty_ordered - pi.qty_received) * pi.unit_cost, 2))
      from public.purchase_items pi join public.purchases po on po.id = pi.purchase_id
      where po.status in ('Ordered', 'Partially Received')
    ), 0),
    'openOrders', (select count(*) from public.purchases where status in ('Ordered', 'Partially Received')),
    'payable', coalesce((select sum(total - paid_total) from public.purchases where status not in ('Draft', 'Cancelled')), 0),
    'drafts', (select count(*) from public.purchases where status = 'Draft')
  );
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'create_supplier(jsonb)',
    'create_purchase(jsonb, uuid)',
    'receive_purchase(jsonb, uuid)',
    'pay_supplier(jsonb, uuid)',
    'reorder_suggestions(uuid)',
    'auto_reorder(uuid)',
    'purchases_summary()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
