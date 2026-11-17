-- Cash shifts and expenses: what should be in the drawer, and what was counted.

-- Refund cash leaves a drawer: the bill's own shift if still open, otherwise the shift of whoever gave the refund.
create function public.set_refund_shift() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.shift_id is null then
    select sh.id into new.shift_id from public.sales s join public.shifts sh on sh.id = s.shift_id
    where s.id = new.sale_id and sh.status = 'Open';
    if new.shift_id is null then
      select id into new.shift_id from public.shifts where cashier_id = new.created_by and status = 'Open';
    end if;
  end if;
  return new;
end;
$$;
create trigger refunds_set_shift before insert on public.refunds for each row execute function public.set_refund_shift();

create function public.shift_figures(p_shift uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  with paid as (
    select p.method_code, p.amount, m.is_cash
    from public.payments p
    join public.sales s on s.id = p.sale_id
    join public.payment_methods m on m.code = p.method_code
    where s.shift_id = p_shift and s.status <> 'Voided'
  ), returned as (
    select r.total, m.is_cash
    from public.refunds r
    join public.payment_methods m on m.code = r.method_code
    where r.shift_id = p_shift
  ), spent as (
    select amount, paid_from_cash from public.expenses where shift_id = p_shift
  ), figures as (
    select
      coalesce((select sum(amount) from paid where is_cash), 0) as cash_sales,
      coalesce((select sum(total) from returned where is_cash), 0) as cash_refunds,
      coalesce((select sum(amount) from spent where paid_from_cash), 0) as cash_expenses
  )
  select jsonb_build_object(
    'bills', (select count(*) from public.sales where shift_id = p_shift and status <> 'Voided'),
    'sales', coalesce((select sum(amount) from paid), 0),
    'byMethod', (select coalesce(jsonb_object_agg(method_code, total), '{}'::jsonb) from (select method_code, sum(amount) as total from paid group by method_code) m),
    'refunds', coalesce((select sum(total) from returned), 0),
    'expenses', coalesce((select sum(amount) from spent), 0),
    'cashSales', cash_sales,
    'cashRefunds', cash_refunds,
    'cashExpenses', cash_expenses,
    'expectedCash', (select opening_cash from public.shifts where id = p_shift) + cash_sales - cash_refunds - cash_expenses
  )
  from figures;
$$;

create function public.open_shift(p_counter uuid, p_opening numeric, p_user uuid) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_opening is null or p_opening < 0 or p_opening <> round(p_opening, 2) then
    raise exception 'Enter the opening cash.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.counters where id = p_counter and active) then
    raise exception 'Choose a counter.' using errcode = 'P0001';
  end if;
  insert into public.shifts (shift_no, counter_id, cashier_id, opening_cash)
  values (public.next_document_number('SH-'), p_counter, p_user, p_opening)
  returning id into v_id;
  return v_id;
end;
$$;

-- Expected cash is fixed at this moment, so later changes can't rewrite a closed shift.
create function public.close_shift(p_shift uuid, p_counted numeric, p_user uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_shift public.shifts%rowtype;
  v_expected numeric;
begin
  select * into v_shift from public.shifts where id = p_shift for update;
  if not found then raise exception 'NOT_FOUND:Shift not found.' using errcode = 'P0001'; end if;
  if v_shift.status <> 'Open' then raise exception 'CONFLICT:This shift is already closed.' using errcode = 'P0001'; end if;
  if p_counted is null or p_counted < 0 or p_counted <> round(p_counted, 2) then
    raise exception 'Enter the cash counted.' using errcode = 'P0001';
  end if;
  v_expected := (public.shift_figures(p_shift) ->> 'expectedCash')::numeric;
  update public.shifts
  set status = 'Closed', expected_cash = v_expected, counted_cash = p_counted, closed_at = now(), closed_by = p_user
  where id = p_shift;
  return jsonb_build_object('shiftNo', v_shift.shift_no, 'expected', v_expected, 'counted', p_counted, 'variance', p_counted - v_expected);
end;
$$;

create function public.add_expense(p_expense jsonb, p_user uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_shift uuid := nullif(p_expense ->> 'shiftId', '')::uuid;
  v_amount numeric := (p_expense ->> 'amount')::numeric;
  v_cash boolean := coalesce((p_expense ->> 'paidFromCash')::boolean, true);
  v_no text;
begin
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
    raise exception 'Enter a valid amount.' using errcode = 'P0001';
  end if;
  if v_shift is not null then
    perform 1 from public.shifts where id = v_shift and status = 'Open' for update;
    if not found then raise exception 'CONFLICT:That shift is not open.' using errcode = 'P0001'; end if;
  elsif v_cash then
    raise exception 'CONFLICT:Cash expenses need an open shift. Open a shift, or record it as not paid from the drawer.' using errcode = 'P0001';
  end if;
  v_no := public.next_document_number('EXP-');
  insert into public.expenses (expense_no, category, description, amount, paid_from_cash, shift_id, created_by)
  values (v_no, p_expense ->> 'category', trim(p_expense ->> 'description'), v_amount, v_cash, v_shift, p_user);
  return jsonb_build_object('expenseNo', v_no);
end;
$$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'set_refund_shift()',
    'shift_figures(uuid)',
    'open_shift(uuid, numeric, uuid)',
    'close_shift(uuid, numeric, uuid)',
    'add_expense(jsonb, uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_function);
    if v_function <> 'set_refund_shift()' then
      execute format('grant execute on function public.%s to service_role', v_function);
    end if;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
