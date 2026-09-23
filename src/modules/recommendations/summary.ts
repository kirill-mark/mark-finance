// Сводка «Сегодня» и правила рекомендаций (5.1, 9.3).
// Все выводы строятся из того же расчётного модуля, что и симуляции.
import { addDays, diffDays, formatDate, type ISODate } from "../../shared/dates";
import { formatRub, type Minor } from "../../shared/money";
import type { Snapshot, Space, UUID } from "../../shared/types";
import {
  baseScenario, forecastSpace, preliminaryScenario, stressScenario,
  type ForecastEvent, type ForecastResult, type QualityIssue,
} from "../forecasting/forecast";
import { indexSnapshot, isOverdue, planRemaining, type Index } from "../forecasting/ledger";
import { personalView, type PersonalView } from "../forecasting/personal";
import { projectEconomics } from "../forecasting/projects";

export type RecKind =
  | "SHORTFALL" | "PROTECTED_BREACH" | "OVERDUE_OUT" | "OVERDUE_IN" | "OUT_SOON" | "DATA_GAP"
  | "OVER_BUDGET" | "MARGIN_DROP" | "BEYOND_WINDOW" | "DEPENDENT_INCOME";

export interface Recommendation {
  fingerprint: string;
  kind: RecKind;
  rank: number;
  spaceId: UUID;
  title: string;
  detail: string;
  amount: Minor | null;
  date: ISODate | null;
  action: { label: string; route: string; entityId?: UUID };
  facts: string[];
}

export interface SpaceSummary {
  space: Space;
  base: ForecastResult;
  stress: ForecastResult;
  preliminary: ForecastResult;
  quality: { status: ForecastResult["quality"]["status"]; issues: QualityIssue[] };
  cash: Minor;
  reserved: Minor;
  minBalance: Minor | null;
  next7: ForecastEvent[];
  overdueIncoming: ForecastResult["excludedOverdueIncoming"];
  personal: PersonalView | null;
  recommendations: Recommendation[];
}

export interface Summary {
  asOf: ISODate;
  spaces: SpaceSummary[];
  recommendations: Recommendation[];
  ix: Index;
}

const RANK = { SHORTFALL: 1, PROTECTED_BREACH: 1.5, OVERDUE_OUT: 2, OVERDUE_IN: 2.2, DEPENDENT_INCOME: 2.4, OUT_SOON: 3, BEYOND_WINDOW: 3.5, DATA_GAP: 4, OVER_BUDGET: 5, MARGIN_DROP: 5.2 } as const;

function withDependencyRisk(f: ForecastResult, issue: QualityIssue): ForecastResult {
  const issues = [...f.quality.issues, issue];
  const status = f.quality.status === "INSUFFICIENT" ? "INSUFFICIENT" : "PRELIMINARY";
  return { ...f, quality: { status, issues }, limit: status === "INSUFFICIENT" ? null : f.limit };
}

export function computeSummary(s: Snapshot): Summary {
  const ix = indexSnapshot(s);
  const out: SpaceSummary[] = [];
  const order = [...s.spaces].sort((a, b) => (a.type === "BUSINESS" ? -1 : 1) - (b.type === "BUSINESS" ? -1 : 1));
  let businessStress: ForecastResult | null = null;
  for (const space of order) {
    let base = forecastSpace(s, space.id, baseScenario(), {}, ix);
    let stress = forecastSpace(s, space.id, stressScenario(space.stressDelayDays), {}, ix);
    const preliminary = forecastSpace(s, space.id, preliminaryScenario(), {}, ix);
    if (space.type === "BUSINESS") businessStress = stress;
    let personal: PersonalView | null = null;
    if (space.type === "PERSONAL") {
      personal = personalView(s, ix, space.id, base, businessStress);
      const risky = personal.payouts.filter((p) => p.atRisk);
      if (risky.length) {
        const issue: QualityIssue = {
          code: "DEPENDENT_INCOME_AT_RISK", severity: "PRELIMINARY",
          message: "Ожидаемая выплата из бизнеса под угрозой: в продакшне раньше неё нехватка денег",
          entityIds: risky.map((r) => r.plan.id), amount: risky.reduce((a, r) => a + r.remaining, 0n),
        };
        base = withDependencyRisk(base, issue);
        stress = withDependencyRisk(stress, issue);
      }
    }
    const next7End = addDays(s.asOf, 7);
    const next7 = base.events
      .filter((e) => e.date <= next7End && e.kind !== "BUDGET")
      .sort((a, b) => (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1));
    const sum: SpaceSummary = {
      space, base, stress, preliminary, quality: stress.quality,
      cash: base.startCash, reserved: base.startReserved, minBalance: space.minBalance,
      next7, overdueIncoming: base.excludedOverdueIncoming, personal, recommendations: [],
    };
    sum.recommendations = recommendationsFor(s, ix, sum);
    out.push(sum);
  }
  const all = out.flatMap((x) => x.recommendations).sort((a, b) => a.rank - b.rank || (a.date ?? "9") .localeCompare(b.date ?? "9"));
  return { asOf: s.asOf, spaces: out, recommendations: all, ix };
}

