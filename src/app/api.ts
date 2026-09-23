// Доступ к серверу: вход, снимок данных, серверные функции с ключами идемпотентности,
// правки записей с проверкой версии. Ошибки — понятный текст + машинный код.
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";
import type { DbSnapshot } from "../modules/data/snapshot";

export class ApiError extends Error {
  constructor(message: string, public code: string, public http: number, public fields: string[] = []) {
    super(message);
  }
}

let client: SupabaseClient | null = null;
export function sb(): SupabaseClient {
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

export const newKey = (): string => crypto.randomUUID();

function toError(e: any): ApiError {
  if (!e) return new ApiError("Неизвестная ошибка", "UNKNOWN", 500);
  if (e instanceof ApiError) return e;
  const http = Number(e.hint) || (e.code === "42501" ? 403 : e.code === "23505" ? 409 : e.code === "23503" ? 422 : e.code === "PGRST301" ? 401 : 0);
  let message = e.message ?? String(e);
  if (e.code === "23505") message = "Такая запись уже есть";
  if (e.code === "23503") message = "Связанная запись не найдена или из другого пространства";
  if (e.code === "23514") message = "Значение не прошло проверку: " + (e.message ?? "");
  if (e.code === "42501") message = "Нет прав на это действие";
  if (/Failed to fetch|NetworkError|network/i.test(message)) return new ApiError("Нет связи с сервером. Изменение не сохранено.", "NETWORK", 503);
  return new ApiError(message, e.details ?? e.code ?? "ERROR", http || 400);
}

/** Серверная функция с обязательным ключом идемпотентности. */
export async function rpc<T = any>(fn: string, payload: Record<string, unknown>, idempotencyKey = newKey()): Promise<T> {
  const { data, error } = await sb().rpc(fn, { p: { ...payload, idempotency_key: idempotencyKey } });
  if (error) throw toError(error);
  return data as T;
}

export async function rpc0<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await sb().rpc(fn, args);
  if (error) throw toError(error);
  return data as T;
}

export async function loadSnapshot(): Promise<DbSnapshot & Record<string, any>> {
  return rpc0("cfo_snapshot");
}

export async function bootstrap(): Promise<{ personal_space_id: string; business_space_id: string }> {
  return rpc0("cfo_bootstrap");
}

/** Вставка с клиентским UUID: повтор того же запроса не создаёт дубль. */
export async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const id: string = (row.id as string) ?? newKey();
  const { error } = await sb().from(table).insert({ ...row, id });
  if (error) {
    if (error.code === "23505" && /_pkey/.test(error.message)) return id; // уже сохранено этим же запросом
    throw toError(error);
  }
  return id;
}

/** Изменение с ожидаемой версией: при устаревшей версии — конфликт 409. */
export async function update(table: string, id: string, version: number | null, patch: Record<string, unknown>): Promise<void> {
  let q = sb().from(table).update(patch).eq("id", id);
  if (version !== null) q = q.eq("version", version);
  const { data, error } = await q.select("id");
  if (error) throw toError(error);
  if (!data || data.length === 0) throw new ApiError("Запись изменилась в другом месте — обнови и повтори", "VERSION_CONFLICT", 409);
}

export async function remove(table: string, id: string): Promise<void> {
  const { error } = await sb().from(table).delete().eq("id", id);
  if (error) throw toError(error);
}

export async function upsert(table: string, row: Record<string, unknown>, onConflict: string): Promise<void> {
  const { error } = await sb().from(table).upsert(row, { onConflict });
  if (error) throw toError(error);
}

export async function audit(spaceId: string, entityId: string | null = null, limit = 200) {
  return rpc0<any[]>("cfo_audit", { p_space: spaceId, p_entity_id: entityId, p_limit: limit });
}

export async function getSession(): Promise<Session | null> {
  const { data } = await sb().auth.getSession();
  return data.session;
}

export function onAuth(cb: (s: Session | null) => void) {
  return sb().auth.onAuthStateChange((_e, s) => setTimeout(() => cb(s), 0));
}

export async function signIn(email: string, password: string) {
  const { error } = await sb().auth.signInWithPassword({ email, password });
  if (error) throw new ApiError(/invalid login/i.test(error.message) ? "Неверная почта или пароль" : error.message, "AUTH", 401);
}

export async function signOut() {
  await sb().auth.signOut();
}

/** Живое обновление: любое изменение данных пространства повышает его версию. */
export function subscribeVersions(spaceIds: string[], onChange: () => void) {
  const ch = sb().channel("cfo-versions");
  for (const id of spaceIds) {
    ch.on("postgres_changes", { event: "*", schema: "public", table: "cfo_space_versions", filter: `space_id=eq.${id}` }, () => onChange());
  }
  ch.subscribe();
  return () => sb().removeChannel(ch);
}
