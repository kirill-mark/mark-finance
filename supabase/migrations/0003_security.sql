-- Триггеры (журнал, версии, инварианты), снимок данных, политики доступа.

-- Версия записи и время изменения; пространство записи менять нельзя
create or replace function cfo_touch_trg() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new)->>'space_id') is distinct from (to_jsonb(old)->>'space_id') then
    perform cfo_raise('SPACE_IMMUTABLE', 'Запись нельзя перенести в другое пространство', 422);
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

-- Неизменяемый журнал изменений + версия данных пространства для кэша и черновиков
create or replace function cfo_audit_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_new jsonb; v_old jsonb; v_space uuid;
begin
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  v_space := coalesce(v_new->>'space_id', v_old->>'space_id',
    case when tg_table_name = 'cfo_spaces' then coalesce(v_new->>'id', v_old->>'id') end)::uuid;
  insert into cfo_audit_events (space_id, actor, action, entity, entity_id, before, after, request_id)
  values (v_space, auth.uid(), tg_op, tg_table_name, coalesce(v_new->>'id', v_old->>'id'), v_old, v_new, nullif(current_setting('cfo.request_id', true), ''));
  if v_space is not null then
    update cfo_space_versions set data_version = data_version + 1 where space_id = v_space;
  end if;
  return null;
end $$;

create or replace function cfo_immutable_trg() returns trigger
language plpgsql as $$
begin
  perform cfo_raise('IMMUTABLE', 'Проведённые движения не изменяются — используй исправление со сторно', 422);
  return null;
end $$;

-- План: нельзя уменьшить ниже оплаченного; перенос даты согласованно обновляет зеркальный план (F10)
create or replace function cfo_plan_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_paid bigint;
begin
  -- связать можно только с планом пространства, к которому у пользователя есть доступ
  if new.linked_plan_id is not null and (tg_op = 'INSERT' or new.linked_plan_id is distinct from old.linked_plan_id)
     and not cfo_is_member((select space_id from cfo_payment_plans where id = new.linked_plan_id)) then
    perform cfo_raise('FORBIDDEN', 'Нет доступа', 404);
  end if;
  if tg_op = 'INSERT' then return new; end if;
  if new.direction <> old.direction then perform cfo_raise('DIRECTION_IMMUTABLE', 'Направление плана не меняется — создай новый план', 422); end if;
  select coalesce(sum(amount), 0) into v_paid from cfo_settlements where plan_id = new.id and status = 'ACTIVE';
  if new.amount < v_paid then perform cfo_raise('BELOW_PAID', 'Сумма плана не может быть меньше уже оплаченного', 422); end if;
  if new.cancelled_at is not null and old.cancelled_at is null and coalesce(new.cancel_reason, '') = '' then
    perform cfo_raise('REASON_REQUIRED', 'Укажи причину отмены', 400);
  end if;
  if pg_trigger_depth() = 1 and new.linked_plan_id is not null
     and (new.expected_date is distinct from old.expected_date or new.cancelled_at is distinct from old.cancelled_at) then
    update cfo_payment_plans set expected_date = new.expected_date,
      cancelled_at = case when new.cancelled_at is not null then coalesce(cancelled_at, new.cancelled_at) else cancelled_at end,
      cancel_reason = case when new.cancelled_at is not null and cancelled_at is null then 'Отменён связанный план: ' || new.cancel_reason else cancel_reason end
    where id = new.linked_plan_id;
  end if;
  return new;
end $$;

