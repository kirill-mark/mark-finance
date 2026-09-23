// Симуляция решения (F09): копия модели в памяти + события → базовый и стресс-сценарии.
// Рабочие данные не меняются (T15).
import { addDays, formatDate, type ISODate } from "../../shared/dates";
import { formatRub, type Minor } from "../../shared/money";
import type { ClaimBasis, EconomicEffect, Snapshot, UUID } from "../../shared/types";
import {
  baseScenario, forecastSpace, minFreeFrom, stressScenario,
  type ForecastResult, type QualityIssue, type ScenarioParams, type SimEvent,
} from "./forecast";
import { indexSnapshot, planRemaining, reserveBalanceNow, type Index } from "./ledger";
import { claimsSummary } from "./partners";

export type Verdict = "WITHIN_LIMIT" | "SHORTFALL" | "NEEDS_DATA";
export const VERDICT_TEXT: Record<Verdict, string> = {
  WITHIN_LIMIT: "В пределах расчётного лимита",
  SHORTFALL: "Возникнет нехватка",
  NEEDS_DATA: "Нужно уточнение",
};

export type PayoutBasis = ClaimBasis | "NONE";

export interface Decision {
  spaceId: UUID;
  kind: "EXPENSE" | "OWNER_PAYOUT" | "INVESTMENT" | "RESCHEDULE" | "INCOME";
  amount: Minor;
  date: ISODate;
  title: string;
  effect?: EconomicEffect;
  category?: string | null;
  /** Явно выбранный резерв, из которого разрешено взять деньги. */
  reserveId?: UUID | null;
  /** Основание выплаты себе. */
  basis?: PayoutBasis;
  /** Перенос существующего плана вместо новой выплаты (T14). */
  movePlanId?: UUID | null;
  /** График: количество платежей и шаг в месяцах (для вложения). */
  installments?: { count: number; everyMonths: number } | null;
}

export interface SimReason {
  code: string;
  message: string;
  date?: ISODate;
  amount?: Minor;
  planIds?: UUID[];
}

export interface ScenarioCompare {
  scenario: ScenarioParams;
  before: ForecastResult;
  after: ForecastResult;
}

export interface SimulationResult {
  decision: Decision;
  verdict: Verdict;
  base: ScenarioCompare;
  stress: ScenarioCompare;
  /** Для выплаты себе — эффект в личном пространстве. */
  personal: ScenarioCompare | null;
  /** Максимум на выбранную дату при этих условиях (стресс), null — недостаточно данных. */
  maxOnDate: Minor | null;
  maxOnDateBase: Minor | null;
  /** Лимит по основанию выплаты (остаток утверждённой суммы). */
  basisLimit: Minor | null;
  firstRiskDate: ISODate | null;
  alternativeDate: ISODate | null;
  alternativeSearched: boolean;
  preexistingDeficit: { date: ISODate; amount: Minor } | null;
  reasons: SimReason[];
  missingData: QualityIssue[];
  dataVersion: number;
}

const EFFECT_BY_BASIS: Record<PayoutBasis, EconomicEffect> = {
  FEE: "OVERHEAD_COST",
  REIMBURSEMENT: "REIMBURSEMENT",
  LOAN: "FINANCING",
  DISTRIBUTION: "PROFIT_DISTRIBUTION",
  NONE: "NONE",
};

function decisionEvents(s: Snapshot, d: Decision): { events: SimEvent[]; overrides: ScenarioParams["planOverrides"] } {
  if (d.kind === "RESCHEDULE" && d.movePlanId) return { events: [], overrides: { [d.movePlanId]: { expectedDate: d.date } } };
  const events: SimEvent[] = [];
  const dir = d.kind === "INCOME" ? "IN" : "OUT";
  const effect = d.effect ?? (d.kind === "OWNER_PAYOUT" ? EFFECT_BY_BASIS[d.basis ?? "NONE"] : d.kind === "INVESTMENT" ? "OVERHEAD_COST" : "NONE");
  const n = d.installments && d.installments.count > 1 ? d.installments.count : 1;
  const per = d.amount / BigInt(n);
  for (let i = 0; i < n; i++) {
    const amt = i === n - 1 ? d.amount - per * BigInt(n - 1) : per;
    const date = i === 0 ? d.date : addMonths(d.date, i * (d.installments?.everyMonths ?? 1));
    events.push({ key: `sim:${i}`, spaceId: d.spaceId, date, direction: dir, amount: amt, title: d.title, effect, category: d.category ?? null, reserveId: d.reserveId ?? null });
  }
  if (d.kind === "OWNER_PAYOUT") {
    const personal = s.spaces.find((x) => x.type === "PERSONAL");
    if (personal) events.push({ key: "sim:personal", spaceId: personal.id, date: d.date, direction: "IN", amount: d.amount, title: d.title, effect: "PERSONAL_INCOME" });
  }
  return { events, overrides: {} };
}

