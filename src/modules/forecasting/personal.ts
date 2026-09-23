// Личный бюджет, цели, подушка и ожидаемые выплаты из бизнеса (F10).
import { monthKey, type ISODate } from "../../shared/dates";
import { mulDivHalfUp, sum, type Minor } from "../../shared/money";
import type { Goal, PaymentPlan, PersonalBudget, Snapshot, UUID } from "../../shared/types";
import { actualSpent, budgetFor, type ForecastResult } from "./forecast";
import { planRemaining, reserveBalanceNow, type Index } from "./ledger";

export interface CategoryRow {
  category: string;
  kind: PersonalBudget["kind"];
  inMinimum: boolean;
  limit: Minor;
  actual: Minor;
  planned: Minor;
  /** лимит − факт − запланированные неоплаченные траты категории */
  remaining: Minor;
  overspend: Minor;
}

export interface GoalRow {
  goal: Goal;
  accumulated: Minor;
  progressBp: bigint | null;
}

export interface PayoutRow {
  plan: PaymentPlan;
  businessPlan: PaymentPlan | null;
  remaining: Minor;
  atRisk: boolean;
  riskNote: string;
}

export interface PersonalView {
  month: string;
  configured: boolean;
  categories: CategoryRow[];
  fixedTotal: Minor;
  variableLimit: Minor;
  variableRemaining: Minor;
  goals: GoalRow[];
  cushion: { protected: Minor; monthlyMinimum: Minor | null; tenthsOfMonths: bigint | null };
  payouts: PayoutRow[];
  /** Минимум свободного остатка до следующего поступления. */
  untilNextIncome: { amount: Minor; nextIncomeDate: ISODate | null };
}

export function goalAccumulated(s: Snapshot, ix: Index, goalId: UUID): Minor {
  return sum(s.reserves.filter((r) => r.goalId === goalId).map((r) => reserveBalanceNow(ix, r.id)));
}

export function personalView(s: Snapshot, ix: Index, spaceId: UUID, forecast: ForecastResult, businessStress: ForecastResult | null): PersonalView {
  const space = s.spaces.find((x) => x.id === spaceId)!;
  const month = monthKey(s.asOf);
  const budgets = budgetFor(s, spaceId, month);
  const plannedByCat = new Map<string, Minor>();
  for (const e of forecast.events) {
    if ((e.kind === "PLAN" || e.kind === "RECURRENCE" || e.kind === "SIM") && e.category && monthKey(e.date) === month && e.deltaC < 0n) {
      plannedByCat.set(e.category, (plannedByCat.get(e.category) ?? 0n) - e.deltaC);
    }
  }
  const categories: CategoryRow[] = budgets.map((b) => {
    const actual = actualSpent(s, ix, spaceId, b.category, month);
    const planned = plannedByCat.get(b.category) ?? 0n;
    const remaining = b.limit - actual - planned;
    return { category: b.category, kind: b.kind, inMinimum: b.inMinimum, limit: b.limit, actual, planned, remaining, overspend: remaining < 0n ? -remaining : 0n };
  });
  const goals: GoalRow[] = s.goals
    .filter((g) => g.spaceId === spaceId)
    .sort((a, b) => a.priority - b.priority)
    .map((g) => {
      const acc = goalAccumulated(s, ix, g.id);
      return { goal: g, accumulated: acc, progressBp: g.target > 0n ? mulDivHalfUp(acc, 10_000n, g.target) : null };
    });
  const protectedCushion = sum(goals.filter((g) => g.goal.kind === "EMERGENCY").map((g) => g.accumulated));
  const min = space.monthlyMinimum;
  const cushion = {
    protected: protectedCushion,
    monthlyMinimum: min,
    tenthsOfMonths: min && min > 0n ? mulDivHalfUp(protectedCushion, 10n, min) : null,
  };

  const payouts: PayoutRow[] = s.plans
    .filter((p) => p.spaceId === spaceId && p.direction === "IN" && p.linkedPlanId && !p.cancelledAt && planRemaining(ix, p) > 0n)
    .map((p) => {
      const bp = s.plans.find((x) => x.id === p.linkedPlanId) ?? null;
      const date = p.expectedDate ?? p.dueDate;
      let atRisk = false;
      let riskNote = "";
      if (businessStress?.firstShortfall && date && businessStress.firstShortfall.date <= date) {
        atRisk = true;
        riskNote = `В бизнесе нехватка денег ${businessStress.firstShortfall.date} — раньше этой выплаты`;
      }
      return { plan: p, businessPlan: bp, remaining: planRemaining(ix, p), atRisk, riskNote };
    });

  const nextIncome = forecast.events.find((e) => e.deltaC > 0n);
  let m = forecast.points[0].free;
  for (const p of forecast.points) {
    if (nextIncome && p.eventKey === nextIncome.key) break;
    if (p.free < m) m = p.free;
  }

  const variable = categories.filter((c) => c.kind === "VARIABLE");
  return {
    month,
    configured: budgets.length > 0,
    categories,
    fixedTotal: sum(categories.filter((c) => c.kind === "FIXED").map((c) => c.limit)),
    variableLimit: sum(variable.map((c) => c.limit)),
    variableRemaining: sum(variable.map((c) => (c.remaining > 0n ? c.remaining : 0n))),
    goals,
    cushion,
    payouts,
    untilNextIncome: { amount: m, nextIncomeDate: nextIncome?.date ?? null },
  };
}
