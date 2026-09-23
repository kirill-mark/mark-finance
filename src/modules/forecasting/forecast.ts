// Прогноз движения денег (F07), доступная сумма (F08), качество данных (F13).
// Детерминированно: один и тот же снимок + asOf + сценарий дают один результат.
import { addDays, addMonthsClamped, daysInMonth, diffDays, maxDate, monthEnd, monthKey, parseISO, type ISODate } from "../../shared/dates";
import type { Minor } from "../../shared/money";
import type { EconomicEffect, PaymentPlan, RecurrenceRule, Snapshot, Space, UUID } from "../../shared/types";
import { indexSnapshot, planRemaining, spaceCash, type Index } from "./ledger";

export const MAIN_HORIZON_DAYS = 90; // сегодня + 90 дней = 91 день / 13 недель
export const RECURRENCE_LOOKBACK_DAYS = 45;

export interface ScenarioParams {
  id: string;
  label: string;
  /** Сдвиг ещё не полученных клиентских поступлений (эффект SALES), дней. */
  delayIncomingDays: number;
  /** «Предварительно» (ESTIMATE) по входящим. */
  includeEstimateIncome: boolean;
  /** «Возможная сделка» (PIPELINE). */
  includePipeline: boolean;
  /** Переопределения планов: перенос даты или исключение (для симуляций). */
  planOverrides?: Record<UUID, { expectedDate?: ISODate; excluded?: boolean }>;
  extraEvents?: SimEvent[];
}

export interface SimEvent {
  key: string;
  spaceId: UUID;
  date: ISODate;
  time?: string | null;
  direction: "IN" | "OUT";
  amount: Minor; // положительная
  title: string;
  effect: EconomicEffect;
  category?: string | null;
  /** Явное использование резерва этим событием. */
  reserveId?: UUID | null;
  /** Изменение защиты R без движения денег (взнос в цель). */
  reserveDelta?: Minor;
}

export const baseScenario = (): ScenarioParams => ({ id: "BASE", label: "Базовый", delayIncomingDays: 0, includeEstimateIncome: false, includePipeline: false });
export const stressScenario = (days: number): ScenarioParams => ({
  id: "STRESS", label: `Задержка клиентов на ${days} дн.`, delayIncomingDays: days, includeEstimateIncome: false, includePipeline: false,
});
export const preliminaryScenario = (): ScenarioParams => ({
  id: "PRELIMINARY", label: "С предварительными поступлениями", delayIncomingDays: 0, includeEstimateIncome: true, includePipeline: false,
});

export type EventKind = "PLAN" | "RECURRENCE" | "BUDGET" | "RESERVE_SCHEDULE" | "SIM";

export interface ForecastEvent {
  key: string;
  kind: EventKind;
  spaceId: UUID;
  date: ISODate;
  time: string | null;
  /** Порядок внутри дня: выплаты без времени раньше, поступления без времени позже. */
  slot: number;
  deltaC: Minor;
  deltaR: Minor;
  title: string;
  effect: EconomicEffect;
  planId: UUID | null;
  ruleId: UUID | null;
  projectId: UUID | null;
  counterpartyId: UUID | null;
  category: string | null;
  overdue: boolean;
  /** Исходная дата, если событие сдвинуто сценарием или просрочкой. */
  originalDate: ISODate | null;
  certainty: PaymentPlan["certainty"] | null;
  reserveIds: UUID[];
}

export interface Point {
  date: ISODate;
  eventKey: string | null;
  C: Minor;
  R: Minor;
  free: Minor;
}

export interface DailyPoint {
  date: ISODate;
  cEnd: Minor;
  freeEnd: Minor;
  cMin: Minor;
  freeMin: Minor;
  events: number;
}

export type QualityStatus = "COMPLETE" | "PRELIMINARY" | "INSUFFICIENT";
export interface QualityIssue {
  code:
    | "NO_ACCOUNTS" | "NOT_RECONCILED" | "STALE_RECONCILIATION" | "TAX_NOT_SET" | "TAX_HORIZON_SHORT"
    | "MIN_BALANCE_NOT_SET" | "UNDATED_COSTS" | "PROJECT_END_UNKNOWN" | "IMPORT_CONFLICTS"
    | "DEPENDENT_INCOME_AT_RISK" | "OVERDUE_RECURRENCE";
  severity: "BLOCKING" | "PRELIMINARY";
  message: string;
  entityIds: UUID[];
  amount?: Minor;
}

