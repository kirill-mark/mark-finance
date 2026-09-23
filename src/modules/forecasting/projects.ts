// Экономика проектов: прогноз затрат (F04), маржа (F05), финансирование (8.2),
// метрики направлений (8.1, 8.3) и сравнение направлений (F12).
import type { ISODate } from "../../shared/dates";
import { mulDivHalfUp, ratioBp, sum, type Minor } from "../../shared/money";
import type { BudgetLine, Project, Snapshot, UUID } from "../../shared/types";
import { planRemaining, planRemainingMgmt, type Index } from "./ledger";

export interface LineForecast {
  lineId: UUID | null;
  category: string;
  stage: BudgetLine["stage"];
  original: Minor;
  paid: Minor;
  agreed: Minor;
  estimate: Minor;
  /** Часть оценки без даты платежа — делает прогноз неполным. */
  undatedEstimate: Minor;
  forecast: Minor;
  variance: Minor;
}

export interface ProjectEconomics {
  project: Project;
  lines: LineForecast[];
  original: Minor;
  paid: Minor;
  agreed: Minor;
  estimate: Minor;
  undated: Minor;
  forecastCost: Minor;
  variance: Minor;
  /** Договорная (управленческая) выручка подписанных договоров. */
  revenue: Minor;
  extraWorkRevenue: Minor;
  received: Minor;
  expectedIncoming: Minor;
  margin: Minor | null;
  marginBp: bigint | null;
  /** Маржа по исходной смете — для рекомендаций о снижении. */
  plannedMargin: Minor | null;
  overheadAllocated: Minor;
  marginAfterOverhead: Minor | null;
  funding: {
    confirmed: Minor;
    declared: Minor;
    received: Minor;
    toReceive: Minor;
    ownInvestment: Minor;
    unsecured: Minor;
  };
  /** Максимальная потребность во временном финансировании по графику проекта. */
  maxFinancingNeed: Minor;
  nextPayment: { planId: UUID; date: ISODate; direction: "IN" | "OUT"; amount: Minor; title: string } | null;
  metrics: { label: string; value: Minor | null; numerator: Minor; denominator: number; unit: string; note?: string }[];
  complete: boolean;
}

const COST_EFFECTS = new Set(["PROJECT_COST"]);