function addMonths(date: ISODate, k: number): ISODate {
  const [y, m, dd] = date.split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  const ny = Math.floor(t / 12);
  const nm = t % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(dd, last)).padStart(2, "0")}`;
}

const withExtra = (sc: ScenarioParams, events: SimEvent[], overrides: ScenarioParams["planOverrides"]): ScenarioParams => ({
  ...sc,
  extraEvents: [...(sc.extraEvents ?? []), ...events],
  planOverrides: { ...(sc.planOverrides ?? {}), ...(overrides ?? {}) },
});

/** Лимит основания выплаты себе: неоплаченная и ещё не запланированная утверждённая сумма. */
export function basisLimitFor(s: Snapshot, ix: Index, businessId: UUID, basis: PayoutBasis, movePlanId?: UUID | null): Minor | null {
  if (basis === "NONE") return null;
  const self = s.counterparties.find((c) => c.spaceId === businessId && c.isSelf);
  if (!self) return 0n;
  const sum = claimsSummary(s, ix, businessId).find((x) => x.counterpartyId === self.id);
  if (!sum) return 0n;
  let v = 0n;
  for (const c of sum.companyOwes) if (c.basis === basis && c.approved) v += c.unscheduled;
  if (movePlanId) {
    const p = s.plans.find((x) => x.id === movePlanId);
    if (p) v += planRemaining(ix, p);
  }
  return v;
}

export function simulate(s: Snapshot, d: Decision, opts: { searchAlternative?: boolean } = {}): SimulationResult {
  const ix = indexSnapshot(s);
  const space = s.spaces.find((x) => x.id === d.spaceId);
  if (!space) throw new Error("Пространство не найдено");
  const base = baseScenario();
  const stress = stressScenario(space.stressDelayDays);
  const { events, overrides } = decisionEvents(s, d);

  const run = (sc: ScenarioParams, spaceId = d.spaceId): ScenarioCompare => ({
    scenario: sc,
    before: forecastSpace(s, spaceId, sc, {}, ix),
    after: forecastSpace(s, spaceId, withExtra(sc, events, overrides), {}, ix),
  });
  const baseCmp = run(base);
  const stressCmp = run(stress);
  const personalSpace = d.kind === "OWNER_PAYOUT" ? s.spaces.find((x) => x.type === "PERSONAL") : null;
  const personal = personalSpace ? run(base, personalSpace.id) : null;

  // Максимум на выбранную дату = минимум свободного остатка начиная с даты выплаты (до решения).
  const maxFor = (f: ForecastResult) => {
    const m = minFreeFrom(f, d.date).amount;
    return m > 0n ? m : 0n;
  };
  let maxOnDate: Minor | null = maxFor(stressCmp.before);
  let maxOnDateBase: Minor | null = maxFor(baseCmp.before);
  if (d.kind === "RESCHEDULE" && d.movePlanId) {
    // При переносе существующая выплата уже учтена: сравниваем «после»
    maxOnDate = stressCmp.after.minFree.amount >= 0n ? stressCmp.after.minFree.amount : 0n;
    maxOnDateBase = baseCmp.after.minFree.amount >= 0n ? baseCmp.after.minFree.amount : 0n;
  }
  if (d.reserveId) {
    const extra = reserveBalanceNow(ix, d.reserveId);
    maxOnDate += extra;
    maxOnDateBase += extra;
  }

  const reasons: SimReason[] = [];
  const quality = stressCmp.after.quality;
  const missingData = quality.issues.filter((i) => i.severity === "BLOCKING" || i.severity === "PRELIMINARY");
  if (quality.status !== "COMPLETE") {
    maxOnDate = quality.status === "INSUFFICIENT" ? null : maxOnDate;
    maxOnDateBase = quality.status === "INSUFFICIENT" ? null : maxOnDateBase;
  }

  // Существовавший раньше выбранной даты дефицит остаётся видимым
  let preexistingDeficit: SimulationResult["preexistingDeficit"] = null;
  for (const p of stressCmp.before.points) {
    if (p.date >= d.date) break;
    if (p.free < 0n) {
      preexistingDeficit = { date: p.date, amount: p.free };
      break;
    }
  }

  let basisLimit: Minor | null = null;
  let verdict: Verdict;
  const after = stressCmp.after;
  const firstRisk = after.points.find((p) => p.free < 0n);
  const firstRiskDate = firstRisk ? firstRisk.date : null;

  if (d.kind === "OWNER_PAYOUT") {
    const business = d.spaceId;
    basisLimit = basisLimitFor(s, ix, business, d.basis ?? "NONE", d.movePlanId);
    if ((d.basis ?? "NONE") === "NONE") {
      reasons.push({ code: "NO_BASIS", message: "Не выбрано основание выплаты. Показываю только финансовый эффект — называть сумму причитающейся нельзя." });
    } else if (basisLimit !== null && d.amount > basisLimit) {
      reasons.push({ code: "BASIS_LIMIT", message: `По основанию доступно ${formatRub(basisLimit)} — это утверждённая неоплаченная сумма.`, amount: basisLimit });
    }
    if (personal && personal.after.quality.status === "INSUFFICIENT") {
      reasons.push({ code: "PERSONAL_DATA", message: "В личном пространстве не хватает данных для оценки влияния на бюджет." });
    }
  }

  if (quality.status !== "COMPLETE") {
    verdict = "NEEDS_DATA";
    reasons.push({ code: "DATA", message: quality.status === "INSUFFICIENT" ? "Недостаточно данных для уверенного вывода: " + missingData.filter((m) => m.severity === "BLOCKING").map((m) => m.message.toLowerCase()).join("; ") : "Предварительный расчёт: " + missingData.map((m) => m.message.toLowerCase()).join("; ") });
  } else if (after.minFree.amount < 0n || preexistingDeficit) {
    verdict = "SHORTFALL";
  } else {
    verdict = "WITHIN_LIMIT";
  }
  if (d.kind === "OWNER_PAYOUT" && ((d.basis ?? "NONE") === "NONE" || (basisLimit !== null && d.amount > basisLimit))) {
    verdict = verdict === "SHORTFALL" ? "SHORTFALL" : "NEEDS_DATA";
  }

  // Причины: до трёх фактов с датами и суммами
  if (after.firstShortfall) {
    reasons.push({ code: "CASH_SHORTFALL", message: `${formatDate(after.firstShortfall.date, s.asOf)}: денег не хватит на ${formatRub(-after.firstShortfall.amount)}`, date: after.firstShortfall.date, amount: -after.firstShortfall.amount });
  } else if (after.minFree.amount < 0n) {
    reasons.push({ code: "PROTECTED_BREACH", message: `${formatDate(after.minFree.date, s.asOf)}: будут затронуты защищённые деньги (${formatRub(-after.minFree.amount)})`, date: after.minFree.date, amount: -after.minFree.amount });
  }
  if (preexistingDeficit) {
    reasons.push({ code: "PREEXISTING", message: `Дефицит уже есть до даты решения: ${formatDate(preexistingDeficit.date, s.asOf)}, ${formatRub(preexistingDeficit.amount)}`, date: preexistingDeficit.date, amount: preexistingDeficit.amount });
  }
  const binding = after.events.find((e) => e.key === after.minFree.eventKey);
  if (binding && binding.kind !== "SIM") {
    const inBefore = after.events.filter((e) => e.date <= binding.date && e.deltaC > 0n && e.effect === "SALES");
    reasons.push({
      code: inBefore.length ? "PAYMENT_BEFORE_RECEIPT" : "LOWEST_POINT",
      message: `Самая низкая точка — ${formatDate(binding.date, s.asOf)}: «${binding.title}» ${formatRub(binding.deltaC, { sign: true })}`,
      date: binding.date, planIds: binding.planId ? [binding.planId] : [],
    });
  }
  if (stressCmp.before.scenario.delayIncomingDays && baseCmp.after.minFree.amount >= 0n && after.minFree.amount < 0n) {
    reasons.push({ code: "STRESS_ONLY", message: `В базовом сценарии хватает; нехватка возникает при задержке клиентских оплат на ${space.stressDelayDays} дн.` });
  }

  // Альтернативная дата — повторной симуляцией по дням горизонта
  let alternativeDate: ISODate | null = null;
  let alternativeSearched = false;
  if (opts.searchAlternative !== false && verdict === "SHORTFALL" && !preexistingDeficit && d.kind !== "INCOME") {
    alternativeSearched = true;
    for (let k = 1; k <= 90; k++) {
      const date = addDays(d.date, k);
      if (date > stressCmp.before.decisionEnd) break;
      const alt = decisionEvents(s, { ...d, date });
      const f = forecastSpace(s, d.spaceId, withExtra(stress, alt.events, alt.overrides), {}, ix);
      if (f.minFree.amount >= 0n) {
        alternativeDate = date;
        break;
      }
    }
  }

  return {
    decision: d, verdict, base: baseCmp, stress: stressCmp, personal, maxOnDate, maxOnDateBase, basisLimit,
    firstRiskDate, alternativeDate, alternativeSearched, preexistingDeficit, reasons: reasons.slice(0, 4), missingData, dataVersion: space.dataVersion,
  };
}
