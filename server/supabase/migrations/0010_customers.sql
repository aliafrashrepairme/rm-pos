-- Customer profiles and figures from real bills. Two active customers can't share a phone number.

create unique index customers_active_phone_key on public.customers (phone) where active and phone <> '';

-- Points earn discounts, so setting opening points is limited to Managers.
insert into public.permissions (code, description) values ('customers.points', 'Set opening loyalty points');
insert into public.role_permissions (role_code, permission_code) values ('Manager', 'customers.points');

create function public.add_customer(p_customer jsonb) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  insert into public.customers (code, name, phone, email, address, loyalty_points)
  values (
    public.next_document_number('CUS-'),
    trim(p_customer ->> 'name'),
    coalesce(trim(p_customer ->> 'phone'), ''),
    coalesce(trim(p_customer ->> 'email'), ''),
    coalesce(trim(p_customer ->> 'address'), ''),
    coalesce((p_customer ->> 'loyaltyPoints')::integer, 0)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Voided bills count for nothing. Spent is net of refunds.
create function public.customer_stats(p_customer uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with bills as (
    select id, grand_total, created_at from public.sales where customer_id = p_customer and status <> 'Voided'
  ), returned as (
    select coalesce(sum(r.total), 0) as total from public.refunds r join bills b on b.id = r.sale_id
  )
  select jsonb_build_object(
    'bills', (select count(*) from bills),
    'purchased', coalesce((select sum(grand_total) from bills), 0),
    'refunded', (select total from returned),
    'spent', coalesce((select sum(grand_total) from bills), 0) - (select total from returned),
    'lastPurchaseAt', (select max(created_at) from bills)
  );
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array['add_customer(jsonb)', 'customer_stats(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
