-- Владелец приложения (настройка развёртывания; публичной регистрации в продукте нет).
-- Почта должна совпадать с аккаунтом Supabase Auth, которым входишь в планировщик MARK.
insert into cfo_allowed_users (email) values ('markkirill08@gmail.com'), ('marchenkokirill@bk.ru') on conflict do nothing;
