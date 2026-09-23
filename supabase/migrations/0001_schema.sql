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
