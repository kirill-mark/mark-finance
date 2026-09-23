-- Mark Finance · установка схемы. Повторный запуск безопасен.

-- ===== 0001_schema.sql =====
-- Карманный финансовый директор · схема данных
-- Суммы — bigint целых копеек. Проценты — целые базисные пункты.
-- Все финансовые сущности имеют space_id; связи внутри пространства проверяются
-- составными внешними ключами (id, space_id), поэтому чужой проект к плану не привязать.

-- Разрешённые пользователи (приложение закрыто; публичной регистрации в продукт нет)
create table if not exists cfo_allowed_users (
  email text primary key check (email = lower(email))
);

create table if not exists cfo_spaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('PERSONAL', 'BUSINESS')),
  name text not null,
  timezone text not null default 'Europe/Moscow',
  min_balance bigint check (min_balance is null or min_balance >= 0),
  tax_status text not null default 'NOT_SET' check (tax_status in ('NOT_SET', 'PENDING', 'ENTERED')),
  tax_horizon_until date,
  tax_note text not null default '',
  stress_delay_days int not null default 14 check (stress_delay_days between 0 and 365),
  reconcile_stale_days int not null default 7 check (reconcile_stale_days between 1 and 365),
  monthly_minimum bigint check (monthly_minimum is null or monthly_minimum >= 0),
  onboarding jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  version int not null default 1,
  unique (owner_id, type)
);

create table if not exists cfo_space_versions (
  space_id uuid primary key references cfo_spaces (id) on delete cascade,
  data_version bigint not null default 1
);

create table if not exists cfo_memberships (
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'OWNER' check (role in ('OWNER')),
  created_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

-- Общие колонки изменяемых записей: id, space_id, created_at, updated_at, created_by, version

create table if not exists cfo_accounts (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  type text not null default 'BANK' check (type in ('BANK', 'CARD', 'CASH', 'SAVINGS', 'OTHER')),
  opening_balance bigint not null,
  opening_date date not null,
  reconciled_at date,
  archived boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id)
);

create table if not exists cfo_counterparties (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 160),
  types text[] not null default '{OTHER}',
  is_self boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  check (types <@ array['CLIENT', 'CONTRACTOR', 'PARTNER', 'OTHER'])
);

create table if not exists cfo_directions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  name text not null,
  kind text not null default 'OTHER' check (kind in ('FILM', 'VERTICAL', 'AI', 'OTHER')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id)
);

create table if not exists cfo_projects (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 160),
  direction_id uuid,
  model text not null check (model in ('SERVICE', 'OWN_IP', 'EXPERIMENT')),
  stage text not null default 'DEVELOPMENT' check (stage in ('IDEA', 'DEVELOPMENT', 'PREPRODUCTION', 'SHOOTING', 'POSTPRODUCTION', 'RELEASE', 'DONE', 'CANCELLED')),
  client_id uuid,
  start_date date,
  end_date date,
  in_forecast boolean not null default true,
  metrics jsonb not null default '{}'::jsonb,
  notes text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  foreign key (direction_id, space_id) references cfo_directions (id, space_id),
  foreign key (client_id, space_id) references cfo_counterparties (id, space_id)
);

create table if not exists cfo_revenue_agreements (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  project_id uuid not null,
  client_id uuid,
  amount bigint not null check (amount >= 0),
  mgmt_amount bigint not null check (mgmt_amount >= 0),
  status text not null default 'SIGNED' check (status in ('DRAFT', 'SIGNED', 'CANCELLED')),
  reference text not null default '',
  is_extra_work boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  foreign key (project_id, space_id) references cfo_projects (id, space_id),
  foreign key (client_id, space_id) references cfo_counterparties (id, space_id)
);

create table if not exists cfo_funding_sources (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  project_id uuid not null,
  kind text not null check (kind in ('OWN_FUNDS', 'INVESTOR', 'LOAN', 'PRESALE', 'GRANT', 'OTHER')),
  name text not null default '',
  declared bigint not null default 0 check (declared >= 0),
  confirmed bigint not null default 0 check (confirmed >= 0),
  status text not null default 'DECLARED' check (status in ('DECLARED', 'CONFIRMED', 'CANCELLED')),
  terms text not null default '',
  is_reallocation boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  foreign key (project_id, space_id) references cfo_projects (id, space_id)
);