export interface ForecastResult {
  spaceId: UUID;
  scenario: ScenarioParams;
  asOf: ISODate;
  horizonEnd: ISODate;
  decisionEnd: ISODate;
  startCash: Minor;
  startReserved: Minor;
  minBalance: Minor;
  minBalanceKnown: boolean;
  events: ForecastEvent[];
  points: Point[];
  daily: DailyPoint[];
  minFree: { amount: Minor; date: ISODate; eventKey: string | null };
  minCash: { amount: Minor; date: ISODate; eventKey: string | null };
  firstShortfall: { date: ISODate; amount: Minor; eventKey: string | null } | null;
  firstProtectedBreach: { date: ISODate; amount: Minor; eventKey: string | null } | null;
  /** Расчётный лимит новой выплаты сегодня; null — недостаточно данных. */
  limit: Minor | null;
  /** Значение лимита без учёта качества — для объяснений. */
  rawLimit: Minor;
  endCash: Minor;
  endFree: Minor;
  beyond: { out: Minor; in: Minor; count: number; firstDate: ISODate | null };
  excludedOverdueIncoming: { planId: UUID; amount: Minor; dueDate: ISODate | null; title: string }[];
  undatedCosts: { planId: UUID; amount: Minor; title: string; projectId: UUID | null }[];
  quality: { status: QualityStatus; issues: QualityIssue[] };
  assumptions: string[];
  dataVersion: number;
}

export interface ForecastOptions {
  /** Горизонт главного экрана: дней после сегодня. */
  horizonDays?: number;
  /** Продлить до окончания активных проектов (проверка решения в бизнесе). */
  extendToProjects?: boolean;
}

const PROJECT_ACTIVE = (stage: string) => stage !== "DONE" && stage !== "CANCELLED" && stage !== "IDEA";

function slotOf(direction: "IN" | "OUT" | "R", time: string | null): number {
  if (time && /^\d{2}:\d{2}$/.test(time)) {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
  }
  if (direction === "R") return -2; // взносы в резерв — в начале дня (консервативно)
  return direction === "OUT" ? -1 : 24 * 60 + 1;
}

/** Даты вхождений регулярного правила в [from, to]. */
export function recurrenceDates(rule: RecurrenceRule, from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  const end = rule.endDate && rule.endDate < to ? rule.endDate : to;
  if (end < rule.startDate) return out;
  if (rule.freq === "WEEKLY") {
    let d = rule.startDate;
    const wd = parseISO(d).getUTCDay();
    d = addDays(d, (rule.day - wd + 7) % 7);
    for (; d <= end; d = addDays(d, 7)) if (d >= from) out.push(d);
    return out;
  }
  const step = rule.freq === "MONTHLY" ? 1 : rule.freq === "QUARTERLY" ? 3 : 12;
  const baseMonth = rule.startDate.slice(0, 7) + "-01";
  for (let k = 0; k < 2000; k++) {
    const d = addMonthsClamped(baseMonth, k * step, rule.day); // 31-е в коротком месяце → последний день
    if (d > end) break;
    if (d < rule.startDate || d < from) continue;
    out.push(d);
  }
  return out;
}

function projectOf(s: Snapshot, id: UUID | null) {
  return id ? s.projects.find((p) => p.id === id) ?? null : null;
}

/** Решающий горизонт бизнеса: конец окна, окончание активных проектов, последний платёж по ним. */
export function decisionEndFor(s: Snapshot, ix: Index, space: Space, asOf: ISODate, horizonEnd: ISODate): ISODate {
  if (space.type !== "BUSINESS") return horizonEnd;
  let end = horizonEnd;
  for (const p of s.projects) {
    if (p.spaceId !== space.id || !p.inForecast || !PROJECT_ACTIVE(p.stage)) continue;
    if (p.endDate && p.endDate > end) end = p.endDate;
  }
  for (const pl of s.plans) {
    if (pl.spaceId !== space.id || !pl.projectId) continue;
    const pr = projectOf(s, pl.projectId);
    if (!pr || !pr.inForecast || !PROJECT_ACTIVE(pr.stage)) continue;
    if (planRemaining(ix, pl) === 0n) continue;
    const d = pl.expectedDate ?? pl.dueDate;
    if (d && d > end) end = d;
  }
  // страховка от бесконечных горизонтов
  const cap = addDays(asOf, 366 * 3);
  return end > cap ? cap : end;
}

