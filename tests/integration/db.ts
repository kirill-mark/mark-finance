// Тестовая база: PGlite (Postgres в памяти) + заглушка схемы auth Supabase + миграции.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fromDb } from "../../src/modules/data/snapshot";
import type { ISODate } from "../../src/shared/dates";

const AUTH_STUB = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
end $$;
grant usage on schema public to authenticated, anon;
grant usage on schema auth to authenticated, anon;
grant select on auth.users to authenticated;
grant execute on function auth.uid() to authenticated, anon;
`;

export class TestDb {
  pg!: PGlite;
  static async create(): Promise<TestDb> {
    const t = new TestDb();
    t.pg = new PGlite();
    await t.pg.exec(AUTH_STUB);
    const dir = join(import.meta.dirname, "../../supabase/migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      await t.pg.exec(readFileSync(join(dir, f), "utf8"));
    }
    return t;
  }

  async addUser(id: string, email: string, allowed = true) {
    await this.pg.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
    if (allowed) await this.pg.query("insert into cfo_allowed_users (email) values ($1)", [email.toLowerCase()]);
  }

  /** Выполнить запрос от имени пользователя (роль authenticated, RLS включён). */
  async as<T = any>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.pg.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ""]);
      await tx.exec("set local role authenticated");
      const r = await tx.query<T>(sql, params);
      return r.rows;
    });
  }

  async rpc<T = any>(userId: string, fn: string, payload?: unknown): Promise<T> {
    const rows = payload === undefined
      ? await this.as<{ r: T }>(userId, `select ${fn}() as r`)
      : await this.as<{ r: T }>(userId, `select ${fn}($1::jsonb) as r`, [JSON.stringify(payload)]);
    return rows[0].r;
  }

  /** Ожидаемая ошибка: возвращает машинный код (detail) и HTTP-статус (hint). */
  async rpcError(userId: string, fn: string, payload?: unknown): Promise<{ code: string; http: number; message: string }> {
    try {
      await this.rpc(userId, fn, payload);
    } catch (e: any) {
      return { code: e.detail ?? e.code, http: Number(e.hint ?? 0), message: e.message };
    }
    throw new Error(`Ожидалась ошибка от ${fn}`);
  }

  async snapshot(userId: string, asOf: ISODate) {
    const raw = await this.rpc<any>(userId, "cfo_snapshot");
    return { raw, s: fromDb(raw, asOf) };
  }
}

let n = 0;
export const key = (p = "k") => `${p}-${Date.now()}-${++n}-idem`;
