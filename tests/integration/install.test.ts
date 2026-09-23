// Файл установки для Supabase SQL Editor выполняется целиком и повторно без ошибок.
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STUB = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create role authenticated nologin; create role anon nologin;`;

describe("supabase/install.sql", () => {
  it("устанавливается и переустанавливается без ошибок", async () => {
    const pg = new PGlite();
    await pg.exec(STUB);
    const sql = readFileSync(join(import.meta.dirname, "../../supabase/install.sql"), "utf8");
    await pg.exec(sql);
    await pg.exec(sql);
    const t = await pg.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_name like 'cfo_%'");
    expect(t.rows[0].n).toBeGreaterThanOrEqual(30);
    const owner = await pg.query<{ n: number }>("select count(*)::int as n from cfo_allowed_users");
    expect(owner.rows[0].n).toBe(2);
  }, 60_000);
});