export function recommendationsFor(s: Snapshot, ix: Index, sm: SpaceSummary): Recommendation[] {
  const recs: Recommendation[] = [];
  const { space, base, stress } = sm;
  const today = s.asOf;
  const add = (r: Omit<Recommendation, "rank" | "spaceId">) => recs.push({ ...r, rank: RANK[r.kind], spaceId: space.id });
  const who = space.type === "BUSINESS" ? "в продакшне" : "в личных деньгах";

  // 1. Нехватка денег
  const shortfall = base.firstShortfall ?? stress.firstShortfall;
  if (shortfall) {
    const inBase = !!base.firstShortfall;
    const ev = (inBase ? base : stress).events.find((e) => e.key === shortfall.eventKey);
    const days = diffDays(today, shortfall.date);
    add({
      fingerprint: `SHORTFALL:${space.id}:${shortfall.date}:${shortfall.amount}:${inBase ? "B" : "S"}`,
      kind: "SHORTFALL",
      title: inBase
        ? `Не хватит ${formatRub(-shortfall.amount)} ${days <= 0 ? "сегодня" : formatDate(shortfall.date, today)}`
        : `Если клиенты задержат оплату на ${space.stressDelayDays} дн., не хватит ${formatRub(-shortfall.amount)}`,
      detail: ev ? `${formatDate(shortfall.date, today)}: «${ev.title}» ${formatRub(ev.deltaC, { sign: true })} ${who}` : who,
      amount: -shortfall.amount, date: shortfall.date,
      action: { label: "Открыть платежи", route: `calendar?date=${shortfall.date}&space=${space.id}` },
      facts: [`Остаток сейчас ${formatRub(base.startCash)}`, `Первая нехватка ${shortfall.date}`],
    });
  } else {
    const breach = base.firstProtectedBreach ?? stress.firstProtectedBreach;
    if (breach) {
      add({
        fingerprint: `PROTECTED:${space.id}:${breach.date}:${breach.amount}`,
        kind: "PROTECTED_BREACH",
        title: `${formatDate(breach.date, today)} будут затронуты защищённые деньги`,
        detail: `Свободный остаток уйдёт до ${formatRub(breach.amount)} — посмотри, на что назначены резервы и минимальный остаток`,
        amount: -breach.amount, date: breach.date,
        action: { label: "Резервы", route: `reserves?space=${space.id}` }, facts: [],
      });
    }
  }

  // 2. Просроченные обязательства и поступления
  for (const p of s.plans) {
    if (p.spaceId !== space.id || p.direction !== "OUT" || !isOverdue(ix, p, today)) continue;
    add({
      fingerprint: `OVERDUE_OUT:${p.id}:${p.dueDate}:${planRemaining(ix, p)}`,
      kind: "OVERDUE_OUT",
      title: `Просрочена выплата: ${p.title}`,
      detail: `${formatRub(planRemaining(ix, p))}, срок был ${formatDate(p.dueDate, today)}`,
      amount: planRemaining(ix, p), date: p.dueDate,
      action: { label: "Отметить оплату", route: `plan/${p.id}`, entityId: p.id }, facts: [],
    });
  }
  for (const o of base.excludedOverdueIncoming) {
    add({
      fingerprint: `OVERDUE_IN:${o.planId}:${o.dueDate}:${o.amount}`,
      kind: "OVERDUE_IN",
      title: `Не пришла оплата: ${o.title}`,
      detail: `${formatRub(o.amount)} ожидались ${formatDate(o.dueDate, today)}. В прогноз не включены — уточни новую дату.`,
      amount: o.amount, date: o.dueDate,
      action: { label: "Уточнить дату", route: o.planId.startsWith("rec:") ? `calendar` : `plan/${o.planId}`, entityId: o.planId }, facts: [],
    });
  }

  // 3. Ближайшие выплаты (3 дня)
  for (const e of base.events) {
    if (e.deltaC >= 0n || e.overdue || e.kind === "BUDGET") continue;
    const k = diffDays(today, e.date);
    if (k < 0 || k > 3) continue;
    add({
      fingerprint: `OUT_SOON:${e.key}:${e.date}:${e.deltaC}`,
      kind: "OUT_SOON",
      title: `${k === 0 ? "Сегодня" : k === 1 ? "Завтра" : `Через ${k} дня`} оплатить ${formatRub(-e.deltaC)}`,
      detail: e.title,
      amount: -e.deltaC, date: e.date,
      action: { label: "Открыть", route: e.planId ? `plan/${e.planId}` : "calendar", entityId: e.planId ?? undefined }, facts: [],
    });
  }

  // Риск за окном 13 недель (T23)
  if (space.type === "BUSINESS" && stress.decisionEnd > stress.horizonEnd) {
    const late = stress.points.find((p) => p.date > stress.horizonEnd && p.free < 0n);
    if (late) {
      add({
        fingerprint: `BEYOND:${space.id}:${late.date}:${late.free}`,
        kind: "BEYOND_WINDOW",
        title: `За окном 13 недель: нехватка ${formatDate(late.date, today)}`,
        detail: `Выплаты проектов после ${formatDate(stress.horizonEnd, today)} не покрыты на ${formatRub(-late.free)}; эти деньги нельзя считать свободными`,
        amount: -late.free, date: late.date,
        action: { label: "Проекты", route: "projects" }, facts: [],
      });
    }
  }

  // Зависимое поступление из бизнеса
  for (const p of sm.personal?.payouts ?? []) {
    if (!p.atRisk) continue;
    add({
      fingerprint: `DEP:${p.plan.id}:${p.plan.expectedDate ?? p.plan.dueDate}`,
      kind: "DEPENDENT_INCOME",
      title: `Выплата из продакшна под угрозой: ${formatRub(p.remaining)}`,
      detail: p.riskNote + ". Не планируй траты под неё, пока не выберешь реальную дату.",
      amount: p.remaining, date: p.plan.expectedDate ?? p.plan.dueDate,
      action: { label: "Перенести дату", route: `plan/${p.plan.id}`, entityId: p.plan.id }, facts: [],
    });
  }

  // 4. Неполные данные
  for (const i of stress.quality.issues) {
    if (i.code === "DEPENDENT_INCOME_AT_RISK") continue;
    add({
      fingerprint: `GAP:${space.id}:${i.code}:${i.entityIds.join(",")}`,
      kind: "DATA_GAP",
      title: i.message,
      detail: i.severity === "BLOCKING" ? "Без этого доступная сумма не рассчитывается" : "Расчёт предварительный",
      amount: i.amount ?? null, date: null,
      action: gapAction(i, space), facts: [],
    });
  }

  // 5. Проекты: перерасход и снижение маржи
  if (space.type === "BUSINESS") {
    for (const pr of s.projects.filter((p) => p.spaceId === space.id && p.stage !== "CANCELLED")) {
      const e = projectEconomics(s, ix, pr.id);
      if (e.original > 0n && e.variance > 0n) {
        const worst = [...e.lines].sort((a, b) => (b.variance > a.variance ? 1 : -1))[0];
        add({
          fingerprint: `OVER:${pr.id}:${e.variance}`,
          kind: "OVER_BUDGET",
          title: `${pr.name}: прогноз затрат выше сметы на ${formatRub(e.variance)}`,
          detail: worst && worst.variance > 0n ? `Больше всего — «${worst.category}»: ${formatRub(worst.variance, { sign: true })}` : "",
          amount: e.variance, date: null,
          action: { label: "Смета", route: `project/${pr.id}?tab=budget`, entityId: pr.id }, facts: [],
        });
      }
      if (e.margin !== null && e.plannedMargin !== null && e.margin < e.plannedMargin) {
        add({
          fingerprint: `MARGIN:${pr.id}:${e.margin}`,
          kind: "MARGIN_DROP",
          title: `${pr.name}: оценка маржи снизилась на ${formatRub(e.plannedMargin - e.margin)}`,
          detail: `По смете ${formatRub(e.plannedMargin)}, сейчас ${formatRub(e.margin)} — по введённым суммам`,
          amount: e.plannedMargin - e.margin, date: null,
          action: { label: "Проект", route: `project/${pr.id}`, entityId: pr.id }, facts: [],
        });
      }
    }
  }
  return recs.sort((a, b) => a.rank - b.rank);
}

function gapAction(i: QualityIssue, space: Space): Recommendation["action"] {
  switch (i.code) {
    case "NO_ACCOUNTS":
    case "NOT_RECONCILED":
    case "STALE_RECONCILIATION":
      return { label: "Сверить остатки", route: `accounts?space=${space.id}` };
    case "TAX_NOT_SET":
    case "TAX_HORIZON_SHORT":
    case "MIN_BALANCE_NOT_SET":
      return { label: "Настройки", route: `settings?space=${space.id}` };
    case "UNDATED_COSTS":
      return { label: "Указать даты", route: "calendar?undated=1" };
    case "PROJECT_END_UNKNOWN":
      return { label: "Проекты", route: "projects" };
    case "IMPORT_CONFLICTS":
      return { label: "Импорт", route: "import" };
    default:
      return { label: "Открыть", route: "calendar" };
  }
}

export const QUALITY_TEXT = {
  COMPLETE: "Данных достаточно для расчёта",
  PRELIMINARY: "Предварительно",
  INSUFFICIENT: "Недостаточно данных",
} as const;
