// Состояние приложения: сессия, снимок данных, расчёты, маршрут, модальные формы.
import { useEffect, useState } from "preact/hooks";
import type { Session } from "@supabase/supabase-js";
import { todayIn } from "../shared/dates";
import type { Snapshot } from "../shared/types";
import { fromDb, type DbSnapshot } from "../modules/data/snapshot";
import { computeSummary, type Summary } from "../modules/recommendations/summary";
import * as api from "./api";
import { DEFAULT_TZ } from "./config";

export type Mode = "BUSINESS" | "PERSONAL" | "BOTH";
export type Phase = "loading" | "signin" | "not_allowed" | "ready" | "error";

export interface Sheet {
  kind: string;
  props?: Record<string, any>;
}

export interface AppState {
  phase: Phase;
  error: string | null;
  session: Session | null;
  demo: boolean;
  raw: (DbSnapshot & Record<string, any>) | null;
  s: Snapshot | null;
  summary: Summary | null;
  personalId: string | null;
  businessId: string | null;
  mode: Mode;
  route: string;
  sheets: Sheet[];
  toast: { text: string; kind: "ok" | "error" } | null;
  loadedAt: string | null;
  syncing: boolean;
}

let state: AppState = {
  phase: "loading", error: null, session: null, demo: false, raw: null, s: null, summary: null, personalId: null, businessId: null,
  mode: (localStorage.getItem("cfo-mode") as Mode) || "BUSINESS", route: location.hash.slice(1) || "today", sheets: [], toast: null, loadedAt: null, syncing: false,
};
const subs = new Set<() => void>();

export const get = () => state;
export function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  subs.forEach((f) => f());
}
export function useApp(): AppState {
  const [, force] = useState(0);
  const seen = state;
  useEffect(() => {
    const f = () => force((x) => x + 1);
    subs.add(f);
    // состояние могло измениться между рендером и подпиской
    if (state !== seen) f();
    return () => void subs.delete(f);
  }, []);
  return state;
}

export function navigate(route: string) {
  if (location.hash.slice(1) !== route) location.hash = route;
  set({ route, sheets: [] });
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", () => set({ route: location.hash.slice(1) || "today", sheets: [] }));

export function setMode(mode: Mode) {
  try { localStorage.setItem("cfo-mode", mode); } catch { /* приватный режим */ }
  set({ mode });
}

export const openSheet = (kind: string, props: Record<string, any> = {}) => set((s) => ({ sheets: [...s.sheets, { kind, props }] }));
export const closeSheet = () => set((s) => ({ sheets: s.sheets.slice(0, -1) }));

let toastTimer: any;
export function toast(text: string, kind: "ok" | "error" = "ok") {
  clearTimeout(toastTimer);
  set({ toast: { text, kind } });
  toastTimer = setTimeout(() => set({ toast: null }), kind === "error" ? 6000 : 3000);
}

export function tzOf(raw: AppState["raw"]) {
  return (raw?.spaces?.find((x: any) => x.type === "BUSINESS")?.timezone as string) || DEFAULT_TZ;
}

/** Пересчёт: снимок → модель → сводка. Один и тот же снимок даёт тот же результат. */
export function applyRaw(raw: DbSnapshot & Record<string, any>) {
  const asOf = todayIn(tzOf(raw));
  const s = fromDb(raw, asOf);
  const summary = computeSummary(s);
  const personalId = s.spaces.find((x) => x.type === "PERSONAL")?.id ?? null;
  const businessId = s.spaces.find((x) => x.type === "BUSINESS")?.id ?? null;
  set({ raw, s, summary, personalId, businessId, loadedAt: new Date().toISOString(), phase: "ready" });
  return summary;
}

let reloading: Promise<void> | null = null;
export async function reload(): Promise<void> {
  if (state.demo) return;
  if (reloading) return reloading;
  set({ syncing: true });
  reloading = (async () => {
    try {
      const raw = await api.loadSnapshot();
      const summary = applyRaw(raw);
      void recordHistory(summary);
    } catch (e: any) {
      toast(e.message ?? "Не удалось загрузить данные", "error");
    } finally {
      reloading = null;
      set({ syncing: false });
    }
  })();
  return reloading;
}

/** Раз в день сохраняем итог прогноза — для «изменения прогноза» в обзоре недели. */
async function recordHistory(summary: Summary) {
  const key = `cfo-hist-${summary.asOf}`;
  try { if (localStorage.getItem(key)) return; } catch { /* ignore */ }
  try {
    for (const sp of summary.spaces) {
      for (const f of [sp.base, sp.stress]) {
        await api.upsert("cfo_forecast_history", {
          space_id: sp.space.id, date: summary.asOf, scenario: f.scenario.id, limit_amount: f.limit === null ? null : f.limit.toString(),
          end_cash: f.endCash.toString(), min_free: f.minFree.amount.toString(), quality: f.quality.status,
        }, "space_id,date,scenario");
      }
    }
    localStorage.setItem(key, "1");
  } catch { /* не критично */ }
}

/** Обёртка изменения: ошибка сохранения не создаёт впечатления успешной записи. */
export async function mutate<T>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
  if (state.demo) {
    toast("Демо-режим: изменения не сохраняются. Войди, чтобы вести свои данные.", "error");
    return undefined;
  }
  try {
    const r = await fn();
    await reload();
    if (okText) toast(okText);
    return r;
  } catch (e: any) {
    toast(e.message ?? "Не удалось сохранить", "error");
    throw e;
  }
}

/** Выход: сессия и локальные данные этого браузера очищаются. */
export async function signOutAndReset() {
  if (!state.demo) await api.signOut().catch(() => {});
  set({ phase: "signin", demo: false, raw: null, s: null, summary: null, personalId: null, businessId: null, sheets: [], session: null });
  navigate("today");
}