-- Распределения общих расходов не превышают исходную статью
create or replace function cfo_overhead_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_line bigint; v_sum bigint;
begin
  select original_mgmt into v_line from cfo_budget_lines where id = new.budget_line_id and project_id is null;
  if v_line is null then perform cfo_raise('NOT_OVERHEAD', 'Распределять можно только статьи общих расходов', 422); end if;
  select coalesce(sum(coalesce(amount, cfo_mul_div_half_up(v_line, share_bp, 10000))), 0) into v_sum
  from cfo_overhead_allocations where budget_line_id = new.budget_line_id;
  if v_sum > v_line then perform cfo_raise('OVERHEAD_EXCEEDS', 'Распределено больше, чем в статье общих расходов', 422); end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['cfo_spaces', 'cfo_accounts', 'cfo_counterparties', 'cfo_directions', 'cfo_projects', 'cfo_revenue_agreements',
    'cfo_funding_sources', 'cfo_budget_lines', 'cfo_loans', 'cfo_distribution_pools', 'cfo_partner_claims', 'cfo_recurrence_rules',
    'cfo_payment_plans', 'cfo_import_batches', 'cfo_transactions', 'cfo_settlements', 'cfo_cost_records', 'cfo_goals', 'cfo_reserves',
    'cfo_reserve_schedules', 'cfo_personal_budgets', 'cfo_overhead_allocations', 'cfo_import_rows', 'cfo_recommendation_states', 'cfo_assistant_drafts'] loop
    execute format('drop trigger if exists touch on %I', t);
    execute format('create trigger touch before update on %I for each row execute function cfo_touch_trg()', t);
  end loop;
  foreach t in array array['cfo_spaces', 'cfo_accounts', 'cfo_counterparties', 'cfo_directions', 'cfo_projects', 'cfo_revenue_agreements',
    'cfo_funding_sources', 'cfo_budget_lines', 'cfo_loans', 'cfo_distribution_pools', 'cfo_partner_claims', 'cfo_recurrence_rules',
    'cfo_payment_plans', 'cfo_import_batches', 'cfo_transactions', 'cfo_account_entries', 'cfo_settlements', 'cfo_cost_records', 'cfo_goals',
    'cfo_reserves', 'cfo_reserve_events', 'cfo_reserve_schedules', 'cfo_personal_budgets', 'cfo_overhead_allocations', 'cfo_import_rows',
    'cfo_reconciliations', 'cfo_recommendation_states', 'cfo_memberships'] loop
    execute format('drop trigger if exists audit on %I', t);
    execute format('create trigger audit after insert or update or delete on %I for each row execute function cfo_audit_trg()', t);
  end loop;
end $$;

drop trigger if exists immutable on cfo_account_entries;
create trigger immutable before update on cfo_account_entries for each row execute function cfo_immutable_trg();
drop trigger if exists immutable on cfo_reserve_events;
create trigger immutable before update on cfo_reserve_events for each row execute function cfo_immutable_trg();
drop trigger if exists immutable on cfo_audit_events;
create trigger immutable before update or delete on cfo_audit_events for each row execute function cfo_immutable_trg();
drop trigger if exists plan_rules on cfo_payment_plans;
create trigger plan_rules before insert or update on cfo_payment_plans for each row execute function cfo_plan_trg();
drop trigger if exists overhead_rules on cfo_overhead_allocations;
create constraint trigger overhead_rules after insert or update on cfo_overhead_allocations deferrable initially immediate for each row execute function cfo_overhead_trg();

-- Денежные поля в снимке — десятичные строки целых копеек
create or replace function cfo_j(r jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, case
    when jsonb_typeof(v) = 'number' and k = any (array['amount', 'mgmt_amount', 'opening_balance', 'min_balance', 'monthly_minimum', 'declared',
      'confirmed', 'original_amount', 'original_mgmt', 'contract_amount', 'target', 'limit_amount', 'computed', 'entered', 'difference',
      'data_version', 'end_cash', 'min_free']) then to_jsonb(v #>> '{}')
    else v end), '{}'::jsonb)
  from jsonb_each(r) as e(k, v)
$$;

