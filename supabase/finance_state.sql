-- Mark Finance: хранилище данных в том же Supabase-проекте, что и планировщик MARK.
-- Один JSON на пользователя; каждый видит и меняет только свою строку (RLS).
-- Выполнить один раз: Supabase → SQL Editor → вставить → Run. Повторный запуск безопасен.

create table if not exists public.finance_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.finance_state enable row level security;

drop policy if exists "finance_state select own" on public.finance_state;
drop policy if exists "finance_state insert own" on public.finance_state;
drop policy if exists "finance_state update own" on public.finance_state;
drop policy if exists "finance_state delete own" on public.finance_state;

create policy "finance_state select own" on public.finance_state
  for select using (auth.uid() = user_id);
create policy "finance_state insert own" on public.finance_state
  for insert with check (auth.uid() = user_id);
create policy "finance_state update own" on public.finance_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "finance_state delete own" on public.finance_state
  for delete using (auth.uid() = user_id);

-- Живая синхронизация между открытыми устройствами
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'finance_state'
  ) then
    alter publication supabase_realtime add table public.finance_state;
  end if;
end $$;