/** Строит события прогноза пространства в [asOf, until]. */
export function buildEvents(
  s: Snapshot,
  ix: Index,
  space: Space,
  asOf: ISODate,
  until: ISODate,
  sc: ScenarioParams,
): {
  events: ForecastEvent[];
  beyond: ForecastResult["beyond"];
  excludedOverdueIncoming: ForecastResult["excludedOverdueIncoming"];
  undatedCosts: ForecastResult["undatedCosts"];
  overdueRecurrences: UUID[];
} {
  const events: ForecastEvent[] = [];
  const beyond = { out: 0n, in: 0n, count: 0, firstDate: null as ISODate | null };
  const excludedOverdueIncoming: ForecastResult["excludedOverdueIncoming"] = [];
  const undatedCosts: ForecastResult["undatedCosts"] = [];
  const overdueRecurrences: UUID[] = [];
  const reservesByPlan = new Map<UUID, UUID[]>();
  for (const r of [...s.reserves].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))) {
    if (r.kind === "PAYMENT_LINKED" && r.planId && !r.closed) reservesByPlan.set(r.planId, [...(reservesByPlan.get(r.planId) ?? []), r.id]);
  }

  const pushBeyond = (dir: "IN" | "OUT", amount: Minor, date: ISODate) => {
    if (dir === "OUT") beyond.out += amount;
    else beyond.in += amount;
    beyond.count++;
    if (!beyond.firstDate || date < beyond.firstDate) beyond.firstDate = date;
  };

  const place = (args: {
    key: string; kind: EventKind; dir: "IN" | "OUT"; amount: Minor; date: ISODate | null; time: string | null; title: string;
    effect: EconomicEffect; planId: UUID | null; ruleId: UUID | null; projectId: UUID | null; counterpartyId: UUID | null;
    category: string | null; certainty: PaymentPlan["certainty"] | null; dueDate: ISODate | null;
  }) => {
    let date = args.date;
    let overdue = false;
    let originalDate: ISODate | null = null;
    if (!date) return;
    if (date < asOf) {
      if (args.dir === "OUT") {
        originalDate = date;
        date = asOf; // просроченная выплата без новой даты — сегодня (F03)
        overdue = true;
      } else {
        // просроченное поступление без новой даты — вне прогноза, требует уточнения (T29)
        if (args.planId) excludedOverdueIncoming.push({ planId: args.planId, amount: args.amount, dueDate: args.dueDate ?? args.date, title: args.title });
        return;
      }
    }
    if (args.dir === "IN" && args.effect === "SALES" && sc.delayIncomingDays > 0) {
      originalDate = originalDate ?? date;
      date = addDays(date, sc.delayIncomingDays);
    }
    if (args.dueDate && args.dueDate < asOf) overdue = true;
    if (date > until) {
      pushBeyond(args.dir, args.amount, date);
      return;
    }
    events.push({
      key: args.key, kind: args.kind, spaceId: space.id, date, time: args.time, slot: slotOf(args.dir, args.time),
      deltaC: args.dir === "IN" ? args.amount : -args.amount, deltaR: 0n, title: args.title, effect: args.effect,
      planId: args.planId, ruleId: args.ruleId, projectId: args.projectId, counterpartyId: args.counterpartyId,
      category: args.category, overdue, originalDate, certainty: args.certainty,
      reserveIds: args.planId ? reservesByPlan.get(args.planId) ?? [] : [],
    });
  };

  const includeCertainty = (dir: "IN" | "OUT", c: PaymentPlan["certainty"]) => {
    if (c === "PIPELINE") return sc.includePipeline;
    if (c === "ESTIMATE" && dir === "IN") return sc.includeEstimateIncome;
    return true; // CONTRACTED и расходные ESTIMATE утверждённого плана — обязательны
  };

  // 1. Платёжные планы
  const materialized = new Set<string>();
  for (const p of s.plans) {
    if (p.spaceId !== space.id) continue;
    if (p.recurrenceRuleId && p.occurrenceDate) materialized.add(`${p.recurrenceRuleId}:${p.occurrenceDate}`);
    if (p.cancelledAt || !p.inForecast) continue;
    const ov = sc.planOverrides?.[p.id];
    if (ov?.excluded) continue;
    const pr = projectOf(s, p.projectId);
    if (pr && (!pr.inForecast || pr.stage === "CANCELLED" || pr.stage === "IDEA")) continue; // черновые идеи не в прогнозе
    if (!includeCertainty(p.direction, p.certainty)) continue;
    const rem = planRemaining(ix, p);
    if (rem === 0n) continue;
    const date = ov?.expectedDate ?? p.expectedDate ?? p.dueDate;
    if (!date) {
      if (p.direction === "OUT") undatedCosts.push({ planId: p.id, amount: rem, title: p.title, projectId: p.projectId });
      continue;
    }
    // Если дата перенесена сценарием/пользователем в будущее — это уже не «сегодня» по просрочке
    place({
      key: `plan:${p.id}`, kind: "PLAN", dir: p.direction, amount: rem, date, time: p.expectedTime, title: p.title,
      effect: p.effect, planId: p.id, ruleId: null, projectId: p.projectId, counterpartyId: p.counterpartyId,
      category: p.category, certainty: p.certainty, dueDate: p.dueDate,
    });
  }

  // 2. Регулярные правила — отдельные события с ключом правила и даты
  for (const r of s.recurrences) {
    if (r.spaceId !== space.id || !r.active) continue;
    const t = r.template;
    if (!includeCertainty(t.direction, t.certainty)) continue;
    const lookFrom = addDays(asOf, -RECURRENCE_LOOKBACK_DAYS);
    for (const d of recurrenceDates(r, lookFrom, maxDate(until, addDays(asOf, 366 * 3)))) {
      if (materialized.has(`${r.id}:${d}`)) continue;
      if (d < asOf) {
        // Прошедшее вхождение без отметки об оплате: выплата — сегодня, поступление — требует уточнения
        if (t.direction === "OUT") overdueRecurrences.push(r.id);
        else {
          excludedOverdueIncoming.push({ planId: `rec:${r.id}:${d}`, amount: t.amount, dueDate: d, title: t.title });
          continue;
        }
      }
      if (d > until) {
        if (d <= addDays(until, 366)) pushBeyond(t.direction, t.amount, d);
        continue;
      }
      place({
        key: `rec:${r.id}:${d}`, kind: "RECURRENCE", dir: t.direction, amount: t.amount, date: d, time: t.expectedTime,
        title: t.title, effect: t.effect, planId: null, ruleId: r.id, projectId: t.projectId, counterpartyId: t.counterpartyId,
        category: t.category, certainty: t.certainty, dueDate: d,
      });
    }
  }

  // 3. Дополнительные события симуляции
  for (const e of sc.extraEvents ?? []) {
    if (e.spaceId !== space.id) continue;
    if (e.amount === 0n && e.reserveDelta) {
      if (e.date <= until) events.push(reserveOnlyEvent(space.id, e.key, e.date, e.reserveDelta, e.title, e.reserveId ?? null));
      continue;
    }
    place({
      key: e.key, kind: "SIM", dir: e.direction, amount: e.amount, date: e.date, time: e.time ?? null, title: e.title,
      effect: e.effect, planId: null, ruleId: null, projectId: null, counterpartyId: null, category: e.category ?? null,
      certainty: "CONTRACTED", dueDate: e.date,
    });
    const last = events[events.length - 1];
    if (last && last.key === e.key && e.reserveId) last.reserveIds = [e.reserveId];
  }

  // 4. Утверждённые будущие взносы в резерв: меняют R, не C (T27)
  for (const sch of s.reserveSchedules) {
    if (sch.status !== "PLANNED") continue;
    const res = s.reserves.find((r) => r.id === sch.reserveId);
    if (!res || res.spaceId !== space.id || res.closed) continue;
    const d = sch.date < asOf ? asOf : sch.date;
    if (d > until) continue;
    events.push(reserveOnlyEvent(space.id, `rsch:${sch.id}`, d, sch.amount, `Взнос в резерв «${res.purpose}»`, res.id));
  }

  // 5. Личный переменный бюджет, распределённый по дням (F10)
  if (space.type === "PERSONAL") events.push(...budgetEvents(s, ix, space, asOf, until, events));

  return { events, beyond, excludedOverdueIncoming, undatedCosts, overdueRecurrences };
}