-- GET /summary и /forecast считаются из этого снимка тем же расчётным модулем
create or replace function cfo_snapshot() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_spaces uuid[];
begin
  if auth.uid() is null then perform cfo_raise('UNAUTHENTICATED', 'Нужно войти', 401); end if;
  select coalesce(array_agg(space_id), '{}') into v_spaces from cfo_memberships where user_id = auth.uid();
  return jsonb_build_object(
    'spaces', (select coalesce(jsonb_agg(cfo_j(to_jsonb(s) || jsonb_build_object('data_version', v.data_version))), '[]') from cfo_spaces s join cfo_space_versions v on v.space_id = s.id where s.id = any (v_spaces)),
    'accounts', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x)) order by x.created_at), '[]') from cfo_accounts x where x.space_id = any (v_spaces)),
    'counterparties', (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_order, x.name), '[]') from cfo_counterparties x where x.space_id = any (v_spaces)),
    'directions', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]') from cfo_directions x where x.space_id = any (v_spaces)),
    'projects', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]') from cfo_projects x where x.space_id = any (v_spaces)),
    'revenue_agreements', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_revenue_agreements x where x.space_id = any (v_spaces)),
    'funding_sources', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_funding_sources x where x.space_id = any (v_spaces)),
    'budget_lines', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x)) order by x.created_at), '[]') from cfo_budget_lines x where x.space_id = any (v_spaces)),
    'plans', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x)) order by x.created_at), '[]') from cfo_payment_plans x where x.space_id = any (v_spaces)),
    'recurrences', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from cfo_recurrence_rules x where x.space_id = any (v_spaces)),
    'transactions', (select coalesce(jsonb_agg(to_jsonb(x) order by x.occurred_on, x.created_at), '[]') from cfo_transactions x where x.space_id = any (v_spaces)),
    'entries', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_account_entries x where x.space_id = any (v_spaces)),
    'settlements', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_settlements x where x.space_id = any (v_spaces)),
    'cost_records', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_cost_records x where x.space_id = any (v_spaces)),
    'reserves', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at, x.id), '[]') from cfo_reserves x where x.space_id = any (v_spaces)),
    'reserve_events', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_reserve_events x where x.space_id = any (v_spaces)),
    'reserve_schedules', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_reserve_schedules x where x.space_id = any (v_spaces)),
    'goals', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_goals x where x.space_id = any (v_spaces)),
    'budgets', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_personal_budgets x where x.space_id = any (v_spaces)),
    'claims', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x)) order by x.created_at), '[]') from cfo_partner_claims x where x.space_id = any (v_spaces)),
    'loans', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_loans x where x.space_id = any (v_spaces)),
    'pools', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_distribution_pools x where x.space_id = any (v_spaces)),
    'overheads', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x))), '[]') from cfo_overhead_allocations x where x.space_id = any (v_spaces)),
    'import_conflicts', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'space_id', x.space_id, 'status', 'OPEN', 'raw', x.raw, 'message', x.message, 'batch_id', x.batch_id)), '[]') from cfo_import_rows x where x.space_id = any (v_spaces) and x.status = 'CONFLICT'),
    'recommendation_states', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from cfo_recommendation_states x where x.space_id = any (v_spaces)),
    'reconciliations', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x)) order by x.created_at desc), '[]') from cfo_reconciliations x where x.space_id = any (v_spaces)),
    'forecast_history', (select coalesce(jsonb_agg(cfo_j(to_jsonb(x)) order by x.date), '[]') from cfo_forecast_history x where x.space_id = any (v_spaces) and x.date >= current_date - 60)
  );
end $$;

-- Журнал изменений с фильтром по сущности
create or replace function cfo_audit(p_space uuid, p_entity_id text default null, p_limit int default 200) returns setof cfo_audit_events
language plpgsql stable security definer set search_path = public as $$
begin
  perform cfo_assert_member(p_space);
  return query select * from cfo_audit_events where space_id = p_space and (p_entity_id is null or entity_id = p_entity_id)
    order by id desc limit least(greatest(p_limit, 1), 1000);
end $$;

-- Политики доступа: всё закрыто, кроме своих пространств
do $$
declare
  t text;
  all_tables text[] := array['cfo_allowed_users', 'cfo_spaces', 'cfo_space_versions', 'cfo_memberships', 'cfo_accounts', 'cfo_counterparties',
    'cfo_directions', 'cfo_projects', 'cfo_revenue_agreements', 'cfo_funding_sources', 'cfo_budget_lines', 'cfo_loans', 'cfo_distribution_pools',
    'cfo_partner_claims', 'cfo_recurrence_rules', 'cfo_payment_plans', 'cfo_import_batches', 'cfo_transactions', 'cfo_account_entries',
    'cfo_settlements', 'cfo_cost_records', 'cfo_goals', 'cfo_reserves', 'cfo_reserve_events', 'cfo_reserve_schedules', 'cfo_personal_budgets',
    'cfo_overhead_allocations', 'cfo_import_rows', 'cfo_reconciliations', 'cfo_recommendation_states', 'cfo_assistant_drafts',
    'cfo_forecast_history', 'cfo_idempotency', 'cfo_audit_events'];
  -- прямые вставка и изменение разрешены (остальное — только через серверные функции)
  writable text[] := array['cfo_accounts', 'cfo_counterparties', 'cfo_directions', 'cfo_projects', 'cfo_revenue_agreements', 'cfo_funding_sources',
    'cfo_budget_lines', 'cfo_loans', 'cfo_partner_claims', 'cfo_recurrence_rules', 'cfo_payment_plans', 'cfo_goals', 'cfo_reserves',
    'cfo_reserve_schedules', 'cfo_personal_budgets', 'cfo_overhead_allocations', 'cfo_recommendation_states', 'cfo_assistant_drafts',
    'cfo_forecast_history'];
  deletable text[] := array['cfo_personal_budgets', 'cfo_overhead_allocations', 'cfo_recommendation_states', 'cfo_directions'];
