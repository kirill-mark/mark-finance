-- Серверные функции: доступ, идемпотентность, атомарные финансовые операции, журнал.
-- Ошибки: message — понятный текст, detail — машинный код, hint — HTTP-статус.

create or replace function cfo_raise(p_code text, p_message text, p_http int default 422) returns void
language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = p_message, detail = p_code, hint = p_http::text;
end $$;

create or replace function cfo_is_member(p_space uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from cfo_memberships m where m.space_id = p_space and m.user_id = auth.uid())
$$;

create or replace function cfo_assert_member(p_space uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then perform cfo_raise('UNAUTHENTICATED', 'Нужно войти', 401); end if;
  if p_space is null or not cfo_is_member(p_space) then perform cfo_raise('FORBIDDEN', 'Нет доступа', 404); end if;
end $$;

-- Блокировка пространства: финансовые записи одного пространства проводятся последовательно (T17)
create or replace function cfo_lock_space(p_space uuid) returns cfo_spaces
language plpgsql security definer set search_path = public as $$
declare s cfo_spaces;
begin
  perform cfo_assert_member(p_space);
  select * into s from cfo_spaces where id = p_space for update;
  return s;
end $$;

create or replace function cfo_mul_div_half_up(a bigint, n bigint, d bigint) returns bigint
language sql immutable as $$
  select (sign(a::numeric) * sign(n::numeric) * sign(d::numeric))::bigint
       * div(abs(a::numeric * n) * 2 + abs(d::numeric), 2 * abs(d::numeric))::bigint
$$;

-- Идемпотентность: повтор ключа с тем же телом возвращает прежний результат, с другим — конфликт (T18)
create or replace function cfo_idem_begin(p_space uuid, p_key text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r cfo_idempotency; h text := md5((p_payload - 'idempotency_key')::text);
begin
  if p_key is null or length(p_key) < 8 then perform cfo_raise('IDEMPOTENCY_KEY_REQUIRED', 'Нужен ключ идемпотентности', 400); end if;
  select * into r from cfo_idempotency where space_id = p_space and key = p_key;
  if found then
    if r.request_hash <> h then perform cfo_raise('IDEMPOTENCY_CONFLICT', 'Этот ключ уже использован для другого запроса', 409); end if;
    return coalesce(r.result, '{}'::jsonb) || jsonb_build_object('replayed', true);
  end if;
  insert into cfo_idempotency (space_id, key, request_hash) values (p_space, p_key, h);
  return null;
end $$;

create or replace function cfo_idem_end(p_space uuid, p_key text, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update cfo_idempotency set result = p_result where space_id = p_space and key = p_key;
  return p_result;
end $$;

-- Денежный остаток пространства (F02): начальный остаток + движения с точки открытия
create or replace function cfo_space_cash(p_space uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(a.opening_balance), 0) + coalesce((
    select sum(e.amount) from cfo_account_entries e join cfo_accounts a2 on a2.id = e.account_id
    where e.space_id = p_space and e.effective_on >= a2.opening_date), 0)
  from cfo_accounts a where a.space_id = p_space
$$;

create or replace function cfo_account_balance(p_account uuid, p_upto date default null) returns bigint
language sql stable security definer set search_path = public as $$
  select a.opening_balance + coalesce((
    select sum(e.amount) from cfo_account_entries e
    where e.account_id = a.id and e.effective_on >= a.opening_date and (p_upto is null or e.effective_on <= p_upto)), 0)
  from cfo_accounts a where a.id = p_account
$$;

create or replace function cfo_reserve_balance(p_reserve uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when kind = 'ALLOCATE' then amount else -amount end), 0)
  from cfo_reserve_events where reserve_id = p_reserve
$$;

create or replace function cfo_space_reserved(p_space uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when kind = 'ALLOCATE' then amount else -amount end), 0)
  from cfo_reserve_events where space_id = p_space
$$;

-- Списание связанных резервов при оплате плана: порядок — дата создания резерва, затем id (F08)
create or replace function cfo__consume_reserves(p_space uuid, p_plan uuid, p_amount bigint, p_date date, p_settlement uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record; bal bigint; take bigint; left_amt bigint := p_amount;
begin
  for r in select id from cfo_reserves where plan_id = p_plan and kind = 'PAYMENT_LINKED' and not closed order by created_at, id loop
    exit when left_amt <= 0;
    bal := cfo_reserve_balance(r.id);
    take := least(bal, left_amt);
    if take > 0 then
      insert into cfo_reserve_events (space_id, reserve_id, kind, amount, date, settlement_id, note)
      values (p_space, r.id, 'CONSUME', take, p_date, p_settlement, 'Оплата связанного платежа');
      left_amt := left_amt - take;
    end if;
  end loop;
end $$;

-- Проведение операции. Вызывается под блокировкой пространства.
create or replace function cfo__post(p_space uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tx uuid := coalesce((p->>'id')::uuid, gen_random_uuid());
  v_kind text := p->>'kind';
  v_date date := (p->>'occurred_on')::date;
  v_effect text := coalesce(p->>'effect', 'NONE');
  v_net bigint := 0; v_count int := 0; v_settled bigint := 0;
  e record; st record; a cfo_accounts; pl cfo_payment_plans;
  v_paid bigint; v_paid_mgmt bigint; v_total_mgmt bigint; v_mgmt bigint; v_st uuid;
begin
  if v_date is null then perform cfo_raise('DATE_REQUIRED', 'Укажи дату операции', 400); end if;
  if v_effect not in ('PROJECT_COST', 'OVERHEAD_COST', 'SALES', 'FINANCING', 'REIMBURSEMENT', 'PROFIT_DISTRIBUTION', 'PERSONAL_CONSUMPTION', 'PERSONAL_INCOME', 'TAX', 'INTERNAL_TRANSFER', 'NONE') then
    perform cfo_raise('BAD_EFFECT', 'Неизвестный экономический смысл операции', 400);
  end if;
  insert into cfo_transactions (id, space_id, kind, description, source, occurred_on, counterparty_id, project_id, category, effect,
    correction_of, loan_id, external_id, external_account_id, import_batch_id, is_storno)
  values (v_tx, p_space, v_kind, coalesce(p->>'description', ''), coalesce(p->>'source', 'MANUAL'), v_date,
    nullif(p->>'counterparty_id', '')::uuid, nullif(p->>'project_id', '')::uuid, nullif(p->>'category', ''), v_effect,
    nullif(p->>'correction_of', '')::uuid, nullif(p->>'loan_id', '')::uuid, nullif(p->>'external_id', ''),
    nullif(p->>'external_account_id', '')::uuid, nullif(p->>'import_batch_id', '')::uuid, coalesce((p->>'is_storno')::boolean, false));

  for e in select * from jsonb_to_recordset(coalesce(p->'entries', '[]'::jsonb)) as x(account_id uuid, amount bigint) loop
    select * into a from cfo_accounts where id = e.account_id and space_id = p_space;
    if not found then perform cfo_raise('ACCOUNT_NOT_IN_SPACE', 'Счёт не найден в этом пространстве', 422); end if;
    if a.archived then perform cfo_raise('ACCOUNT_ARCHIVED', 'Счёт в архиве', 422); end if;
    if v_date < a.opening_date then
      perform cfo_raise('BEFORE_OPENING', format('Операция %s раньше точки открытия счёта «%s» (%s). Сначала измени точку открытия — иначе остаток удвоится.', v_date, a.name, a.opening_date), 422);
    end if;
    if e.amount is null or e.amount = 0 then perform cfo_raise('ZERO_AMOUNT', 'Сумма движения не может быть нулевой', 400); end if;
    insert into cfo_account_entries (space_id, transaction_id, account_id, amount, effective_on) values (p_space, v_tx, e.account_id, e.amount, v_date);
    v_net := v_net + e.amount;
    v_count := v_count + 1;
  end loop;
  if v_count = 0 and v_kind <> 'PAID_BY_PARTNER' then perform cfo_raise('NO_ENTRIES', 'У операции нет движений по счетам', 400); end if;
  if v_kind = 'TRANSFER' and (v_net <> 0 or v_count < 2) then perform cfo_raise('TRANSFER_UNBALANCED', 'Перевод — это равные противоположные движения', 422); end if;
  if v_kind = 'PAID_BY_PARTNER' then v_net := -coalesce((p->>'external_amount')::bigint, 0); end if;

  for st in select * from jsonb_to_recordset(coalesce(p->'settlements', '[]'::jsonb)) as x(plan_id uuid, amount bigint) loop
    select * into pl from cfo_payment_plans where id = st.plan_id and space_id = p_space for update;
    if not found then perform cfo_raise('PLAN_NOT_IN_SPACE', 'План не найден в этом пространстве', 422); end if;
    if pl.cancelled_at is not null then perform cfo_raise('PLAN_CANCELLED', 'План отменён', 422); end if;
    if st.amount is null or st.amount <= 0 then perform cfo_raise('BAD_AMOUNT', 'Сумма погашения должна быть больше нуля', 400); end if;
    if (pl.direction = 'IN' and v_net <= 0) or (pl.direction = 'OUT' and v_net >= 0) then
      perform cfo_raise('DIRECTION_MISMATCH', 'Направление денег не совпадает с планом', 422);
    end if;
    select coalesce(sum(amount), 0), coalesce(sum(mgmt_amount), 0) into v_paid, v_paid_mgmt from cfo_settlements where plan_id = pl.id and status = 'ACTIVE';
    if v_paid + st.amount > pl.amount then
      perform cfo_raise('OVERPAY_PLAN', format('Погашения превысят план на %s коп. Переплату оформи как аванс или отдельный план.', v_paid + st.amount - pl.amount), 422);
    end if;
    v_total_mgmt := coalesce(pl.mgmt_amount, pl.amount);
    if v_paid + st.amount = pl.amount then v_mgmt := v_total_mgmt - v_paid_mgmt;  -- последнему погашению — остаток округления
    else v_mgmt := cfo_mul_div_half_up(v_total_mgmt, st.amount, pl.amount); end if;
    insert into cfo_settlements (space_id, transaction_id, plan_id, amount, mgmt_amount) values (p_space, v_tx, pl.id, st.amount, v_mgmt) returning id into v_st;
    v_settled := v_settled + st.amount;
    if pl.direction = 'OUT' and pl.effect in ('PROJECT_COST', 'OVERHEAD_COST') then
      insert into cfo_cost_records (space_id, budget_line_id, project_id, amount, mgmt_amount, paid_by_counterparty_id, transaction_id, plan_id, settlement_id, occurred_on)
      values (p_space, pl.budget_line_id, pl.project_id, st.amount, v_mgmt, nullif(p->>'paid_by_counterparty_id', '')::uuid, v_tx, pl.id, v_st, v_date);
    end if;
    if pl.direction = 'OUT' then perform cfo__consume_reserves(p_space, pl.id, st.amount, v_date, v_st); end if;
  end loop;
  if v_settled > abs(v_net) then perform cfo_raise('SETTLEMENT_EXCEEDS_FACT', 'Сумма привязок больше фактического платежа', 422); end if;

  -- Прямая затрата без плана признаётся один раз
  if v_settled = 0 and v_net < 0 and v_effect in ('PROJECT_COST', 'OVERHEAD_COST') then
    insert into cfo_cost_records (space_id, budget_line_id, project_id, amount, mgmt_amount, paid_by_counterparty_id, transaction_id, occurred_on)
    values (p_space, nullif(p->>'budget_line_id', '')::uuid, nullif(p->>'project_id', '')::uuid, -v_net,
      coalesce((p->>'mgmt_amount')::bigint, -v_net), nullif(p->>'paid_by_counterparty_id', '')::uuid, v_tx, v_date);
  end if;
  return v_tx;
end $$;

-- POST /transactions — проведение операции
create or replace function cfo_post_transaction(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_space uuid := (p->>'space_id')::uuid; r jsonb; v_tx uuid;
begin
  perform cfo_lock_space(v_space);
  r := cfo_idem_begin(v_space, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  if p->>'kind' is null then perform cfo_raise('KIND_REQUIRED', 'Укажи тип операции', 400); end if;
  v_tx := cfo__post(v_space, p);
  return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('transaction_id', v_tx));
end $$;

-- POST /transactions/:id/corrections — сторно и новая версия в одной транзакции (F14, T20)
create or replace function cfo_correct_transaction(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_space uuid := (p->>'space_id')::uuid; r jsonb; t cfo_transactions; v_storno uuid := gen_random_uuid(); v_new uuid;
  ev record;
begin
  perform cfo_lock_space(v_space);
  r := cfo_idem_begin(v_space, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  select * into t from cfo_transactions where id = (p->>'transaction_id')::uuid and space_id = v_space for update;
  if not found then perform cfo_raise('NOT_FOUND', 'Операция не найдена', 404); end if;
  if t.status = 'REVERSED' then perform cfo_raise('ALREADY_REVERSED', 'Операция уже исправлена — исправляй её новую версию', 409); end if;
  if t.is_storno then perform cfo_raise('STORNO_IMMUTABLE', 'Сторно не исправляется', 422); end if;
  if coalesce(p->>'reason', '') = '' then perform cfo_raise('REASON_REQUIRED', 'Укажи причину исправления', 400); end if;

  update cfo_transactions set status = 'REVERSED' where id = t.id;
  insert into cfo_transactions (id, space_id, kind, description, source, occurred_on, counterparty_id, project_id, category, effect, correction_of, loan_id, is_storno)
  values (v_storno, v_space, t.kind, 'Сторно: ' || t.description || ' — ' || (p->>'reason'), 'MANUAL', t.occurred_on, t.counterparty_id, t.project_id, t.category, t.effect, t.id, t.loan_id, true);
  insert into cfo_account_entries (space_id, transaction_id, account_id, amount, effective_on)
  select v_space, v_storno, account_id, -amount, effective_on from cfo_account_entries where transaction_id = t.id;
  -- Связанные погашения, затраты и резервы корректируются вместе с фактом
  for ev in select re.reserve_id, re.amount from cfo_reserve_events re join cfo_settlements s on s.id = re.settlement_id
            where s.transaction_id = t.id and re.kind = 'CONSUME' loop
    insert into cfo_reserve_events (space_id, reserve_id, kind, amount, date, note) values (v_space, ev.reserve_id, 'ALLOCATE', ev.amount, t.occurred_on, 'Восстановлено при исправлении операции');
  end loop;
  update cfo_settlements set status = 'VOID' where transaction_id = t.id;
  update cfo_cost_records set status = 'VOID' where transaction_id = t.id;

  if p ? 'replacement' and jsonb_typeof(p->'replacement') = 'object' then
    v_new := cfo__post(v_space, (p->'replacement') || jsonb_build_object('correction_of', t.id));
  end if;
  return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('storno_id', v_storno, 'transaction_id', v_new));
end $$;

-- POST /transfers — атомарный перевод между счетами одного пространства; комиссия — отдельный расход
create or replace function cfo_transfer(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_space uuid := (p->>'space_id')::uuid; r jsonb; v_tx uuid; v_fee uuid; v_amt bigint := (p->>'amount')::bigint; v_fee_amt bigint := coalesce((p->>'fee')::bigint, 0);
begin
  perform cfo_lock_space(v_space);
  r := cfo_idem_begin(v_space, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  if v_amt is null or v_amt <= 0 then perform cfo_raise('BAD_AMOUNT', 'Сумма перевода должна быть больше нуля', 400); end if;
  if p->>'from_account_id' = p->>'to_account_id' then perform cfo_raise('SAME_ACCOUNT', 'Выбери разные счета', 400); end if;
  v_tx := cfo__post(v_space, jsonb_build_object('kind', 'TRANSFER', 'effect', 'INTERNAL_TRANSFER', 'occurred_on', p->>'occurred_on',
    'description', coalesce(p->>'description', 'Перевод между счетами'), 'source', coalesce(p->>'source', 'MANUAL'),
    'entries', jsonb_build_array(jsonb_build_object('account_id', p->>'from_account_id', 'amount', -v_amt), jsonb_build_object('account_id', p->>'to_account_id', 'amount', v_amt))));
  if v_fee_amt > 0 then
    v_fee := cfo__post(v_space, jsonb_build_object('kind', 'EXPENSE', 'effect', 'OVERHEAD_COST', 'occurred_on', p->>'occurred_on', 'description', 'Комиссия за перевод',
      'category', 'Банковские комиссии', 'entries', jsonb_build_array(jsonb_build_object('account_id', p->>'from_account_id', 'amount', -v_fee_amt))));
  end if;
  return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('transaction_id', v_tx, 'fee_transaction_id', v_fee));
end $$;

-- Резервы: выделение не может превысить незарезервированные деньги (F06, T17)
create or replace function cfo_reserve_change(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_space uuid := (p->>'space_id')::uuid; r jsonb; v_res uuid := nullif(p->>'reserve_id', '')::uuid;
  v_amt bigint := (p->>'amount')::bigint; v_action text := p->>'action'; v_free bigint; v_bal bigint;
begin
  perform cfo_lock_space(v_space);
  r := cfo_idem_begin(v_space, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  if v_amt is null or v_amt <= 0 then perform cfo_raise('BAD_AMOUNT', 'Сумма должна быть больше нуля', 400); end if;
  if v_res is null then
    if p->'new_reserve' is null then perform cfo_raise('RESERVE_REQUIRED', 'Выбери резерв', 400); end if;
    insert into cfo_reserves (space_id, purpose, kind, plan_id, goal_id)
    values (v_space, p->'new_reserve'->>'purpose', p->'new_reserve'->>'kind', nullif(p->'new_reserve'->>'plan_id', '')::uuid, nullif(p->'new_reserve'->>'goal_id', '')::uuid)
    returning id into v_res;
  elsif not exists (select 1 from cfo_reserves where id = v_res and space_id = v_space) then
    perform cfo_raise('NOT_FOUND', 'Резерв не найден', 404);
  end if;
  if v_action = 'ALLOCATE' then
    v_free := cfo_space_cash(v_space) - cfo_space_reserved(v_space);
    if v_amt > v_free then
      perform cfo_raise('RESERVE_EXCEEDS_FREE', format('Незарезервировано только %s коп. — нельзя защитить больше, чем есть. Можно сохранить необеспеченную цель.', greatest(v_free, 0)), 409);
    end if;
  elsif v_action in ('RELEASE', 'CONSUME') then
    v_bal := cfo_reserve_balance(v_res);
    if v_amt > v_bal then perform cfo_raise('RESERVE_BALANCE', 'В резерве меньше этой суммы', 422); end if;
  else
    perform cfo_raise('BAD_ACTION', 'Неизвестное действие с резервом', 400);
  end if;
  insert into cfo_reserve_events (space_id, reserve_id, kind, amount, date, note)
  values (v_space, v_res, v_action, v_amt, coalesce((p->>'date')::date, current_date), coalesce(p->>'note', ''));
  return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('reserve_id', v_res, 'balance', cfo_reserve_balance(v_res)::text));
end $$;

-- S03: договорённость с подрядчиком — одна статья затрат и несколько плановых платежей;
-- оценка заменяется договорённостью, а не прибавляется (F04, T11)
create or replace function cfo_agree_cost(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_space uuid := (p->>'space_id')::uuid; r jsonb; v_line uuid := nullif(p->>'budget_line_id', '')::uuid;
  v_total bigint := (p->>'total')::bigint; v_sum bigint; part record; v_ids uuid[] := '{}'; v_id uuid; v_repl uuid;
  v_project uuid := nullif(p->>'project_id', '')::uuid;
begin
  perform cfo_lock_space(v_space);
  r := cfo_idem_begin(v_space, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  select coalesce(sum((x->>'amount')::bigint), 0) into v_sum from jsonb_array_elements(p->'parts') x;
  if v_total is null or v_total <= 0 or v_sum <> v_total then perform cfo_raise('PARTS_MISMATCH', 'Сумма частей должна равняться договорённости', 422); end if;
  if v_line is null and p ? 'new_line' then
    insert into cfo_budget_lines (space_id, project_id, category, stage, original_amount, original_mgmt)
    values (v_space, v_project, p->'new_line'->>'category', coalesce(p->'new_line'->>'stage', 'OTHER'),
      coalesce((p->'new_line'->>'original_amount')::bigint, v_total), coalesce((p->'new_line'->>'original_amount')::bigint, v_total))
    returning id into v_line;
  end if;
  for v_repl in select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p->'replace_plan_ids', '[]'::jsonb)) x loop
    update cfo_payment_plans set cancelled_at = current_date, cancel_reason = 'Оценка заменена договорённостью'
    where id = v_repl and space_id = v_space and certainty = 'ESTIMATE' and cancelled_at is null
      and not exists (select 1 from cfo_settlements s where s.plan_id = v_repl and s.status = 'ACTIVE');
    if not found then perform cfo_raise('ESTIMATE_NOT_REPLACEABLE', 'Заменить можно только неоплаченную оценку этого пространства', 422); end if;
  end loop;
  for part in select * from jsonb_to_recordset(p->'parts') as x(amount bigint, date date) loop
    if part.amount <= 0 or part.date is null then perform cfo_raise('BAD_PART', 'У каждой части нужна сумма и дата', 400); end if;
    insert into cfo_payment_plans (space_id, direction, amount, due_date, counterparty_id, certainty, effect, title, basis, project_id, budget_line_id)
    values (v_space, 'OUT', part.amount, part.date, nullif(p->>'counterparty_id', '')::uuid, 'CONTRACTED', coalesce(p->>'effect', 'PROJECT_COST'),
      coalesce(p->>'title', 'Договорённость'), coalesce(p->>'basis', ''), v_project, v_line)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('budget_line_id', v_line, 'plan_ids', to_jsonb(v_ids)));
end $$;

-- Операции между личным и бизнес-пространством — только когда у пользователя доступ к обоим
create or replace function cfo__lock_pair(a uuid, b uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if a = b then perform cfo_raise('SAME_SPACE', 'Нужны два разных пространства', 400); end if;
  -- фиксированный порядок блокировок исключает взаимоблокировку
  perform cfo_lock_space(least(a, b));
  perform cfo_lock_space(greatest(a, b));
end $$;

-- S04: оплатил за компанию личными деньгами (T05)
create or replace function cfo_paid_for_company(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := (p->>'personal_space_id')::uuid; v_biz uuid := (p->>'business_space_id')::uuid; r jsonb;
  v_amt bigint := (p->>'amount')::bigint; v_date date := (p->>'occurred_on')::date;
  v_self uuid; v_ptx uuid; v_btx uuid; v_claim uuid; v_bplan uuid; v_pplan uuid; v_cost uuid;
begin
  perform cfo__lock_pair(v_me, v_biz);
  if (select type from cfo_spaces where id = v_me) <> 'PERSONAL' or (select type from cfo_spaces where id = v_biz) <> 'BUSINESS' then
    perform cfo_raise('BAD_SPACES', 'Нужны личное и бизнес-пространство', 400);
  end if;
  r := cfo_idem_begin(v_biz, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  if v_amt is null or v_amt <= 0 then perform cfo_raise('BAD_AMOUNT', 'Сумма должна быть больше нуля', 400); end if;
  select id into v_self from cfo_counterparties where space_id = v_biz and is_self limit 1;
  if v_self is null then perform cfo_raise('NO_SELF', 'В продакшне нет карточки «Я» среди партнёров', 422); end if;

  -- Личные деньги уменьшаются, но это возмещаемый аванс, а не личная трата
  v_ptx := cfo__post(v_me, jsonb_build_object('kind', 'CROSS_SPACE', 'effect', 'FINANCING', 'occurred_on', v_date,
    'description', 'За компанию: ' || coalesce(p->>'description', ''),
    'entries', jsonb_build_array(jsonb_build_object('account_id', p->>'personal_account_id', 'amount', -v_amt))));
  -- В компании затрата признаётся один раз; денежного движения компании нет
  v_btx := cfo__post(v_biz, jsonb_build_object('kind', 'PAID_BY_PARTNER', 'effect', 'PROJECT_COST', 'occurred_on', v_date,
    'description', coalesce(p->>'description', '') || ' — оплачено личными деньгами', 'project_id', p->>'project_id',
    'budget_line_id', p->>'budget_line_id', 'paid_by_counterparty_id', v_self, 'external_amount', v_amt,
    'settlements', case when p->>'plan_id' is not null then jsonb_build_array(jsonb_build_object('plan_id', p->>'plan_id', 'amount', v_amt)) else '[]'::jsonb end));
  -- Затрата создана один раз внутри cfo__post (по плану или напрямую)
  select id into v_cost from cfo_cost_records where transaction_id = v_btx limit 1;
  insert into cfo_partner_claims (space_id, counterparty_id, direction, basis, amount, approved, note, cost_record_id)
  values (v_biz, v_self, 'COMPANY_OWES', 'REIMBURSEMENT', v_amt, true, coalesce(p->>'description', ''), v_cost) returning id into v_claim;
  if p->>'reimburse_on' is not null then
    insert into cfo_payment_plans (space_id, direction, amount, due_date, counterparty_id, effect, title, partner_claim_id, project_id)
    values (v_biz, 'OUT', v_amt, (p->>'reimburse_on')::date, v_self, 'REIMBURSEMENT', 'Возмещение: ' || coalesce(p->>'description', ''), v_claim, nullif(p->>'project_id', '')::uuid)
    returning id into v_bplan;
    insert into cfo_payment_plans (space_id, direction, amount, due_date, effect, title, linked_plan_id)
    values (v_me, 'IN', v_amt, (p->>'reimburse_on')::date, 'REIMBURSEMENT', 'Возмещение от компании: ' || coalesce(p->>'description', ''), v_bplan)
    returning id into v_pplan;
    update cfo_payment_plans set linked_plan_id = v_pplan where id = v_bplan;
  end if;
  return cfo_idem_end(v_biz, p->>'idempotency_key', jsonb_build_object('personal_transaction_id', v_ptx, 'business_transaction_id', v_btx,
    'claim_id', v_claim, 'business_plan_id', v_bplan, 'personal_plan_id', v_pplan, 'cost_record_id', v_cost));
end $$;

-- S02: выплата себе из компании — проверка утверждённого основания на сервере (T13)
create or replace function cfo_owner_payout(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := (p->>'personal_space_id')::uuid; v_biz uuid := (p->>'business_space_id')::uuid; r jsonb;
  v_amt bigint := (p->>'amount')::bigint; v_date date := (p->>'occurred_on')::date; v_basis text := p->>'basis';
  v_self uuid; v_left bigint; v_claim cfo_partner_claims; v_plan uuid := nullif(p->>'plan_id', '')::uuid; v_rem bigint;
  v_btx uuid; v_ptx uuid; v_pplan uuid; v_effect text;
begin
  perform cfo__lock_pair(v_me, v_biz);
  r := cfo_idem_begin(v_biz, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  if v_basis not in ('FEE', 'REIMBURSEMENT', 'LOAN', 'DISTRIBUTION') then
    perform cfo_raise('BASIS_REQUIRED', 'Выбери основание: оплата работы, возмещение, возврат займа или распределение прибыли', 422);
  end if;
  select id into v_self from cfo_counterparties where space_id = v_biz and is_self limit 1;
  select * into v_claim from cfo_partner_claims where id = (p->>'claim_id')::uuid and space_id = v_biz and counterparty_id = v_self
    and direction = 'COMPANY_OWES' and basis = v_basis and approved and not cancelled for update;
  if not found then perform cfo_raise('NO_APPROVED_BASIS', 'Нет утверждённого основания этого типа — сумму нельзя назвать причитающейся', 422); end if;
  select v_claim.amount - coalesce(sum(s.amount), 0) into v_left from cfo_settlements s join cfo_payment_plans pl on pl.id = s.plan_id
    where pl.partner_claim_id = v_claim.id and s.status = 'ACTIVE';
  if v_amt is null or v_amt <= 0 or v_amt > v_left then
    perform cfo_raise('BASIS_LIMIT', format('По основанию осталось %s коп.', v_left), 422);
  end if;
  v_effect := case v_basis when 'FEE' then 'OVERHEAD_COST' when 'REIMBURSEMENT' then 'REIMBURSEMENT' when 'LOAN' then 'FINANCING' else 'PROFIT_DISTRIBUTION' end;
  if v_plan is null then
    insert into cfo_payment_plans (space_id, direction, amount, due_date, counterparty_id, effect, title, partner_claim_id)
    values (v_biz, 'OUT', v_amt, v_date, v_self, v_effect, coalesce(p->>'description', 'Выплата себе'), v_claim.id) returning id into v_plan;
  elsif not exists (select 1 from cfo_payment_plans where id = v_plan and partner_claim_id = v_claim.id) then
    perform cfo_raise('PLAN_NOT_FOR_CLAIM', 'План не относится к этому основанию', 422);
  end if;
  v_btx := cfo__post(v_biz, jsonb_build_object('kind', 'PARTNER_PAYOUT', 'effect', v_effect, 'occurred_on', v_date, 'counterparty_id', v_self,
    'description', coalesce(p->>'description', 'Выплата себе'),
    'entries', jsonb_build_array(jsonb_build_object('account_id', p->>'business_account_id', 'amount', -v_amt)),
    'settlements', jsonb_build_array(jsonb_build_object('plan_id', v_plan, 'amount', v_amt))));
  if p->>'personal_account_id' is not null then
    select id into v_pplan from cfo_payment_plans where linked_plan_id = v_plan and space_id = v_me and cancelled_at is null limit 1;
    select amount - coalesce((select sum(amount) from cfo_settlements where plan_id = v_pplan and status = 'ACTIVE'), 0) into v_rem from cfo_payment_plans where id = v_pplan;
    v_ptx := cfo__post(v_me, jsonb_build_object('kind', 'INCOME', 'effect', case when v_basis = 'REIMBURSEMENT' then 'REIMBURSEMENT' else 'PERSONAL_INCOME' end,
      'occurred_on', v_date, 'description', coalesce(p->>'description', 'Выплата из продакшна'),
      'entries', jsonb_build_array(jsonb_build_object('account_id', p->>'personal_account_id', 'amount', v_amt)),
      'settlements', case when v_pplan is not null and coalesce(v_rem, 0) > 0 then jsonb_build_array(jsonb_build_object('plan_id', v_pplan, 'amount', least(v_amt, v_rem))) else '[]'::jsonb end));
  end if;
  return cfo_idem_end(v_biz, p->>'idempotency_key', jsonb_build_object('business_transaction_id', v_btx, 'personal_transaction_id', v_ptx, 'plan_id', v_plan));
end $$;

-- Перевод личных денег в компанию: заём компании или вложение в проект (8.2)
create or replace function cfo_owner_contribution(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := (p->>'personal_space_id')::uuid; v_biz uuid := (p->>'business_space_id')::uuid; r jsonb;
  v_amt bigint := (p->>'amount')::bigint; v_date date := (p->>'occurred_on')::date; v_self uuid; v_ptx uuid; v_btx uuid; v_ref uuid;
begin
  perform cfo__lock_pair(v_me, v_biz);
  r := cfo_idem_begin(v_biz, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  if v_amt is null or v_amt <= 0 then perform cfo_raise('BAD_AMOUNT', 'Сумма должна быть больше нуля', 400); end if;
  select id into v_self from cfo_counterparties where space_id = v_biz and is_self limit 1;
  v_ptx := cfo__post(v_me, jsonb_build_object('kind', 'CROSS_SPACE', 'effect', 'FINANCING', 'occurred_on', v_date, 'description', 'В компанию: ' || coalesce(p->>'description', ''),
    'entries', jsonb_build_array(jsonb_build_object('account_id', p->>'personal_account_id', 'amount', -v_amt))));
  v_btx := cfo__post(v_biz, jsonb_build_object('kind', 'OWNER_CONTRIBUTION', 'effect', 'FINANCING', 'occurred_on', v_date, 'counterparty_id', v_self,
    'project_id', p->>'project_id', 'description', coalesce(p->>'description', 'Деньги от Кирилла'),
    'entries', jsonb_build_array(jsonb_build_object('account_id', p->>'business_account_id', 'amount', v_amt))));
  if p->>'as' = 'LOAN' then
    insert into cfo_partner_claims (space_id, counterparty_id, direction, basis, amount, approved, note)
    values (v_biz, v_self, 'COMPANY_OWES', 'LOAN', v_amt, true, coalesce(p->>'description', 'Заём компании')) returning id into v_ref;
  elsif p->>'as' = 'INVESTMENT' and p->>'project_id' is not null then
    insert into cfo_funding_sources (space_id, project_id, kind, name, declared, confirmed, status, is_reallocation)
    values (v_biz, (p->>'project_id')::uuid, 'OWN_FUNDS', 'Личные вложения', v_amt, v_amt, 'CONFIRMED', false) returning id into v_ref;
  end if;
  return cfo_idem_end(v_biz, p->>'idempotency_key', jsonb_build_object('personal_transaction_id', v_ptx, 'business_transaction_id', v_btx, 'ref_id', v_ref));
end $$;

-- Утверждённое распределение: доли 100% методом наибольших остатков или фиксированные суммы (F11)
create or replace function cfo_create_distribution(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_space uuid := (p->>'space_id')::uuid; r jsonb; v_pool uuid; v_amt bigint := (p->>'amount')::bigint;
  v_shares bigint; v_fixed bigint; v_n int; v_left bigint; rec record; v_claims uuid[] := '{}'; v_c uuid;
begin
  perform cfo_lock_space(v_space);
  r := cfo_idem_begin(v_space, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  if v_amt is null or v_amt < 0 then perform cfo_raise('BAD_AMOUNT', 'Сумма пула не может быть отрицательной', 400); end if;
  select count(*), sum((x->>'share_bp')::bigint), sum((x->>'fixed')::bigint) into v_n, v_shares, v_fixed from jsonb_array_elements(p->'recipients') x;
  if v_n = 0 then perform cfo_raise('NO_RECIPIENTS', 'Нет получателей', 400); end if;
  if v_shares is not null and v_fixed is not null then perform cfo_raise('MIXED_RULES', 'Используй либо доли, либо суммы', 400); end if;
  if v_fixed is null and v_shares <> 10000 then perform cfo_raise('SHARES_NOT_100', 'Сумма долей должна быть ровно 100%', 422); end if;
  if v_shares is null and v_fixed <> v_amt then perform cfo_raise('FIXED_NOT_POOL', 'Сумма начислений должна равняться пулу', 422); end if;
  insert into cfo_distribution_pools (space_id, period, project_id, amount, approved_on, recipients)
  values (v_space, coalesce(p->>'period', ''), nullif(p->>'project_id', '')::uuid, v_amt, (p->>'approved_on')::date, p->'recipients') returning id into v_pool;
  create temp table if not exists cfo_tmp_alloc (ord int, cp uuid, base bigint, rem bigint, extra int) on commit drop;
  delete from cfo_tmp_alloc;
  insert into cfo_tmp_alloc
  select ord::int, (x->>'counterparty_id')::uuid,
    case when v_fixed is null then (v_amt * (x->>'share_bp')::bigint) / 10000 else (x->>'fixed')::bigint end,
    case when v_fixed is null then (v_amt * (x->>'share_bp')::bigint) % 10000 else 0 end, 0
  from jsonb_array_elements(p->'recipients') with ordinality as t(x, ord);
  v_left := v_amt - (select sum(base) from cfo_tmp_alloc);
  update cfo_tmp_alloc set extra = 1 where ord in (select ord from cfo_tmp_alloc order by rem desc, ord asc limit v_left);
  for rec in select * from cfo_tmp_alloc order by ord loop
    if rec.base + rec.extra > 0 then
      insert into cfo_partner_claims (space_id, counterparty_id, direction, basis, amount, approved, note, pool_id)
      values (v_space, rec.cp, 'COMPANY_OWES', 'DISTRIBUTION', rec.base + rec.extra, true, 'Распределение ' || coalesce(p->>'period', ''), v_pool)
      returning id into v_c;
      v_claims := v_claims || v_c;
    end if;
  end loop;
  return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('pool_id', v_pool, 'claim_ids', to_jsonb(v_claims)));
end $$;

-- Сверка остатка (F14): корректировка — отдельная подтверждённая операция с причиной
create or replace function cfo_reconcile(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_space uuid := (p->>'space_id')::uuid; r jsonb; a cfo_accounts; v_at date := (p->>'at')::date;
  v_computed bigint; v_entered bigint := (p->>'entered')::bigint; v_diff bigint; v_decision text; v_adj uuid;
begin
  perform cfo_lock_space(v_space);
  r := cfo_idem_begin(v_space, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  select * into a from cfo_accounts where id = (p->>'account_id')::uuid and space_id = v_space for update;
  if not found then perform cfo_raise('NOT_FOUND', 'Счёт не найден', 404); end if;
  if v_at < a.opening_date then perform cfo_raise('BEFORE_OPENING', 'Дата сверки раньше точки открытия счёта', 422); end if;
  v_computed := cfo_account_balance(a.id, v_at);
  v_diff := v_entered - v_computed;
  if v_diff = 0 then v_decision := 'MATCHED';
  elsif coalesce((p->>'adjust')::boolean, false) then
    if coalesce(p->>'reason', '') = '' then perform cfo_raise('REASON_REQUIRED', 'Для корректировки нужна причина', 400); end if;
    v_adj := cfo__post(v_space, jsonb_build_object('kind', 'ADJUSTMENT', 'effect', 'NONE', 'occurred_on', v_at, 'description', 'Корректировка остатка: ' || (p->>'reason'),
      'entries', jsonb_build_array(jsonb_build_object('account_id', a.id, 'amount', v_diff))));
    v_decision := 'ADJUSTED';
  else v_decision := 'PENDING'; end if;
  insert into cfo_reconciliations (space_id, account_id, at, computed, entered, difference, decision, adjustment_tx_id, note)
  values (v_space, a.id, v_at, v_computed, v_entered, v_diff, v_decision, v_adj, coalesce(p->>'reason', ''));
  if v_decision <> 'PENDING' then update cfo_accounts set reconciled_at = greatest(coalesce(reconciled_at, v_at), v_at) where id = a.id; end if;
  return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('computed', v_computed::text, 'difference', v_diff::text, 'decision', v_decision, 'adjustment_transaction_id', v_adj));
end $$;

-- Явный пересчёт точки открытия (T30): только отдельным действием с причиной
create or replace function cfo_change_opening(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_space uuid := (p->>'space_id')::uuid; r jsonb;
begin
  perform cfo_lock_space(v_space);
  r := cfo_idem_begin(v_space, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  if coalesce(p->>'reason', '') = '' then perform cfo_raise('REASON_REQUIRED', 'Укажи причину изменения точки открытия', 400); end if;
  update cfo_accounts set opening_date = (p->>'opening_date')::date, opening_balance = (p->>'opening_balance')::bigint
  where id = (p->>'account_id')::uuid and space_id = v_space and version = (p->>'expected_version')::int;
  if not found then perform cfo_raise('VERSION_CONFLICT', 'Счёт изменился — обнови страницу', 409); end if;
  return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('ok', true));
end $$;

-- Импорт CSV: повтор файла и external_id не дублируются; похожие строки требуют решения (11, T19, T30)
create or replace function cfo_import_commit(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_space uuid := (p->>'space_id')::uuid; r jsonb; v_batch uuid; row_ record; v_tx uuid; v_status text; v_msg text;
  v_imported int := 0; a cfo_accounts; v_pair jsonb; v_counts jsonb := '{}'::jsonb;
begin
  perform cfo_lock_space(v_space);
  r := cfo_idem_begin(v_space, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  select id into v_batch from cfo_import_batches where space_id = v_space and fingerprint = p->>'fingerprint';
  if found then
    return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('batch_id', v_batch, 'duplicate_file', true, 'imported', 0));
  end if;
  insert into cfo_import_batches (space_id, file_name, fingerprint, rows_total) values (v_space, coalesce(p->>'file_name', ''), p->>'fingerprint', jsonb_array_length(p->'rows'))
  returning id into v_batch;
  for row_ in select * from jsonb_to_recordset(p->'rows') as x(row_no int, external_id text, date date, account_id uuid, to_account_id uuid, direction text,
      amount bigint, kind text, effect text, counterparty_id uuid, project_id uuid, category text, description text, decision text, raw jsonb) loop
    v_tx := null; v_msg := '';
    select * into a from cfo_accounts where id = row_.account_id and space_id = v_space;
    if row_.decision = 'SKIP' then v_status := 'SKIPPED';
    elsif not found then v_status := 'ERROR'; v_msg := 'Счёт не найден';
    elsif row_.date < a.opening_date then v_status := 'BLOCKED'; v_msg := 'Раньше точки открытия счёта — нужен пересчёт точки открытия';
    elsif row_.external_id is not null and exists (select 1 from cfo_transactions where external_account_id = a.id and external_id = row_.external_id and not is_storno) then
      v_status := 'DUPLICATE'; v_msg := 'Этот external_id уже импортирован';
    elsif row_.decision = 'REVIEW' then v_status := 'CONFLICT'; v_msg := 'Похожая операция уже есть — нужно решение';
    else
      if row_.kind = 'TRANSFER' then
        v_pair := jsonb_build_array(jsonb_build_object('account_id', a.id, 'amount', -row_.amount), jsonb_build_object('account_id', row_.to_account_id, 'amount', row_.amount));
      else
        v_pair := jsonb_build_array(jsonb_build_object('account_id', a.id, 'amount', case when row_.direction = 'OUT' then -row_.amount else row_.amount end));
      end if;
      v_tx := cfo__post(v_space, jsonb_build_object('kind', coalesce(row_.kind, case when row_.direction = 'OUT' then 'EXPENSE' else 'INCOME' end),
        'effect', coalesce(row_.effect, case when row_.kind = 'TRANSFER' then 'INTERNAL_TRANSFER' else 'NONE' end), 'occurred_on', row_.date,
        'description', coalesce(row_.description, ''), 'counterparty_id', row_.counterparty_id, 'project_id', row_.project_id, 'category', row_.category,
        'source', 'IMPORT', 'external_id', row_.external_id, 'external_account_id', a.id, 'import_batch_id', v_batch, 'entries', v_pair));
      v_status := 'IMPORTED'; v_imported := v_imported + 1;
    end if;
    insert into cfo_import_rows (space_id, batch_id, row_no, raw, status, message, transaction_id) values (v_space, v_batch, row_.row_no, coalesce(row_.raw, '{}'::jsonb), v_status, v_msg, v_tx);
    v_counts := jsonb_set(v_counts, array[v_status], to_jsonb(coalesce((v_counts->>v_status)::int, 0) + 1));
  end loop;
  update cfo_import_batches set rows_imported = v_imported where id = v_batch;
  return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('batch_id', v_batch, 'imported', v_imported, 'counts', v_counts));
end $$;

-- Решение по строке-конфликту импорта: провести или пропустить
create or replace function cfo_import_resolve(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_space uuid := (p->>'space_id')::uuid; r jsonb; row_ cfo_import_rows; v_tx uuid;
begin
  perform cfo_lock_space(v_space);
  r := cfo_idem_begin(v_space, p->>'idempotency_key', p);
  if r is not null then return r; end if;
  select * into row_ from cfo_import_rows where id = (p->>'row_id')::uuid and space_id = v_space and status = 'CONFLICT' for update;
  if not found then perform cfo_raise('NOT_FOUND', 'Строка не найдена или уже разобрана', 404); end if;
  if p->>'decision' = 'IMPORT' then
    v_tx := cfo__post(v_space, (p->'transaction') || jsonb_build_object('source', 'IMPORT', 'import_batch_id', row_.batch_id));
  end if;
  update cfo_import_rows set status = 'RESOLVED', transaction_id = v_tx, message = case when v_tx is null then 'Пропущено после проверки' else 'Проведено после проверки' end where id = row_.id;
  return cfo_idem_end(v_space, p->>'idempotency_key', jsonb_build_object('transaction_id', v_tx));
end $$;

-- Первичная настройка: личное пространство и продакшн для разрешённого пользователя
create or replace function cfo_bootstrap() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_email text; v_me uuid; v_biz uuid;
begin
  if v_uid is null then perform cfo_raise('UNAUTHENTICATED', 'Нужно войти', 401); end if;
  select lower(email) into v_email from auth.users where id = v_uid;
  if not exists (select 1 from cfo_allowed_users where email = v_email) then
    perform cfo_raise('NOT_ALLOWED', 'Этот аккаунт не подключён к финансовому директору', 403);
  end if;
  select id into v_me from cfo_spaces where owner_id = v_uid and type = 'PERSONAL';
  if v_me is null then
    insert into cfo_spaces (owner_id, type, name) values (v_uid, 'PERSONAL', 'Я') returning id into v_me;
    insert into cfo_memberships (space_id, user_id) values (v_me, v_uid);
    insert into cfo_space_versions (space_id) values (v_me);
  end if;
  select id into v_biz from cfo_spaces where owner_id = v_uid and type = 'BUSINESS';
  if v_biz is null then
    insert into cfo_spaces (owner_id, type, name) values (v_uid, 'BUSINESS', 'Продакшн') returning id into v_biz;
    insert into cfo_memberships (space_id, user_id) values (v_biz, v_uid);
    insert into cfo_space_versions (space_id) values (v_biz);
    -- Подтверждённая структура из ТЗ: партнёры и направления; доли и суммы не подставляются
    insert into cfo_counterparties (space_id, name, types, is_self, sort_order) values
      (v_biz, 'Кирилл (я)', '{PARTNER}', true, 0), (v_biz, 'Никита', '{PARTNER}', false, 1), (v_biz, 'Сергей', '{PARTNER}', false, 2);
    insert into cfo_directions (space_id, name, kind) values
      (v_biz, 'Кино и сериалы', 'FILM'), (v_biz, 'Вертикальные сериалы', 'VERTICAL'), (v_biz, 'ИИ-продакшн', 'AI');
  end if;
  return jsonb_build_object('personal_space_id', v_me, 'business_space_id', v_biz);
end $$;