function reserveOnlyEvent(spaceId: UUID, key: string, date: ISODate, delta: Minor, title: string, reserveId: UUID | null): ForecastEvent {
  return {
    key, kind: "RESERVE_SCHEDULE", spaceId, date, time: null, slot: slotOf("R", null), deltaC: 0n, deltaR: delta, title,
    effect: "NONE", planId: null, ruleId: null, projectId: null, counterpartyId: null, category: null, overdue: false,
    originalDate: null, certainty: null, reserveIds: reserveId ? [reserveId] : [],
  };
}

/** Лимит категории на месяц: месячная запись важнее шаблона. */
export function budgetFor(s: Snapshot, spaceId: UUID, month: string) {
  const map = new Map<string, Snapshot["budgets"][number]>();
  for (const b of s.budgets) if (b.spaceId === spaceId && b.month === null) map.set(b.category, b);
  for (const b of s.budgets) if (b.spaceId === spaceId && b.month === month) map.set(b.category, b);
  return [...map.values()];
}

/** Фактические траты категории за месяц (по проведённым операциям личного пространства). */
export function actualSpent(s: Snapshot, ix: Index, spaceId: UUID, category: string, month: string): Minor {
  let spent = 0n;
  for (const t of s.transactions) {
    if (t.spaceId !== spaceId || t.category !== category || monthKey(t.occurredOn) !== month) continue;
    for (const e of s.entries) if (e.transactionId === t.id) spent -= e.amount;
  }
  return spent;
}

