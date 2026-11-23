-- Offline drafts: a quotation saved while offline is sent when the connection returns, and may be sent
-- again if the reply was lost. Like sales (sales.client_request_id), each send carries the device's own
-- request ID, so the second send returns the first quotation instead of creating a copy.

alter table public.quotations add column client_request_id uuid;
create unique index quotations_client_request_id_key on public.quotations (client_request_id)
  where client_request_id is not null;

create function public.save_quotation_once(p_quote jsonb, p_user uuid, p_request uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_request is null then
    raise exception 'A request ID is required.' using errcode = 'P0001';
  end if;
  -- Two sends of the same request wait for each other here, so only one creates the quotation.
  perform pg_advisory_xact_lock(hashtextextended(p_request::text, 0));
  select id into v_id from public.quotations where client_request_id = p_request;
  if found then
    return jsonb_build_object('id', v_id, 'replayed', true);
  end if;
  v_id := public.save_quotation(p_quote - 'id', p_user);
  update public.quotations set client_request_id = p_request where id = v_id;
  return jsonb_build_object('id', v_id, 'replayed', false);
end;
$$;

revoke all on function public.save_quotation_once(jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_quotation_once(jsonb, uuid, uuid) to service_role;

notify pgrst, 'reload schema';