export function projectEconomics(s: Snapshot, ix: Index, projectId: UUID): ProjectEconomics {
  const project = s.projects.find((p) => p.id === projectId);
  if (!project) throw new Error("Проект не найден");
  const lines = s.budgetLines.filter((l) => l.projectId === projectId);
  const plans = s.plans.filter((p) => p.projectId === projectId && !p.cancelledAt);
  const costPlans = plans.filter((p) => p.direction === "OUT" && COST_EFFECTS.has(p.effect));
  const records = s.costRecords.filter((c) => c.projectId === projectId && c.status === "ACTIVE");

  const lineRows: LineForecast[] = [];
  const mk = (lineId: UUID | null, category: string, stage: BudgetLine["stage"], original: Minor): LineForecast => {
    const paid = sum(records.filter((r) => r.budgetLineId === lineId).map((r) => r.mgmtAmount));
    let agreed = 0n;
    let estimate = 0n;
    let undatedEstimate = 0n;
    for (const p of costPlans.filter((x) => x.budgetLineId === lineId)) {
      if (p.certainty === "PIPELINE") continue;
      const rem = planRemainingMgmt(ix, p);
      if (p.certainty === "CONTRACTED") agreed += rem;
      else estimate += rem;
      if (!p.dueDate && !p.expectedDate) undatedEstimate += rem;
    }
    const forecast = paid + agreed + estimate;
    return { lineId, category, stage, original, paid, agreed, estimate, undatedEstimate, forecast, variance: forecast - original };
  };
  for (const l of lines) lineRows.push(mk(l.id, l.category, l.stage, l.originalMgmt));
  const orphan = mk(null, "Без статьи сметы", "OTHER", 0n);
  if (orphan.forecast !== 0n) lineRows.push(orphan);

  const original = sum(lineRows.map((l) => l.original));
  const paid = sum(lineRows.map((l) => l.paid));
  const agreed = sum(lineRows.map((l) => l.agreed));
  const estimate = sum(lineRows.map((l) => l.estimate));
  const undated = sum(lineRows.map((l) => l.undatedEstimate));
  const forecastCost = paid + agreed + estimate;

  const agreements = s.revenueAgreements.filter((a) => a.projectId === projectId && a.status === "SIGNED");
  const revenue = sum(agreements.map((a) => a.mgmtAmount));
  const extraWorkRevenue = sum(agreements.filter((a) => a.isExtraWork).map((a) => a.mgmtAmount));

  // Получено денег от клиентов: проведённые операции проекта с эффектом «Выручка»
  let received = 0n;
  for (const t of s.transactions) {
    if (t.projectId !== projectId || t.effect !== "SALES") continue;
    received += sum(s.entries.filter((e) => e.transactionId === t.id).map((e) => e.amount));
  }
  const expectedIncoming = sum(plans.filter((p) => p.direction === "IN" && p.effect === "SALES" && p.certainty === "CONTRACTED").map((p) => planRemaining(ix, p)));

  const isService = project.model === "SERVICE";
  const margin = isService ? revenue - forecastCost : null;
  const marginBp = isService ? ratioBp(revenue - forecastCost, revenue) : null;
  const plannedMargin = isService && original > 0n ? revenue - original : null;

  const overheadAllocated = sum(
    s.overheads.filter((o) => o.projectId === projectId).map((o) => {
      if (o.amount !== null) return o.amount;
      const line = s.budgetLines.find((l) => l.id === o.budgetLineId);
      return line && o.shareBp !== null ? mulDivHalfUp(line.originalMgmt, o.shareBp, 10_000n) : 0n;
    }),
  );
  const marginAfterOverhead = margin !== null && overheadAllocated > 0n ? margin - overheadAllocated : null;

  // Финансирование (8.2): полученное — часть подтверждённого, а не прибавка (T28)
  const sources = s.fundingSources.filter((f) => f.projectId === projectId && f.status !== "CANCELLED");
  const confirmed = sum(sources.filter((f) => f.status === "CONFIRMED").map((f) => f.confirmed));
  const declared = sum(sources.map((f) => f.declared));
  let fundingReceived = 0n;
  for (const f of sources) {
    if (f.isReallocation) {
      fundingReceived += f.confirmed; // выделение уже имеющихся денег: получено сразу, без поступления (T33)
      continue;
    }
    for (const p of s.plans.filter((x) => x.fundingSourceId === f.id && x.direction === "IN")) fundingReceived += p.amount - planRemaining(ix, p);
  }
  const ownInvestment = sum(sources.filter((f) => f.kind === "OWN_FUNDS" && f.status === "CONFIRMED").map((f) => f.confirmed));
  const unsecured = forecastCost - confirmed > 0n ? forecastCost - confirmed : 0n;

  // Потребность во временном финансировании: минимум накопленного денежного потока проекта
  let cum = received - paid;
  let minCum = cum < 0n ? cum : 0n;
  const future = plans
    .filter((p) => p.certainty !== "PIPELINE" && planRemaining(ix, p) > 0n && (p.expectedDate ?? p.dueDate))
    .map((p) => ({ date: (p.expectedDate ?? p.dueDate)!, d: p.direction === "IN" ? planRemaining(ix, p) : -planRemaining(ix, p), dir: p.direction }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.dir === "OUT" ? -1 : 1));
  for (const f of future) {
    cum += f.d;
    if (cum < minCum) minCum = cum;
  }
  const maxFinancingNeed = -minCum;

  const next = plans
    .filter((p) => planRemaining(ix, p) > 0n && (p.expectedDate ?? p.dueDate) && p.certainty !== "PIPELINE")
    .sort((a, b) => ((a.expectedDate ?? a.dueDate)! < (b.expectedDate ?? b.dueDate)! ? -1 : 1))[0];

  const metrics: ProjectEconomics["metrics"] = [];
  const per = (label: string, numerator: Minor, denominator: number | undefined, unit: string, note?: string) => {
    const den = denominator ?? 0;
    metrics.push({ label, numerator, denominator: den, unit, note, value: perUnit(numerator, den) });
  };
  const direction = s.directions.find((d) => d.id === project.directionId);
  if (direction?.kind === "VERTICAL") {
    per("Стоимость серии", forecastCost, project.metrics.episodes, "серию");
    const shooting = sum(lineRows.filter((l) => l.stage === "SHOOTING").map((l) => l.forecast));
    const shifts = project.metrics.actualShifts || project.metrics.plannedShifts;
    per("Съёмочный этап на смену", shooting, shifts, "смену", project.metrics.actualShifts ? "по фактическим сменам" : "по плановым сменам");
  }
  if (direction?.kind === "AI") {
    per("Затраты на принятую минуту", forecastCost, project.metrics.acceptedMinutes, "минуту");
  }

  const complete = undated === 0n;
  return {
    project, lines: lineRows, original, paid, agreed, estimate, undated, forecastCost, variance: forecastCost - original,
    revenue, extraWorkRevenue, received, expectedIncoming, margin, marginBp, plannedMargin, overheadAllocated, marginAfterOverhead,
    funding: { confirmed, declared, received: fundingReceived, toReceive: confirmed - fundingReceived > 0n ? confirmed - fundingReceived : 0n, ownInvestment, unsecured },
    maxFinancingNeed,
    nextPayment: next ? { planId: next.id, date: (next.expectedDate ?? next.dueDate)!, direction: next.direction, amount: planRemaining(ix, next), title: next.title } : null,
    metrics, complete,
  };
}