/**
 * Остаток категории месяца = лимит − факт − уже запланированные неоплаченные траты этой категории.
 * Для прогноза распределяем max(0, остаток) равномерно по оставшимся дням месяца; копейки — в последний день.
 */
function budgetEvents(s: Snapshot, ix: Index, space: Space, asOf: ISODate, until: ISODate, planned: ForecastEvent[]): ForecastEvent[] {
  const out: ForecastEvent[] = [];
  let month = monthKey(asOf);
  const lastMonth = monthKey(until);
  while (month <= lastMonth) {
    const mStart = month + "-01";
    const mEnd = monthEnd(mStart);
    const from = month === monthKey(asOf) ? asOf : mStart;
    for (const b of budgetFor(s, space.id, month)) {
      if (b.kind !== "VARIABLE") continue;
      const actual = month === monthKey(asOf) ? actualSpent(s, ix, space.id, b.category, month) : 0n;
      let plannedCat = 0n;
      for (const e of planned) if (e.category === b.category && monthKey(e.date) === month && e.deltaC < 0n) plannedCat -= e.deltaC;
      let rem = b.limit - actual - plannedCat;
      if (rem <= 0n) continue;
      const n = BigInt(diffDays(from, mEnd) + 1);
      const per = rem / n;
      const last = rem - per * (n - 1n);
      for (let i = 0n; i < n; i++) {
        const d = addDays(from, Number(i));
        const amt = i === n - 1n ? last : per;
        if (amt === 0n || d > until) continue;
        out.push({
          key: `budget:${b.category}:${d}`, kind: "BUDGET", spaceId: space.id, date: d, time: null, slot: slotOf("OUT", null),
          deltaC: -amt, deltaR: 0n, title: `Бюджет: ${b.category}`, effect: "PERSONAL_CONSUMPTION", planId: null, ruleId: null,
          projectId: null, counterpartyId: null, category: b.category, overdue: false, originalDate: null, certainty: "ESTIMATE", reserveIds: [],
        });
      }
    }
    month = monthKey(addMonthsClamped(mStart, 1));
  }
  return out;
}

