-- Receipt options are merged inside one update, so two quick saves can't overwrite each other.
create function public.save_store_settings(p_store jsonb, p_receipt jsonb, p_user uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  if p_store = '{}'::jsonb and p_receipt = '{}'::jsonb then
    raise exception 'CONFLICT:Nothing to change.' using errcode = 'P0001';
  end if;
  update public.store_settings
  set store_name = coalesce(p_store->>'store_name', store_name),
      address = coalesce(p_store->>'address', address),
      phone = coalesce(p_store->>'phone', phone),
      vat_registration = coalesce(p_store->>'vat_registration', vat_registration),
      receipt = receipt || p_receipt,
      updated_by = p_user
  where id;
end;
$$;

revoke all on function public.save_store_settings(jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_store_settings(jsonb, jsonb, uuid) to service_role;

notify pgrst, 'reload schema';
