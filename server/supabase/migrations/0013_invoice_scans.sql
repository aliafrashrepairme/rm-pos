-- Supplier invoice scanning. Nothing here touches stock: approval creates an order, and stock moves only when it is received.

alter table public.invoice_scan_lines add column match_score numeric(5, 2);

-- The closest active product for a line of invoice text. An exact SKU or barcode beats a similar name.
create function public.match_invoice_text(p_text text) returns table (product_id uuid, score numeric)
language sql stable set search_path = public, extensions, pg_temp as $$
  select id, score from (
    select p.id, 100::numeric as score, 1 as rank
    from public.products p
    where p.active and (
      (length(p.sku) >= 4 and position(lower(p.sku) in lower(p_text)) > 0)
      or (length(coalesce(p.barcode, '')) >= 6 and position(p.barcode in p_text) > 0)
    )
    union all
    select p.id, round((similarity(lower(p.name), lower(p_text)) * 100)::numeric, 2), 2
    from public.products p
    where p.active and similarity(lower(p.name), lower(p_text)) >= 0.3
  ) found
  order by rank, score desc, id
  limit 1;
$$;

create function public.save_invoice_extraction(p_scan uuid, p_result jsonb, p_provider text) returns void
language plpgsql set search_path = public, extensions, pg_temp as $$
declare
  v_supplier uuid;
  v_line record;
  v_match record;
begin
  perform 1 from public.invoice_scans where id = p_scan and status = 'Processing' for update;
  if not found then raise exception 'CONFLICT:This scan is no longer being processed.' using errcode = 'P0001'; end if;

  select s.id into v_supplier from public.suppliers s
  where s.active and similarity(lower(s.name), lower(coalesce(p_result ->> 'supplierName', ''))) >= 0.4
  order by similarity(lower(s.name), lower(p_result ->> 'supplierName')) desc, s.id
  limit 1;

  delete from public.invoice_scan_lines where invoice_scan_id = p_scan;
  for v_line in
    select value as line, ordinality as line_no from jsonb_array_elements(p_result -> 'lines') with ordinality
  loop
    select * into v_match from public.match_invoice_text(v_line.line ->> 'description');
    insert into public.invoice_scan_lines (invoice_scan_id, line_no, raw_text, qty, unit_cost, confidence, matched_product_id, match_score)
    values (
      p_scan, v_line.line_no, v_line.line ->> 'description',
      (v_line.line ->> 'qty')::numeric, (v_line.line ->> 'unitCost')::numeric, (v_line.line ->> 'confidence')::numeric,
      v_match.product_id, v_match.score
    );
  end loop;

  update public.invoice_scans
  set status = 'Extracted', provider = p_provider, error_message = null, raw_result = p_result,
      supplier_text = p_result ->> 'supplierName', supplier_id = v_supplier,
      invoice_no = p_result ->> 'invoiceNo', invoice_date = nullif(p_result ->> 'invoiceDate', '')::date,
      overall_confidence = (p_result ->> 'confidence')::numeric, updated_at = now()
  where id = p_scan;
end;
$$;

-- Stores what the person reviewing decided. Only a scan awaiting review can change.
create function public.save_invoice_review(p_scan uuid, p_review jsonb) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_status text;
  v_line record;
begin
  select status into v_status from public.invoice_scans where id = p_scan for update;
  if not found then raise exception 'NOT_FOUND:Invoice scan not found.' using errcode = 'P0001'; end if;
  if v_status <> 'Extracted' then
    raise exception 'CONFLICT:This scan has already been %.', lower(v_status) using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_review -> 'lines') is distinct from 'array' or jsonb_array_length(p_review -> 'lines') = 0 then
    raise exception 'Keep at least one line on the invoice.' using errcode = 'P0001';
  end if;

  update public.invoice_scans
  set supplier_id = nullif(p_review ->> 'supplierId', '')::uuid,
      invoice_no = nullif(trim(p_review ->> 'invoiceNo'), ''),
      invoice_date = nullif(p_review ->> 'invoiceDate', '')::date,
      updated_at = now()
  where id = p_scan;

  delete from public.invoice_scan_lines where invoice_scan_id = p_scan;
  for v_line in
    select value as line, ordinality as line_no from jsonb_array_elements(p_review -> 'lines') with ordinality
  loop
    insert into public.invoice_scan_lines (invoice_scan_id, line_no, raw_text, qty, unit_cost, confidence, matched_product_id, match_score)
    values (
      p_scan, v_line.line_no, trim(v_line.line ->> 'description'),
      nullif(v_line.line ->> 'qty', '')::numeric, nullif(v_line.line ->> 'unitCost', '')::numeric,
      nullif(v_line.line ->> 'confidence', '')::numeric, nullif(v_line.line ->> 'productId', '')::uuid,
      nullif(v_line.line ->> 'matchScore', '')::numeric
    );
  end loop;
end;
$$;

-- The review and the new order commit together, so a scan can't approve twice or half-approve.
create function public.approve_invoice_scan(p_scan uuid, p_review jsonb, p_user uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_scan public.invoice_scans%rowtype;
  v_purchase uuid;
  v_po text;
begin
  perform public.save_invoice_review(p_scan, p_review);
  select * into v_scan from public.invoice_scans where id = p_scan;
  if v_scan.supplier_id is null then raise exception 'Choose the supplier.' using errcode = 'P0001'; end if;
  if v_scan.invoice_no is null then raise exception 'Enter the invoice number.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.invoice_scan_lines where invoice_scan_id = p_scan and matched_product_id is null) then
    raise exception 'Match every line to a product, or remove it.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.invoice_scan_lines where invoice_scan_id = p_scan and (qty is null or unit_cost is null)) then
    raise exception 'Enter the quantity and unit cost for every line.' using errcode = 'P0001';
  end if;

  v_purchase := public.create_purchase(jsonb_build_object(
    'supplierId', v_scan.supplier_id,
    'status', 'Ordered',
    'source', 'AI Scan',
    'supplierInvoiceNo', v_scan.invoice_no,
    'note', 'From invoice scan ' || v_scan.file_name,
    'items', (
      select jsonb_agg(jsonb_build_object('productId', matched_product_id, 'qty', qty, 'unitCost', unit_cost) order by line_no)
      from public.invoice_scan_lines where invoice_scan_id = p_scan
    )
  ), p_user);

  update public.invoice_scan_lines set confirmed = true where invoice_scan_id = p_scan;
  update public.invoice_scans set status = 'Approved', purchase_id = v_purchase, updated_at = now() where id = p_scan;
  select po_no into v_po from public.purchases where id = v_purchase;
  return jsonb_build_object('purchaseId', v_purchase, 'poNo', v_po);
end;
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'match_invoice_text(text)',
    'save_invoice_extraction(uuid, jsonb, text)',
    'save_invoice_review(uuid, jsonb)',
    'approve_invoice_scan(uuid, jsonb, uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
