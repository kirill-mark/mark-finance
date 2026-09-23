// Действия записи: все денежные операции идут через серверные функции с ключом идемпотентности.
import type { ISODate } from "../shared/dates";
import type { Minor } from "../shared/money";
import type { EconomicEffect, PaymentPlan, RecurrenceRule, Snapshot, TxKind, UUID } from "../shared/types";
import * as api from "./api";
import { get } from "./store";

const s = (): Snapshot => get().s!;
const str = (v: Minor | null | undefined) => (v === null || v === undefined ? null : v.toString());

export function txKindForPlan(p: Pick<PaymentPlan, "direction" | "effect" | "loanId">): TxKind {
  if (p.direction === "IN") {
    if (p.effect === "SALES") return "CLIENT_RECEIPT";
    if (p.effect === "FINANCING" && p.loanId) return "LOAN_IN";
    if (p.effect === "REIMBURSEMENT") return "REIMBURSEMENT";
    return "INCOME";
  }
  if (p.effect === "TAX") return "TAX";
  if (p.effect === "FINANCING" && p.loanId) return "LOAN_REPAYMENT";
  if (p.effect === "REIMBURSEMENT" || p.effect === "PROFIT_DISTRIBUTION") return "PARTNER_PAYOUT";
  return "EXPENSE";
}

/** Вхождение регулярного платежа материализуется в план с ключом (правило, дата) — один раз. */
export async function materialize(ruleId: UUID, date: ISODate, patch: Record<string, unknown> = {}): Promise<UUID> {
  const existing = s().plans.find((p) => p.recurrenceRuleId === ruleId && p.occurrenceDate === date);
  if (existing) return existing.id;
  const r = s().recurrences.find((x) => x.id === ruleId)!;
  const t = r.template;
  return api.insert("cfo_payment_plans", {
    space_id: r.spaceId, direction: t.direction, amount: t.amount.toString(), mgmt_amount: str(t.mgmtAmount), due_date: date,
    expected_time: t.expectedTime, counterparty_id: t.counterpartyId, certainty: t.certainty, effect: t.effect, title: t.title, basis: t.basis,
    project_id: t.projectId, budget_line_id: t.budgetLineId, category: t.category, in_forecast: t.inForecast,
    recurrence_rule_id: ruleId, occurrence_date: date, ...patch,
  });
}

export async function payPlan(args: { planId: UUID; accountId: UUID; amount: Minor; date: ISODate; description?: string; key: string; personalAccountId?: UUID | null }) {
  const p = s().plans.find((x) => x.id === args.planId)!;
  const claim = p.partnerClaimId ? s().claims.find((c) => c.id === p.partnerClaimId) : null;
  const self = claim ? s().counterparties.find((c) => c.id === claim.counterpartyId && c.isSelf) : null;
  if (claim && self && p.direction === "OUT") {
    // Выплата себе — одна операция в двух пространствах с проверкой основания
    return api.rpc("cfo_owner_payout", {
      personal_space_id: get().personalId, business_space_id: p.spaceId, business_account_id: args.accountId, personal_account_id: args.personalAccountId ?? null,
      amount: args.amount.toString(), occurred_on: args.date, basis: claim.basis, claim_id: claim.id, plan_id: p.id, description: args.description || p.title,
    }, args.key);
  }
  return api.rpc("cfo_post_transaction", {
    space_id: p.spaceId, kind: txKindForPlan(p), effect: p.effect, occurred_on: args.date, description: args.description || p.title,
    counterparty_id: p.counterpartyId, project_id: p.projectId, category: p.category, loan_id: p.loanId,
    entries: [{ account_id: args.accountId, amount: (p.direction === "IN" ? args.amount : -args.amount).toString() }],
    settlements: [{ plan_id: p.id, amount: args.amount.toString() }],
  }, args.key);
}

export async function reschedule(p: PaymentPlan, date: ISODate) {
  await api.update("cfo_payment_plans", p.id, versionOf("plans", p.id), { expected_date: date });
}

export async function cancelPlan(p: PaymentPlan, reason: string, today: ISODate) {
  await api.update("cfo_payment_plans", p.id, versionOf("plans", p.id), { cancelled_at: today, cancel_reason: reason });
}

/** Версия записи из сырого снимка — для проверки конфликтов при изменении. */
export function versionOf(collection: string, id: UUID): number | null {
  const list = (get().raw as any)?.[collection] as any[] | undefined;
  return list?.find((x) => x.id === id)?.version ?? null;
}

export interface PlanInput {
  spaceId: UUID;
  direction: "IN" | "OUT";
  amount: Minor;
  dueDate: ISODate | null;
  expectedTime?: string | null;
  certainty: PaymentPlan["certainty"];
  effect: EconomicEffect;
  title: string;
  basis?: string;
  counterpartyId?: UUID | null;
  projectId?: UUID | null;
  budgetLineId?: UUID | null;
  fundingSourceId?: UUID | null;
  partnerClaimId?: UUID | null;
  loanId?: UUID | null;
  category?: string | null;
  mgmtAmount?: Minor | null;
}

export function planRow(p: PlanInput) {
  return {
    space_id: p.spaceId, direction: p.direction, amount: p.amount.toString(), mgmt_amount: str(p.mgmtAmount ?? null), due_date: p.dueDate,
    expected_time: p.expectedTime || null, certainty: p.certainty, effect: p.effect, title: p.title, basis: p.basis ?? "",
    counterparty_id: p.counterpartyId || null, project_id: p.projectId || null, budget_line_id: p.budgetLineId || null,
    funding_source_id: p.fundingSourceId || null, partner_claim_id: p.partnerClaimId || null, loan_id: p.loanId || null, category: p.category || null,
  };
}

export async function createPlan(p: PlanInput, id?: string) {
  return api.insert("cfo_payment_plans", { ...planRow(p), ...(id ? { id } : {}) });
}

export async function createRecurrence(p: PlanInput, freq: RecurrenceRule["freq"], day: number, start: ISODate, end: ISODate | null, id?: string) {
  const row = planRow(p);
  return api.insert("cfo_recurrence_rules", {
    ...(id ? { id } : {}), space_id: p.spaceId, freq, day, start_date: start, end_date: end,
    template: { ...row, space_id: undefined, due_date: undefined },
  });
}

export async function postOperation(args: {
  spaceId: UUID; kind: TxKind; effect: EconomicEffect; date: ISODate; accountId: UUID; amount: Minor; direction: "IN" | "OUT";
  description: string; projectId?: UUID | null; counterpartyId?: UUID | null; category?: string | null; budgetLineId?: UUID | null;
  loanId?: UUID | null; settlements?: { planId: UUID; amount: Minor }[]; source?: "MANUAL" | "ASSISTANT"; key: string;
}) {
  return api.rpc("cfo_post_transaction", {
    space_id: args.spaceId, kind: args.kind, effect: args.effect, occurred_on: args.date, description: args.description,
    project_id: args.projectId || null, counterparty_id: args.counterpartyId || null, category: args.category || null,
    budget_line_id: args.budgetLineId || null, loan_id: args.loanId || null, source: args.source ?? "MANUAL",
    entries: [{ account_id: args.accountId, amount: (args.direction === "IN" ? args.amount : -args.amount).toString() }],
    settlements: (args.settlements ?? []).map((x) => ({ plan_id: x.planId, amount: x.amount.toString() })),
  }, args.key);
}