create table if not exists cfo_budget_lines (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  project_id uuid,
  category text not null,
  stage text not null default 'OTHER' check (stage in ('PREPRODUCTION', 'SHOOTING', 'POSTPRODUCTION', 'SERVICES', 'TEAM', 'OTHER')),
  original_amount bigint not null default 0 check (original_amount >= 0),
  original_mgmt bigint not null default 0 check (original_mgmt >= 0),
  note text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  foreign key (project_id, space_id) references cfo_projects (id, space_id)
);

create table if not exists cfo_loans (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  lender_counterparty_id uuid,
  lender_name text not null default '',
  contract_amount bigint not null check (contract_amount >= 0),
  note text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  foreign key (lender_counterparty_id, space_id) references cfo_counterparties (id, space_id)
);

create table if not exists cfo_distribution_pools (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  period text not null default '',
  project_id uuid,
  amount bigint not null check (amount >= 0),
  approved_on date not null,
  recipients jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  foreign key (project_id, space_id) references cfo_projects (id, space_id)
);

create table if not exists cfo_partner_claims (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  counterparty_id uuid not null,
  direction text not null check (direction in ('COMPANY_OWES', 'PARTNER_OWES')),
  basis text not null check (basis in ('FEE', 'REIMBURSEMENT', 'LOAN', 'DISTRIBUTION')),
  amount bigint not null check (amount > 0),
  approved boolean not null default false,
  note text not null default '',
  cost_record_id uuid,
  pool_id uuid,
  cancelled boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  foreign key (counterparty_id, space_id) references cfo_counterparties (id, space_id),
  foreign key (pool_id, space_id) references cfo_distribution_pools (id, space_id)
);

create table if not exists cfo_recurrence_rules (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  freq text not null check (freq in ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY')),
  day int not null check (day between 0 and 31),
  start_date date not null,
  end_date date,
  template jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id)
);