/** Деление денег на количество с half-up; value в копейках на единицу. */
export function perUnit(numerator: Minor, denominator: number): Minor | null {
  if (!(denominator > 0)) return null;
  // Количество может быть дробным (минуты) — считаем в сотых долях единицы
  const den = BigInt(Math.round(denominator * 100));
  return mulDivHalfUp(numerator, 100n, den);
}

export interface DirectionRow {
  directionId: UUID | null;
  name: string;
  received: Minor;
  serviceMargin: Minor;
  directCosts: Minor;
  overhead: Minor;
  ownInvestment: Minor;
  maxFinancingNeed: Minor;
  completed: number;
  projects: number;
  training: Minor;
  commercial: Minor;
}

export function directionsComparison(s: Snapshot, ix: Index, spaceId: UUID): DirectionRow[] {
  const dirs = s.directions.filter((d) => d.spaceId === spaceId);
  const rows: DirectionRow[] = [...dirs.map((d) => ({ id: d.id as UUID | null, name: d.name })), { id: null, name: "Без направления" }].map(({ id, name }) => ({
    directionId: id, name, received: 0n, serviceMargin: 0n, directCosts: 0n, overhead: 0n, ownInvestment: 0n, maxFinancingNeed: 0n, completed: 0, projects: 0, training: 0n, commercial: 0n,
  }));
  for (const p of s.projects.filter((x) => x.spaceId === spaceId)) {
    const row = rows.find((r) => r.directionId === p.directionId) ?? rows[rows.length - 1];
    const e = projectEconomics(s, ix, p.id);
    row.projects++;
    row.received += e.received;
    if (e.margin !== null) row.serviceMargin += e.margin;
    row.directCosts += e.forecastCost;
    row.overhead += e.overheadAllocated;
    row.ownInvestment += e.funding.ownInvestment;
    if (e.maxFinancingNeed > row.maxFinancingNeed) row.maxFinancingNeed = e.maxFinancingNeed;
    if (p.stage === "DONE") row.completed++;
    if (p.model === "EXPERIMENT" || p.metrics.aiKind === "TRAINING" || p.metrics.aiKind === "EXPERIMENT") row.training += e.forecastCost;
    else if (p.model === "SERVICE") row.commercial += e.revenue;
  }
  return rows.filter((r) => r.projects > 0 || r.directionId !== null);
}
