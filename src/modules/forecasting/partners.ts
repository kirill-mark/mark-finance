// Расчёты с партнёрами (F11): основания, долги в обе стороны, распределения, займы.
import { allocateLargestRemainder, sum, type Minor } from "../../shared/money";
import type { ClaimBasis, DistributionPool, Snapshot, UUID } from "../../shared/types";
import { planPaid, planRemaining, type Index } from "./ledger";

export interface ClaimRow {
  claimId: UUID;
  basis: ClaimBasis;
  note: string;
  amount: Minor;
  approved: boolean;
  paid: Minor;
  /** Запланировано к выплате, но ещё не оплачено. */
  scheduled: Minor;
  /** Утверждено, но ещё не запланировано и не оплачено. */
  unscheduled: Minor;
  remaining: Minor;
  planIds: UUID[];
}

export interface PartnerSummary {
  counterpartyId: UUID;
  name: string;
  isSelf: boolean;
  companyOwes: ClaimRow[];
  partnerOwes: ClaimRow[];
  companyOwesTotal: Minor;
  partnerOwesTotal: Minor;
  approvedUnpaid: Minor;
}

export const BASIS_TEXT: Record<ClaimBasis, string> = {
  FEE: "Гонорар за работу",
  REIMBURSEMENT: "Возмещение расходов",
  LOAN: "Заём",
  DISTRIBUTION: "Распределение прибыли",
};

export function claimsSummary(s: Snapshot, ix: Index, spaceId: UUID): PartnerSummary[] {
  const byCp = new Map<UUID, PartnerSummary>();
  const cps = s.counterparties.filter((c) => c.spaceId === spaceId && (c.types.includes("PARTNER") || c.isSelf));
  for (const c of [...cps].sort((a, b) => a.sortOrder - b.sortOrder)) {
    byCp.set(c.id, { counterpartyId: c.id, name: c.name, isSelf: c.isSelf, companyOwes: [], partnerOwes: [], companyOwesTotal: 0n, partnerOwesTotal: 0n, approvedUnpaid: 0n });
  }
  for (const cl of s.claims) {
    if (cl.spaceId !== spaceId || cl.cancelled) continue;
    let row = byCp.get(cl.counterpartyId);
    if (!row) {
      const cp = s.counterparties.find((c) => c.id === cl.counterpartyId);
      row = { counterpartyId: cl.counterpartyId, name: cp?.name ?? "—", isSelf: !!cp?.isSelf, companyOwes: [], partnerOwes: [], companyOwesTotal: 0n, partnerOwesTotal: 0n, approvedUnpaid: 0n };
      byCp.set(cl.counterpartyId, row);
    }
    const plans = s.plans.filter((p) => p.partnerClaimId === cl.id && !p.cancelledAt);
    const paid = sum(plans.map((p) => planPaid(ix, p.id)));
    const scheduled = sum(plans.map((p) => planRemaining(ix, p)));
    const remaining = cl.amount - paid > 0n ? cl.amount - paid : 0n;
    const unscheduled = remaining - scheduled > 0n ? remaining - scheduled : 0n;
    const r: ClaimRow = { claimId: cl.id, basis: cl.basis, note: cl.note, amount: cl.amount, approved: cl.approved, paid, scheduled, unscheduled, remaining, planIds: plans.map((p) => p.id) };
    if (cl.direction === "COMPANY_OWES") {
      row.companyOwes.push(r);
      row.companyOwesTotal += remaining;
      if (cl.approved) row.approvedUnpaid += remaining;
    } else {
      row.partnerOwes.push(r);
      row.partnerOwesTotal += remaining;
    }
  }
  return [...byCp.values()];
}

/** Начисления по пулу: фиксированные суммы либо доли ровно 100% (метод наибольших остатков). */
export function computeDistribution(pool: Pick<DistributionPool, "amount" | "recipients">): { counterpartyId: UUID; amount: Minor }[] {
  const rec = [...pool.recipients].sort((a, b) => a.order - b.order);
  if (!rec.length) throw new Error("Нет получателей");
  const byShare = rec.every((r) => r.shareBp !== null && r.fixed === null);
  const byFixed = rec.every((r) => r.fixed !== null && r.shareBp === null);
  if (byShare) {
    const amounts = allocateLargestRemainder(pool.amount, rec.map((r) => r.shareBp!));
    return rec.map((r, i) => ({ counterpartyId: r.counterpartyId, amount: amounts[i] }));
  }
  if (byFixed) {
    const total = sum(rec.map((r) => r.fixed!));
    if (total !== pool.amount) throw new Error("Сумма фиксированных начислений должна равняться пулу");
    if (rec.some((r) => r.fixed! < 0n)) throw new Error("Начисление не может быть отрицательным");
    return rec.map((r) => ({ counterpartyId: r.counterpartyId, amount: r.fixed! }));
  }
  throw new Error("Используй либо доли, либо фиксированные суммы — не вместе");
}

export interface LoanSummary {
  loanId: UUID;
  lender: string;
  contract: Minor;
  received: Minor;
  repaid: Minor;
  outstanding: Minor;
}

/** Основной долг — из операций: получено по займу минус погашения тела (T04). */
export function loansSummary(s: Snapshot, spaceId: UUID): LoanSummary[] {
  return s.loans.filter((l) => l.spaceId === spaceId).map((l) => {
    let received = 0n;
    let repaid = 0n;
    for (const t of s.transactions) {
      if (t.loanId !== l.id) continue;
      const net = sum(s.entries.filter((e) => e.transactionId === t.id).map((e) => e.amount));
      if (t.kind === "LOAN_IN") received += net;
      if (t.kind === "LOAN_REPAYMENT") repaid -= net;
    }
    return { loanId: l.id, lender: l.lenderName, contract: l.contractAmount, received, repaid, outstanding: received - repaid };
  });
}