begin
  foreach t in array all_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
  foreach t in array all_tables loop
    if t in ('cfo_allowed_users', 'cfo_idempotency') then continue; end if;
    execute format('drop policy if exists member_select on %I', t);
    if t = 'cfo_spaces' then
      execute 'create policy member_select on cfo_spaces for select to authenticated using (cfo_is_member(id))';
    elsif t = 'cfo_memberships' then
      execute 'create policy member_select on cfo_memberships for select to authenticated using (user_id = auth.uid())';
    else
      execute format('create policy member_select on %I for select to authenticated using (cfo_is_member(space_id))', t);
    end if;
    execute format('grant select on %I to authenticated', t);
  end loop;
  foreach t in array writable loop
    execute format('drop policy if exists member_insert on %I', t);
    execute format('drop policy if exists member_update on %I', t);
    execute format('create policy member_insert on %I for insert to authenticated with check (cfo_is_member(space_id))', t);
    execute format('create policy member_update on %I for update to authenticated using (cfo_is_member(space_id)) with check (cfo_is_member(space_id))', t);
    execute format('grant insert, update on %I to authenticated', t);
  end loop;
  foreach t in array deletable loop
    execute format('drop policy if exists member_delete on %I', t);
    execute format('create policy member_delete on %I for delete to authenticated using (cfo_is_member(space_id))', t);
    execute format('grant delete on %I to authenticated', t);
  end loop;
  -- настройки пространства — только изменение, без смены владельца/типа
  execute 'drop policy if exists member_update on cfo_spaces';
  execute 'create policy member_update on cfo_spaces for update to authenticated using (cfo_is_member(id)) with check (cfo_is_member(id))';
  execute 'grant update (name, timezone, min_balance, tax_status, tax_horizon_until, tax_note, stress_delay_days, reconcile_stale_days, monthly_minimum, onboarding) on cfo_spaces to authenticated';
  -- счёт: начальный остаток и точка открытия меняются только через cfo_change_opening
  execute 'revoke update on cfo_accounts from authenticated';
  execute 'grant update (name, type, archived) on cfo_accounts to authenticated';
end $$;

-- Функции: только для вошедших пользователей
do $$
declare f text;
begin
  foreach f in array array['cfo_post_transaction(jsonb)', 'cfo_correct_transaction(jsonb)', 'cfo_transfer(jsonb)', 'cfo_reserve_change(jsonb)',
    'cfo_agree_cost(jsonb)', 'cfo_paid_for_company(jsonb)', 'cfo_owner_payout(jsonb)', 'cfo_owner_contribution(jsonb)', 'cfo_create_distribution(jsonb)',
    'cfo_reconcile(jsonb)', 'cfo_change_opening(jsonb)', 'cfo_import_commit(jsonb)', 'cfo_import_resolve(jsonb)', 'cfo_bootstrap()', 'cfo_snapshot()',
    'cfo_audit(uuid, text, int)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- внутренние функции наружу не выставляются
  foreach f in array array['cfo__post(uuid, jsonb)', 'cfo__consume_reserves(uuid, uuid, bigint, date, uuid)', 'cfo__lock_pair(uuid, uuid)',
    'cfo_idem_begin(uuid, text, jsonb)', 'cfo_idem_end(uuid, text, jsonb)', 'cfo_lock_space(uuid)', 'cfo_space_cash(uuid)', 'cfo_space_reserved(uuid)',
    'cfo_account_balance(uuid, date)', 'cfo_reserve_balance(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- Живое обновление между устройствами: клиенты слушают версии своих пространств (RLS применяется)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'cfo_space_versions') then
    alter publication supabase_realtime add table public.cfo_space_versions;
  end if;
end $$;