export function qualityFor(
  s: Snapshot, ix: Index, space: Space, asOf: ISODate, horizonEnd: ISODate,
  built: { undatedCosts: ForecastResult["undatedCosts"]; overdueRecurrences: UUID[] },
): { status: QualityStatus; issues: QualityIssue[] } {
  const issues: QualityIssue[] = [];
  const accounts = s.accounts.filter((a) => a.spaceId === space.id && !a.archived);
  if (!accounts.length) issues.push({ code: "NO_ACCOUNTS", severity: "BLOCKING", message: "Нет ни одного счёта с остатком", entityIds: [] });
  const notRec = accounts.filter((a) => !a.reconciledAt);
  if (notRec.length) issues.push({ code: "NOT_RECONCILED", severity: "BLOCKING", message: `Остатки не сверены: ${notRec.map((a) => a.name).join(", ")}`, entityIds: notRec.map((a) => a.id) });
  const stale = accounts.filter((a) => a.reconciledAt && diffDays(a.reconciledAt, asOf) > space.reconcileStaleDays);
  if (stale.length) issues.push({ code: "STALE_RECONCILIATION", severity: "PRELIMINARY", message: `Сверка старше ${space.reconcileStaleDays} дней: ${stale.map((a) => a.name).join(", ")}`, entityIds: stale.map((a) => a.id) });
  if (space.taxStatus !== "ENTERED") {
    issues.push({ code: "TAX_NOT_SET", severity: "BLOCKING", message: space.taxStatus === "PENDING" ? "Налоговый расчёт ожидается — суммы не внесены" : "Налоги не настроены — это не 0 ₽", entityIds: [space.id] });
  } else if (!space.taxHorizonUntil || space.taxHorizonUntil < horizonEnd) {
    issues.push({ code: "TAX_HORIZON_SHORT", severity: "PRELIMINARY", message: space.taxHorizonUntil ? `Налоги внесены только до ${space.taxHorizonUntil}` : "Не указано, до какой даты внесены налоги", entityIds: [space.id] });
  }
  if (space.minBalance === null) issues.push({ code: "MIN_BALANCE_NOT_SET", severity: "BLOCKING", message: "Не задан минимальный остаток", entityIds: [space.id] });
  if (built.undatedCosts.length) {
    const amount = built.undatedCosts.reduce((a, b) => a + b.amount, 0n);
    issues.push({ code: "UNDATED_COSTS", severity: "BLOCKING", message: `У ${built.undatedCosts.length} неоплаченных затрат нет даты платежа`, entityIds: built.undatedCosts.map((u) => u.planId), amount });
  }
  if (space.type === "BUSINESS") {
    const noEnd = s.projects.filter((p) => p.spaceId === space.id && p.inForecast && PROJECT_ACTIVE(p.stage) && !p.endDate);
    if (noEnd.length) issues.push({ code: "PROJECT_END_UNKNOWN", severity: "PRELIMINARY", message: `Не указано окончание: ${noEnd.map((p) => p.name).join(", ")}`, entityIds: noEnd.map((p) => p.id) });
  }
  const conflicts = s.importConflicts.filter((c) => c.spaceId === space.id && c.status === "OPEN");
  if (conflicts.length) issues.push({ code: "IMPORT_CONFLICTS", severity: "BLOCKING", message: `Неразобранные строки импорта: ${conflicts.length}`, entityIds: conflicts.map((c) => c.id) });
  if (built.overdueRecurrences.length) {
    const ids = [...new Set(built.overdueRecurrences)];
    issues.push({ code: "OVERDUE_RECURRENCE", severity: "PRELIMINARY", message: "Есть регулярные платежи без отметки об оплате — считаю их неоплаченными сегодня", entityIds: ids });
  }
  const status: QualityStatus = issues.some((i) => i.severity === "BLOCKING") ? "INSUFFICIENT" : issues.length ? "PRELIMINARY" : "COMPLETE";
  return { status, issues };
}

