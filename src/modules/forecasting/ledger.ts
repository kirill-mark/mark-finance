// Остатки, неоплаченные части планов и резервы — чистые функции над снимком.
import type { ISODate } from "../../shared/dates";
import type { Minor } from "../../shared/money";
import type { Account, PaymentPlan, Snapshot, UUID } from "../../shared/types";

export interface Index {
  s: Snapshot;
  settlementsByPlan: Map<UUID, Minor>;
  settlementsMgmtByPlan: Map<UUID, Minor>;
  entriesByAccount: Map<UUID, { amount: Minor; effectiveOn: ISODate; transactionId: UUID }[]>;
  txById: Map<UUID, Snapshot["transactions"][number]>;
  planById: Map<UUID, PaymentPlan>;
  reserveBalance: Map<UUID, Minor>;
}

/** Строит индексы один раз на снимок. Отменённые (VOID) погашения не участвуют. */
export function indexSnapshot(s: Snapshot, asOf: ISODate = s.asOf): Index {
  const settlementsByPlan = new Map<UUID, Minor>();
  const settlementsMgmtByPlan = new Map<UUID, Minor>();
  for (const st of s.settlements) {
    if (st.status !== "ACTIVE") continue;
    settlementsByPlan.set(st.planId, (settlementsByPlan.get(st.planId) ?? 0n) + st.amount);
    settlementsMgmtByPlan.set(st.planId, (settlementsMgmtByPlan.get(st.planId) ?? 0n) + st.mgmtAmount);
  }
  const entriesByAccount = new Map<UUID, { amount: Minor; effectiveOn: ISODate; transactionId: UUID }[]>();
  for (const e of s.entries) {
    const list = entriesByAccount.get(e.accountId) ?? [];
    list.push({ amount: e.amount, effectiveOn: e.effectiveOn, transactionId: e.transactionId });
    entriesByAccount.set(e.accountId, list);
  }
  const reserveBalance = new Map<UUID, Minor>();
  for (const ev of s.reserveEvents) {
    if (ev.date > asOf) continue;
    const d = ev.kind === "ALLOCATE" ? ev.amount : -ev.amount;
    reserveBalance.set(ev.reserveId, (reserveBalance.get(ev.reserveId) ?? 0n) + d);
  }
  return {
    s,
    settlementsByPlan,
    settlementsMgmtByPlan,
    entriesByAccount,
    txById: new Map(s.transactions.map((t) => [t.id, t])),
    planById: new Map(s.plans.map((p) => [p.id, p])),
    reserveBalance,
  };
}

/**
 * Остаток счёта = начальный остаток + проведённые движения начиная с точки открытия (F02).
 * Сторно — это обычные движения с обратным знаком, поэтому суммируются все записи.
 */
export function accountBalance(ix: Index, a: Account, upTo?: ISODate): Minor {
  let b = a.openingBalance;
  for (const e of ix.entriesByAccount.get(a.id) ?? []) {
    if (e.effectiveOn < a.openingDate) continue;
    if (upTo && e.effectiveOn > upTo) continue;
    b += e.amount;
  }
  return b;
}

export function spaceCash(ix: Index, spaceId: UUID, upTo?: ISODate): Minor {
  let c = 0n;
  for (const a of ix.s.accounts) if (a.spaceId === spaceId) c += accountBalance(ix, a, upTo);
  return c;
}

export const planPaid = (ix: Index, planId: UUID): Minor => ix.settlementsByPlan.get(planId) ?? 0n;

/** Неоплаченный остаток = сумма плана − действующие привязанные оплаты (F03). */
export function planRemaining(ix: Index, p: PaymentPlan): Minor {
  if (p.cancelledAt) return 0n;
  const r = p.amount - planPaid(ix, p.id);
  return r > 0n ? r : 0n;
}

/** Неоплаченная управленческая часть. */
export function planRemainingMgmt(ix: Index, p: PaymentPlan): Minor {
  if (p.cancelledAt) return 0n;
  const total = p.mgmtAmount ?? p.amount;
  if (planRemaining(ix, p) === 0n) return 0n;
  const r = total - (ix.settlementsMgmtByPlan.get(p.id) ?? 0n);
  return r > 0n ? r : 0n;
}

export type PlanStatus = "PLANNED" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
export function planStatus(ix: Index, p: PaymentPlan): PlanStatus {
  if (p.cancelledAt) return "CANCELLED";
  const paid = planPaid(ix, p.id);
  if (paid === 0n) return "PLANNED";
  return paid >= p.amount ? "PAID" : "PARTIALLY_PAID";
}

/** Просрочка — признак по исходному сроку, а не статус оплаты. */
export function isOverdue(ix: Index, p: PaymentPlan, today: ISODate): boolean {
  return !p.cancelledAt && !!p.dueDate && p.dueDate < today && planRemaining(ix, p) > 0n;
}

export const planDate = (p: PaymentPlan): ISODate | null => p.expectedDate ?? p.dueDate;

export const reserveBalanceNow = (ix: Index, reserveId: UUID): Minor => ix.reserveBalance.get(reserveId) ?? 0n;

export function spaceReserved(ix: Index, spaceId: UUID): Minor {
  let r = 0n;
  for (const res of ix.s.reserves) if (res.spaceId === spaceId) r += reserveBalanceNow(ix, res.id);
  return r;
}