create table if not exists cfo_payment_plans (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  direction text not null check (direction in ('IN', 'OUT')),
  amount bigint not null check (amount > 0),
  mgmt_amount bigint check (mgmt_amount is null or mgmt_amount >= 0),
  due_date date,
  expected_date date,
  expected_time text check (expected_time is null or expected_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  counterparty_id uuid,
  certainty text not null default 'CONTRACTED' check (certainty in ('CONTRACTED', 'ESTIMATE', 'PIPELINE')),
  effect text not null check (effect in ('PROJECT_COST', 'OVERHEAD_COST', 'SALES', 'FINANCING', 'REIMBURSEMENT', 'PROFIT_DISTRIBUTION', 'PERSONAL_CONSUMPTION', 'PERSONAL_INCOME', 'TAX', 'INTERNAL_TRANSFER', 'NONE')),
  title text not null default '',
  basis text not null default '',
  project_id uuid,
  budget_line_id uuid,
  funding_source_id uuid,
  partner_claim_id uuid,
  loan_id uuid,
  category text,
  in_forecast boolean not null default true,
  cancelled_at date,
  cancel_reason text not null default '',
  recurrence_rule_id uuid,
  occurrence_date date,
  linked_plan_id uuid references cfo_payment_plans (id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  unique (recurrence_rule_id, occurrence_date),
  -- дата обязательна, кроме оставшейся оценки затрат (F04: без даты — неполный прогноз)
  check (due_date is not null or expected_date is not null or certainty = 'ESTIMATE'),
  check (cancelled_at is null or length(cancel_reason) > 0),
  foreign key (counterparty_id, space_id) references cfo_counterparties (id, space_id),
  foreign key (project_id, space_id) references cfo_projects (id, space_id),
  foreign key (budget_line_id, space_id) references cfo_budget_lines (id, space_id),
  foreign key (funding_source_id, space_id) references cfo_funding_sources (id, space_id),
  foreign key (partner_claim_id, space_id) references cfo_partner_claims (id, space_id),
  foreign key (loan_id, space_id) references cfo_loans (id, space_id),
  foreign key (recurrence_rule_id, space_id) references cfo_recurrence_rules (id, space_id)
);

create table if not exists cfo_import_batches (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  file_name text not null default '',
  fingerprint text not null,
  status text not null default 'COMMITTED' check (status in ('COMMITTED')),
  rows_total int not null default 0,
  rows_imported int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (space_id, fingerprint)
);

create table if not exists cfo_transactions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  kind text not null check (kind in ('CLIENT_RECEIPT', 'INCOME', 'EXPENSE', 'TRANSFER', 'LOAN_IN', 'LOAN_REPAYMENT', 'INTEREST', 'PARTNER_PAYOUT', 'REIMBURSEMENT', 'OWNER_CONTRIBUTION', 'TAX', 'ADJUSTMENT', 'CROSS_SPACE', 'PAID_BY_PARTNER')),
  description text not null default '',
  status text not null default 'POSTED' check (status in ('POSTED', 'REVERSED')),
  is_storno boolean not null default false,
  source text not null default 'MANUAL' check (source in ('MANUAL', 'IMPORT', 'ASSISTANT')),
  occurred_on date not null,
  counterparty_id uuid,
  project_id uuid,
  category text,
  effect text not null default 'NONE',
  correction_of uuid references cfo_transactions (id),
  loan_id uuid,
  external_id text,
  external_account_id uuid,
  import_batch_id uuid references cfo_import_batches (id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  foreign key (counterparty_id, space_id) references cfo_counterparties (id, space_id),
  foreign key (project_id, space_id) references cfo_projects (id, space_id),
  foreign key (loan_id, space_id) references cfo_loans (id, space_id)
);
-- Повтор того же external_id на том же счёте не создаёт новый факт
create unique index if not exists cfo_transactions_external on cfo_transactions (external_account_id, external_id) where external_id is not null and not is_storno;

create table if not exists cfo_account_entries (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  transaction_id uuid not null,
  account_id uuid not null,
  amount bigint not null check (amount <> 0),
  effective_on date not null,
  created_at timestamptz not null default now(),
  foreign key (transaction_id, space_id) references cfo_transactions (id, space_id),
  foreign key (account_id, space_id) references cfo_accounts (id, space_id)
);
create index if not exists cfo_entries_account on cfo_account_entries (account_id, effective_on);

create table if not exists cfo_settlements (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  transaction_id uuid not null,
  plan_id uuid not null,
  amount bigint not null check (amount > 0),
  mgmt_amount bigint not null check (mgmt_amount >= 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'VOID')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  foreign key (transaction_id, space_id) references cfo_transactions (id, space_id),
  foreign key (plan_id, space_id) references cfo_payment_plans (id, space_id)
);
create index if not exists cfo_settlements_plan on cfo_settlements (plan_id) where status = 'ACTIVE';

create table if not exists cfo_cost_records (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  budget_line_id uuid,
  project_id uuid,
  amount bigint not null check (amount > 0),
  mgmt_amount bigint not null check (mgmt_amount >= 0),
  paid_by_counterparty_id uuid,
  transaction_id uuid,
  plan_id uuid,
  settlement_id uuid unique references cfo_settlements (id),
  occurred_on date not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'VOID')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  foreign key (budget_line_id, space_id) references cfo_budget_lines (id, space_id),
  foreign key (project_id, space_id) references cfo_projects (id, space_id),
  foreign key (paid_by_counterparty_id, space_id) references cfo_counterparties (id, space_id),
  foreign key (transaction_id, space_id) references cfo_transactions (id, space_id),
  foreign key (plan_id, space_id) references cfo_payment_plans (id, space_id)
);

create table if not exists cfo_goals (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  name text not null,
  target bigint not null check (target >= 0),
  due_date date,
  priority int not null default 0,
  kind text not null default 'OTHER' check (kind in ('EMERGENCY', 'OTHER')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id)
);

create table if not exists cfo_reserves (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  purpose text not null,
  kind text not null check (kind in ('PAYMENT_LINKED', 'GOAL')),
  plan_id uuid,
  goal_id uuid,
  closed boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (id, space_id),
  check ((kind = 'PAYMENT_LINKED') = (plan_id is not null)),
  foreign key (plan_id, space_id) references cfo_payment_plans (id, space_id),
  foreign key (goal_id, space_id) references cfo_goals (id, space_id)
);

create table if not exists cfo_reserve_events (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  reserve_id uuid not null,
  kind text not null check (kind in ('ALLOCATE', 'RELEASE', 'CONSUME')),
  amount bigint not null check (amount > 0),
  date date not null,
  settlement_id uuid references cfo_settlements (id),
  note text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  foreign key (reserve_id, space_id) references cfo_reserves (id, space_id)
);

create table if not exists cfo_reserve_schedules (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  reserve_id uuid not null,
  date date not null,
  amount bigint not null check (amount > 0),
  status text not null default 'PLANNED' check (status in ('PLANNED', 'DONE', 'CANCELLED')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  foreign key (reserve_id, space_id) references cfo_reserves (id, space_id)
);

create table if not exists cfo_personal_budgets (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  month text check (month is null or month ~ '^\d{4}-\d{2}$'),
  category text not null,
  limit_amount bigint not null check (limit_amount >= 0),
  kind text not null check (kind in ('FIXED', 'VARIABLE')),
  in_minimum boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1
);
create unique index if not exists cfo_budgets_unique on cfo_personal_budgets (space_id, coalesce(month, '*'), category);

create table if not exists cfo_overhead_allocations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  budget_line_id uuid not null,
  project_id uuid not null,
  amount bigint check (amount is null or amount >= 0),
  share_bp int check (share_bp is null or share_bp between 0 and 10000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  check ((amount is null) <> (share_bp is null)),
  foreign key (budget_line_id, space_id) references cfo_budget_lines (id, space_id),
  foreign key (project_id, space_id) references cfo_projects (id, space_id)
);

create table if not exists cfo_import_rows (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  batch_id uuid not null references cfo_import_batches (id) on delete cascade,
  row_no int not null,
  raw jsonb not null,
  status text not null check (status in ('IMPORTED', 'DUPLICATE', 'SKIPPED', 'BLOCKED', 'ERROR', 'CONFLICT', 'RESOLVED')),
  message text not null default '',
  transaction_id uuid references cfo_transactions (id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1
);

create table if not exists cfo_reconciliations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  account_id uuid not null,
  at date not null,
  computed bigint not null,
  entered bigint not null,
  difference bigint not null,
  decision text not null check (decision in ('MATCHED', 'ADJUSTED', 'PENDING')),
  adjustment_tx_id uuid references cfo_transactions (id),
  note text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  foreign key (account_id, space_id) references cfo_accounts (id, space_id)
);

create table if not exists cfo_recommendation_states (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  fingerprint text not null,
  status text not null check (status in ('DISMISSED', 'DONE')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1,
  unique (space_id, fingerprint)
);

create table if not exists cfo_assistant_drafts (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  intent text not null,
  message text not null default '',
  fields jsonb not null default '{}'::jsonb,
  missing jsonb not null default '[]'::jsonb,
  data_version bigint not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  expires_at timestamptz not null default now() + interval '1 day',
  result jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(), version int not null default 1
);

create table if not exists cfo_forecast_history (
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  date date not null,
  scenario text not null,
  limit_amount bigint,
  end_cash bigint not null,
  min_free bigint not null,
  quality text not null,
  created_at timestamptz not null default now(),
  primary key (space_id, date, scenario)
);

create table if not exists cfo_idempotency (
  space_id uuid not null references cfo_spaces (id) on delete cascade,
  key text not null check (length(key) between 8 and 200),
  request_hash text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (space_id, key)
);

-- Журнал изменений: неизменяемая история
create table if not exists cfo_audit_events (
  id bigint generated always as identity primary key,
  space_id uuid,
  actor uuid,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  at timestamptz not null default now(),
  request_id text
);
create index if not exists cfo_audit_space on cfo_audit_events (space_id, at desc);


-- ===== 0002_functions.sql =====
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


-- ===== 0003_security.sql =====
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


-- ===== owner.sql =====
-- Владелец приложения (настройка развёртывания; публичной регистрации в продукте нет).
-- Почта должна совпадать с аккаунтом, которым входишь в планировщик MARK.
insert into cfo_allowed_users (email) values ('markkirill08@gmail.com') on conflict do nothing;