export function forecastSpace(
  s: Snapshot, spaceId: UUID, sc: ScenarioParams, opts: ForecastOptions = {}, ix: Index = indexSnapshot(s),
): ForecastResult {
  const space = s.spaces.find((x) => x.id === spaceId);
  if (!space) throw new Error("Пространство не найдено");
  const asOf = s.asOf;
  const horizonEnd = addDays(asOf, opts.horizonDays ?? MAIN_HORIZON_DAYS);
  const decisionEnd = opts.extendToProjects === false ? horizonEnd : decisionEndFor(s, ix, space, asOf, horizonEnd);
  const built = buildEvents(s, ix, space, asOf, decisionEnd, sc);
  const events = built.events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.slot - b.slot || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));

  const startCash = spaceCash(ix, space.id);
  const reserveBal = new Map<UUID, Minor>();
  let R = 0n;
  for (const r of s.reserves) {
    if (r.spaceId !== space.id) continue;
    const b = ix.reserveBalance.get(r.id) ?? 0n;
    reserveBal.set(r.id, b);
    R += b;
  }
  const startReserved = R;
  const B = space.minBalance ?? 0n;
  let C = startCash;
  const points: Point[] = [{ date: asOf, eventKey: null, C, R, free: C - R - B }];
  for (const ev of events) {
    C += ev.deltaC;
    // Оплата зарезервированного обязательства уменьшает C и связанный R одновременно (F08)
    if (ev.deltaC < 0n && ev.reserveIds.length) {
      let toCover = -ev.deltaC;
      for (const rid of ev.reserveIds) {
        if (toCover <= 0n) break;
        const bal = reserveBal.get(rid) ?? 0n;
        const take = bal < toCover ? bal : toCover;
        if (take <= 0n) continue;
        reserveBal.set(rid, bal - take);
        R -= take;
        toCover -= take;
      }
    }
    if (ev.deltaR !== 0n) {
      R += ev.deltaR;
      const rid = ev.reserveIds[0];
      if (rid) reserveBal.set(rid, (reserveBal.get(rid) ?? 0n) + ev.deltaR);
    }
    points.push({ date: ev.date, eventKey: ev.key, C, R, free: C - R - B });
  }

  let minFree = points[0];
  let minCash = points[0];
  let firstShortfall: ForecastResult["firstShortfall"] = null;
  let firstProtectedBreach: ForecastResult["firstProtectedBreach"] = null;
  for (const p of points) {
    if (p.free < minFree.free) minFree = p;
    if (p.C < minCash.C) minCash = p;
    if (!firstShortfall && p.C < 0n) firstShortfall = { date: p.date, amount: p.C, eventKey: p.eventKey };
    if (!firstProtectedBreach && p.free < 0n && p.C >= 0n) firstProtectedBreach = { date: p.date, amount: p.free, eventKey: p.eventKey };
  }

  // Дневной ряд для графика главного окна
  const daily: DailyPoint[] = [];
  let pi = 0;
  let cur = points[0];
  for (let d = asOf; d <= horizonEnd; d = addDays(d, 1)) {
    let cMin = cur.C;
    let freeMin = cur.free;
    let n = 0;
    while (pi + 1 < points.length && points[pi + 1].date === d) {
      pi++;
      cur = points[pi];
      n++;
      if (cur.C < cMin) cMin = cur.C;
      if (cur.free < freeMin) freeMin = cur.free;
    }
    daily.push({ date: d, cEnd: cur.C, freeEnd: cur.free, cMin, freeMin, events: n });
  }

  const quality = qualityFor(s, ix, space, asOf, horizonEnd, built);
  const rawLimit = minFree.free > 0n ? minFree.free : 0n;
  const assumptions = [
    "Выплаты без указанного времени считаются раньше поступлений того же дня.",
    "Просроченные выплаты без новой даты поставлены на сегодня.",
    "Просроченные поступления без новой ожидаемой даты в прогноз не включены.",
    sc.delayIncomingDays ? `Ещё не полученные клиентские оплаты сдвинуты на ${sc.delayIncomingDays} дн.` : "Клиентские оплаты — по ожидаемым датам.",
    sc.includeEstimateIncome ? "Включены предварительные поступления." : "Учитываются только поступления по договору.",
  ];
  if (space.type === "BUSINESS" && decisionEnd > horizonEnd) assumptions.push(`Для решений расчёт продлён до ${decisionEnd} — окончания активных проектов и их платежей.`);

  return {
    spaceId, scenario: sc, asOf, horizonEnd, decisionEnd, startCash, startReserved, minBalance: B, minBalanceKnown: space.minBalance !== null,
    events, points, daily,
    minFree: { amount: minFree.free, date: minFree.date, eventKey: minFree.eventKey },
    minCash: { amount: minCash.C, date: minCash.date, eventKey: minCash.eventKey },
    firstShortfall, firstProtectedBreach,
    limit: quality.status === "INSUFFICIENT" ? null : rawLimit,
    rawLimit,
    endCash: C, endFree: C - R - B,
    beyond: built.beyond, excludedOverdueIncoming: built.excludedOverdueIncoming, undatedCosts: built.undatedCosts,
    quality, assumptions, dataVersion: space.dataVersion,
  };
}

/** Состояние (C, R, free) непосредственно перед датой d — для «минимум начиная с даты выплаты». */
export function minFreeFrom(f: ForecastResult, from: ISODate): { amount: Minor; date: ISODate } {
  let before = f.points[0];
  for (const p of f.points) if (p.date < from) before = p;
  let m = { amount: before.free, date: from };
  for (const p of f.points) if (p.date >= from && p.free < m.amount) m = { amount: p.free, date: p.date };
  return m;
}

export const daysBetween = diffDays;
export { daysInMonth };
