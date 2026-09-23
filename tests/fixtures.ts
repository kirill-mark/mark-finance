// Построитель тестовых снимков. Все суммы — вымышленные (раздел 13 ТЗ).
import { addDays, type ISODate } from "../src/shared/dates";
import { rub, type Minor } from "../src/shared/money";
import {
  emptySnapshot, type Account, type PaymentPlan, type Reserve, type Snapshot, type Space, type UUID,
} from "../src/shared/types";

export const TODAY: ISODate = "2026-10-01";
let seq = 0;
export const id = (p = "id") => `${p}-${++seq}`;

export class B {
  s: Snapshot;
  constructor(asOf: ISODate = TODAY) {
    this.s = emptySnapshot(asOf);
  }
  d(n: number): ISODate {
    return addDays(this.s.asOf, n);
  }
  space(type: Space["type"] = "BUSINESS", over: Partial<Space> = {}): Space {
    const sp: Space = {
      id: id(type === "BUSINESS" ? "biz" : "me"), type, name: type === "BUSINESS" ? "Продакшн" : "Я", timezone: "Europe/Moscow",
      minBalance: 0n, taxStatus: "ENTERED", taxHorizonUntil: addDays(this.s.asOf, 400), taxNote: "", stressDelayDays: 14,
      reconcileStaleDays: 7, monthlyMinimum: null, dataVersion: 1, ...over,
    };
    this.s.spaces.push(sp);
    return sp;
  }
  account(space: Space, opening: Minor, over: Partial<Account> = {}): Account {
    const a: Account = {
      id: id("acc"), spaceId: space.id, name: "Счёт", type: "BANK", openingBalance: opening, openingDate: this.s.asOf,
      reconciledAt: this.s.asOf, archived: false, ...over,
    };
    this.s.accounts.push(a);
    return a;
  }
  plan(space: Space, direction: "IN" | "OUT", amount: Minor, date: ISODate | null, over: Partial<PaymentPlan> = {}): PaymentPlan {
    const p: PaymentPlan = {
      id: id("plan"), spaceId: space.id, direction, amount, mgmtAmount: null, dueDate: date, expectedDate: null, expectedTime: null,
      counterpartyId: null, certainty: "CONTRACTED", effect: direction === "IN" ? "SALES" : "PROJECT_COST", title: `${direction} ${amount}`,
      basis: "", projectId: null, budgetLineId: null, fundingSourceId: null, partnerClaimId: null, loanId: null, category: null,
      inForecast: true, cancelledAt: null, cancelReason: "", recurrenceRuleId: null, occurrenceDate: null, linkedPlanId: null,
      createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, ...over,
    };
    this.s.plans.push(p);
    return p;
  }
  /** Проведённая операция: движения по счетам + необязательное погашение плана. */
  tx(space: Space, kind: Snapshot["transactions"][number]["kind"], moves: [Account, Minor][], over: Partial<Snapshot["transactions"][number]> = {}, settle?: { plan: PaymentPlan; amount: Minor }) {
    const t = {
      id: id("tx"), spaceId: space.id, kind, description: kind, status: "POSTED" as const, source: "MANUAL" as const,
      occurredOn: this.s.asOf, counterpartyId: null, projectId: null, category: null, effect: "NONE" as const, correctionOf: null,
      loanId: null, createdAt: "2026-01-01T00:00:00Z", ...over,
    };
    this.s.transactions.push(t);
    for (const [a, amt] of moves) this.s.entries.push({ id: id("e"), transactionId: t.id, accountId: a.id, amount: amt, effectiveOn: t.occurredOn });
    if (settle) this.s.settlements.push({ id: id("st"), transactionId: t.id, planId: settle.plan.id, amount: settle.amount, mgmtAmount: settle.amount, status: "ACTIVE" });
    return t;
  }
  reserve(space: Space, amount: Minor, over: Partial<Reserve> = {}): Reserve {
    const r: Reserve = { id: id("res"), spaceId: space.id, purpose: "Резерв", kind: "GOAL", planId: null, goalId: null, createdAt: `2026-01-01T00:00:${String(++seq).padStart(2, "0")}Z`, closed: false, ...over };
    this.s.reserves.push(r);
    if (amount > 0n) this.s.reserveEvents.push({ id: id("re"), reserveId: r.id, kind: "ALLOCATE", amount, date: this.s.asOf });
    return r;
  }
}

export const R = rub;
export type { UUID };
