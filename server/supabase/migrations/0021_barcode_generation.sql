-- Barcode generation for products that have none. Each gets a store barcode (EAN-13 starting
-- 20, see next_store_barcode in 0003), which never clashes with a maker's barcode or with any
-- barcode already saved. Products that already have a barcode keep it.

create function public.fill_missing_barcodes() returns integer
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in select id from public.products where barcode is null order by created_at, id for update loop
    update public.products set barcode = public.next_store_barcode() where id = v_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.fill_missing_barcodes() from public, anon, authenticated;
grant execute on function public.fill_missing_barcodes() to service_role;

notify pgrst, 'reload schema';
