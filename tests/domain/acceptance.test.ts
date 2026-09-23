// Приёмочные сценарии раздела 13 на уровне расчётного модуля.
// Операции записи (атомарность, идемпотентность, доступ) проверяются в tests/integration.
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/shared/dates";
import { allocateLargestRemainder, parseRub, rub } from "../../src/shared/money";
import { baseScenario, forecastSpace, stressScenario } from "../../src/modules/forecasting/forecast";
import { accountBalance, indexSnapshot, planRemaining, planStatus, spaceCash } from "../../src/modules/forecasting/ledger";
import { computeDistribution, loansSummary } from "../../src/modules/forecasting/partners";
import { projectEconomics } from "../../src/modules/forecasting/projects";
import { simulate } from "../../src/modules/forecasting/simulate";
import { B, id } from "../fixtures";

const base = baseScenario();

describe("Этап A — остатки и обязательства", () => {
  it("T01: перевод между счетами не меняет деньги пространства", () => {
    const b = new B();
    const sp = b.space();
    const a1 = b.account(sp, rub(200_000));
    const a2 = b.account(sp, 0n);
    b.tx(sp, "TRANSFER", [[a1, -rub(50_000)], [a2, rub(50_000)]], { effect: "INTERNAL_TRANSFER" });
    const ix = indexSnapshot(b.s);
    expect(accountBalance(ix, a1)).toBe(rub(150_000));
    expect(accountBalance(ix, a2)).toBe(rub(50_000));
    expect(spaceCash(ix, sp.id)).toBe(rub(200_000));
  });

  it("T02: полученный платёж погашает план, прогноз не добавляет его повторно", () => {
    const b = new B();
    const sp = b.space();
    const a = b.account(sp, 0n);
    const p = b.plan(sp, "IN", rub(400_000), b.d(0));
    b.tx(sp, "CLIENT_RECEIPT", [[a, rub(400_000)]], { effect: "SALES" }, { plan: p, amount: rub(400_000) });
    const ix = indexSnapshot(b.s);
    expect(spaceCash(ix, sp.id)).toBe(rub(400_000));
    expect(planRemaining(ix, p)).toBe(0n);
    const f = forecastSpace(b.s, sp.id, base, {}, ix);
    expect(f.events.length).toBe(0);
    expect(f.endCash).toBe(rub(400_000));
  });

  it("T03: частичная оплата уменьшает только остаток плана", () => {
    const b = new B();
    const sp = b.space();
    const a = b.account(sp, rub(100_000));
    const p = b.plan(sp, "OUT", rub(90_000), b.d(5));
    b.tx(sp, "EXPENSE", [[a, -rub(45_000)]], { effect: "PROJECT_COST" }, { plan: p, amount: rub(45_000) });
    const ix = indexSnapshot(b.s);
    expect(planRemaining(ix, p)).toBe(rub(45_000));
    expect(planStatus(ix, p)).toBe("PARTIALLY_PAID");
    const f = forecastSpace(b.s, sp.id, base, {}, ix);
    expect(f.events.map((e) => e.deltaC)).toEqual([-rub(45_000)]);
    expect(f.endCash).toBe(rub(10_000));
  });

  it("T04: заём увеличивает деньги и основной долг, но не маржу проекта", () => {
    const b = new B();
    const sp = b.space();
    const a = b.account(sp, 0n);
    const loan = { id: id("loan"), spaceId: sp.id, lenderCounterpartyId: null, lenderName: "Банк", contractAmount: rub(500_000), note: "" };
    b.s.loans.push(loan);
    const pr = { id: id("pr"), spaceId: sp.id, name: "Сериал", directionId: null, model: "SERVICE" as const, stage: "SHOOTING" as const, clientId: null, startDate: null, endDate: b.d(60), inForecast: true, metrics: {}, notes: "" };
    b.s.projects.push(pr);
    b.s.revenueAgreements.push({ id: id("ra"), projectId: pr.id, clientId: null, amount: rub(1_000_000), mgmtAmount: rub(1_000_000), status: "SIGNED", reference: "", isExtraWork: false });
    const before = projectEconomics(b.s, indexSnapshot(b.s), pr.id).margin;
    b.tx(sp, "LOAN_IN", [[a, rub(500_000)]], { effect: "FINANCING", loanId: loan.id, projectId: pr.id });
    const ix = indexSnapshot(b.s);
    expect(spaceCash(ix, sp.id)).toBe(rub(500_000));
    expect(loansSummary(b.s, sp.id)[0].outstanding).toBe(rub(500_000));
    expect(projectEconomics(b.s, ix, pr.id).margin).toBe(before);
    expect(projectEconomics(b.s, ix, pr.id).received).toBe(0n);
  });

  it("T05: расход партнёра за компанию — затрата один раз, возврат закрывает долг", () => {
    const b = new B();
    const biz = b.space("BUSINESS");
    const me = b.space("PERSONAL");
    const bizAcc = b.account(biz, rub(100_000));
    const meAcc = b.account(me, rub(50_000));
    const self = { id: id("cp"), spaceId: biz.id, name: "Кирилл", types: ["PARTNER" as const], isSelf: true, sortOrder: 0 };
    b.s.counterparties.push(self);
    const pr = { id: id("pr"), spaceId: biz.id, name: "Фильм", directionId: null, model: "SERVICE" as const, stage: "SHOOTING" as const, clientId: null, startDate: null, endDate: b.d(30), inForecast: true, metrics: {}, notes: "" };
    b.s.projects.push(pr);
    // Личный расход с эффектом финансирования
    const t1 = b.tx(me, "CROSS_SPACE", [[meAcc, -rub(30_000)]], { effect: "FINANCING", category: null });
    b.s.costRecords.push({ id: id("cr"), spaceId: biz.id, budgetLineId: null, projectId: pr.id, amount: rub(30_000), mgmtAmount: rub(30_000), paidByCounterpartyId: self.id, transactionId: t1.id, planId: null, occurredOn: b.s.asOf, status: "ACTIVE" });
    const claim = { id: id("cl"), spaceId: biz.id, counterpartyId: self.id, direction: "COMPANY_OWES" as const, basis: "REIMBURSEMENT" as const, amount: rub(30_000), approved: true, note: "Локация", costRecordId: null, poolId: null, createdAt: "", cancelled: false };
    b.s.claims.push(claim);
    const reimb = b.plan(biz, "OUT", rub(30_000), b.d(3), { effect: "REIMBURSEMENT", partnerClaimId: claim.id });
    // Возмещение
    b.tx(biz, "REIMBURSEMENT", [[bizAcc, -rub(30_000)]], { effect: "REIMBURSEMENT" }, { plan: reimb, amount: rub(30_000) });
    b.tx(me, "REIMBURSEMENT", [[meAcc, rub(30_000)]], { effect: "REIMBURSEMENT" });
    const ix = indexSnapshot(b.s);
    const e = projectEconomics(b.s, ix, pr.id);
    expect(e.paid).toBe(rub(30_000));
    expect(e.forecastCost).toBe(rub(30_000));
    // личное потребление 0 — операции без личной категории
    expect(b.s.transactions.filter((t) => t.spaceId === me.id && t.effect === "PERSONAL_CONSUMPTION").length).toBe(0);
    expect(spaceCash(ix, me.id)).toBe(rub(50_000));
    expect(planRemaining(ix, reimb)).toBe(0n);
  });

  it("T11: договорённость заменяет оценку, исходная смета сохраняется", () => {
    const b = new B();
    const sp = b.space();
    const pr = { id: id("pr"), spaceId: sp.id, name: "Сериал", directionId: null, model: "SERVICE" as const, stage: "POSTPRODUCTION" as const, clientId: null, startDate: null, endDate: b.d(40), inForecast: true, metrics: {}, notes: "" };
    b.s.projects.push(pr);
    const line = { id: id("bl"), spaceId: sp.id, projectId: pr.id, category: "Монтаж", stage: "POSTPRODUCTION" as const, originalAmount: rub(100_000), originalMgmt: rub(100_000), note: "" };
    b.s.budgetLines.push(line);
    const est = b.plan(sp, "OUT", rub(100_000), b.d(20), { certainty: "ESTIMATE", projectId: pr.id, budgetLineId: line.id });
    expect(projectEconomics(b.s, indexSnapshot(b.s), pr.id).forecastCost).toBe(rub(100_000));
    // Замена оценки договорённостью: тот же план становится CONTRACTED 90 000
    est.certainty = "CONTRACTED";
    est.amount = rub(90_000);
    const e = projectEconomics(b.s, indexSnapshot(b.s), pr.id);
    expect(e.forecastCost).toBe(rub(90_000));
    expect(e.original).toBe(rub(100_000));
    expect(e.variance).toBe(-rub(10_000));
  });

  it("T12: маржа по договорной выручке, независимо от аванса", () => {
    const b = new B();
    const sp = b.space();
    const a = b.account(sp, 0n);
    const pr = { id: id("pr"), spaceId: sp.id, name: "Сериал", directionId: null, model: "SERVICE" as const, stage: "SHOOTING" as const, clientId: null, startDate: null, endDate: b.d(60), inForecast: true, metrics: {}, notes: "" };
    b.s.projects.push(pr);
    b.s.revenueAgreements.push({ id: id("ra"), projectId: pr.id, clientId: null, amount: rub(1_000_000), mgmtAmount: rub(1_000_000), status: "SIGNED", reference: "", isExtraWork: false });
    b.s.costRecords.push({ id: id("cr"), spaceId: sp.id, budgetLineId: null, projectId: pr.id, amount: rub(200_000), mgmtAmount: rub(200_000), paidByCounterpartyId: null, transactionId: null, planId: null, occurredOn: b.s.asOf, status: "ACTIVE" });
    b.plan(sp, "OUT", rub(300_000), b.d(10), { projectId: pr.id });
    b.plan(sp, "OUT", rub(100_000), b.d(20), { projectId: pr.id, certainty: "ESTIMATE" });
    const e1 = projectEconomics(b.s, indexSnapshot(b.s), pr.id);
    expect(e1.forecastCost).toBe(rub(600_000));
    expect(e1.margin).toBe(rub(400_000));
    expect(e1.marginBp).toBe(4000n);
    b.tx(sp, "CLIENT_RECEIPT", [[a, rub(700_000)]], { effect: "SALES", projectId: pr.id });
    const e2 = projectEconomics(b.s, indexSnapshot(b.s), pr.id);
    expect(e2.margin).toBe(rub(400_000));
    expect(e2.received).toBe(rub(700_000));
  });

  it("T24: пул 100 ₽ по 33,33 / 33,33 / 33,34%", () => {
    const r = computeDistribution({ amount: rub(100), recipients: [
      { counterpartyId: "a", shareBp: 3333n, fixed: null, order: 0 },
      { counterpartyId: "b", shareBp: 3333n, fixed: null, order: 1 },
      { counterpartyId: "c", shareBp: 3334n, fixed: null, order: 2 },
    ] });
    expect(r.map((x) => x.amount)).toEqual([3333n, 3333n, 3334n]);
    expect(r.reduce((a, x) => a + x.amount, 0n)).toBe(rub(100));
  });

  it("T31: 2 копейки на четырёх по 25% → 1, 1, 0, 0", () => {
    expect(allocateLargestRemainder(2n, [2500n, 2500n, 2500n, 2500n])).toEqual([1n, 1n, 0n, 0n]);
  });

  it("T28: подтверждённое финансирование 1 млн, получено 400 тыс", () => {
    const b = new B();
    const sp = b.space();
    const a = b.account(sp, 0n);
    const pr = { id: id("pr"), spaceId: sp.id, name: "Фильм", directionId: null, model: "OWN_IP" as const, stage: "DEVELOPMENT" as const, clientId: null, startDate: null, endDate: b.d(200), inForecast: true, metrics: {}, notes: "" };
    b.s.projects.push(pr);
    const fs = { id: id("fs"), projectId: pr.id, kind: "INVESTOR" as const, name: "Инвестор", declared: rub(1_000_000), confirmed: rub(1_000_000), status: "CONFIRMED" as const, terms: "", isReallocation: false };
    b.s.fundingSources.push(fs);
    const p = b.plan(sp, "IN", rub(1_000_000), b.d(30), { effect: "FINANCING", fundingSourceId: fs.id, projectId: pr.id });
    b.tx(sp, "INCOME", [[a, rub(400_000)]], { effect: "FINANCING" }, { plan: p, amount: rub(400_000) });
    const e = projectEconomics(b.s, indexSnapshot(b.s), pr.id);
    expect(e.funding.confirmed).toBe(rub(1_000_000));
    expect(e.funding.received).toBe(rub(400_000));
    expect(e.funding.toReceive).toBe(rub(600_000));
  });

  it("T33: выделение имеющихся денег собственному фильму не создаёт дохода", () => {
    const b = new B();
    const sp = b.space();
    b.account(sp, rub(500_000));
    const pr = { id: id("pr"), spaceId: sp.id, name: "Фильм", directionId: null, model: "OWN_IP" as const, stage: "DEVELOPMENT" as const, clientId: null, startDate: null, endDate: b.d(200), inForecast: true, metrics: {}, notes: "" };
    b.s.projects.push(pr);
    b.s.fundingSources.push({ id: id("fs"), projectId: pr.id, kind: "OWN_FUNDS", name: "Деньги компании", declared: rub(200_000), confirmed: rub(200_000), status: "CONFIRMED", terms: "", isReallocation: true });
    const ix = indexSnapshot(b.s);
    expect(spaceCash(ix, sp.id)).toBe(rub(500_000));
    expect(forecastSpace(b.s, sp.id, base, {}, ix).events.length).toBe(0);
    const e = projectEconomics(b.s, ix, pr.id);
    expect(e.funding.confirmed).toBe(rub(200_000));
    expect(e.funding.ownInvestment).toBe(rub(200_000));
  });

  it("T30: операция до точки открытия не удваивает остаток", () => {
    const b = new B();
    const sp = b.space();
    const a = b.account(sp, rub(100_000), { openingDate: "2026-09-15" });
    b.tx(sp, "EXPENSE", [[a, -rub(20_000)]], { occurredOn: "2026-09-10" });
    expect(accountBalance(indexSnapshot(b.s), a)).toBe(rub(100_000));
  });
});

describe("Этап B — прогноз, лимит, симуляции", () => {
  it("T06: лимит 70 000 при минимальном остатке 100 000", () => {
    const b = new B();
    const sp = b.space("BUSINESS", { minBalance: rub(100_000) });
    b.account(sp, rub(1_000_000));
    b.plan(sp, "OUT", rub(600_000), b.d(5));
    b.plan(sp, "OUT", rub(80_000), b.d(10));
    b.plan(sp, "OUT", rub(150_000), b.d(20));
    const f = forecastSpace(b.s, sp.id, base);
    expect(f.limit).toBe(rub(70_000));
    expect(f.endCash).toBe(rub(170_000));
    expect(f.endFree).toBe(rub(70_000));
  });

  it("T07: оплата зарезервированного платежа не уменьшает лимит дважды", () => {
    const b = new B();
    const sp = b.space();
    b.account(sp, rub(200_000));
    const p = b.plan(sp, "OUT", rub(100_000), b.d(5));
    b.reserve(sp, rub(100_000), { kind: "PAYMENT_LINKED", planId: p.id, purpose: "Команда" });
    b.reserve(sp, rub(50_000), { purpose: "Подушка" });
    const f = forecastSpace(b.s, sp.id, base);
    expect(f.points[0].free).toBe(rub(50_000));
    expect(f.points[1].free).toBe(rub(50_000));
    expect(f.limit).toBe(rub(50_000));
  });

  it("T08: кассовая нехватка завтра не скрывается положительным концом", () => {
    const b = new B();
    const sp = b.space();
    b.account(sp, rub(100_000));
    b.plan(sp, "OUT", rub(150_000), b.d(1));
    b.plan(sp, "IN", rub(200_000), b.d(2));
    const f = forecastSpace(b.s, sp.id, base);
    expect(f.firstShortfall).toEqual({ date: b.d(1), amount: -rub(50_000), eventKey: expect.any(String) });
    expect(f.endCash).toBe(rub(150_000));
    expect(f.limit).toBe(0n);
  });

  it("T09: стресс-сценарий задержки на 14 дней", () => {
    const b = new B();
    const sp = b.space();
    b.account(sp, rub(100_000));
    b.plan(sp, "IN", rub(200_000), b.d(3));
    b.plan(sp, "OUT", rub(250_000), b.d(7));
    expect(forecastSpace(b.s, sp.id, base).limit).toBe(rub(50_000));
    const st = forecastSpace(b.s, sp.id, stressScenario(14));
    expect(st.firstShortfall?.amount).toBe(-rub(150_000));
    expect(st.limit).toBe(0n);
  });

  it("T10: внутридневной порядок — выплата раньше поступления", () => {
    const b = new B();
    const sp = b.space();
    b.account(sp, rub(100_000));
    b.plan(sp, "IN", rub(100_000), b.d(4));
    b.plan(sp, "OUT", rub(150_000), b.d(4));
    const f = forecastSpace(b.s, sp.id, base);
    expect(f.firstShortfall?.amount).toBe(-rub(50_000));
    expect(f.assumptions.join(" ")).toMatch(/раньше поступлений/);
  });

  it("T13: возмещение ограничено основанием 30 000", () => {
    const b = new B();
    const biz = b.space("BUSINESS");
    b.space("PERSONAL");
    b.account(biz, rub(1_000_000));
    const self = { id: id("cp"), spaceId: biz.id, name: "Кирилл", types: ["PARTNER" as const], isSelf: true, sortOrder: 0 };
    b.s.counterparties.push(self);
    b.s.claims.push({ id: id("cl"), spaceId: biz.id, counterpartyId: self.id, direction: "COMPANY_OWES", basis: "REIMBURSEMENT", amount: rub(30_000), approved: true, note: "", costRecordId: null, poolId: null, createdAt: "", cancelled: false });
    for (const s of b.s.spaces) if (s.type === "PERSONAL") b.account(s, 0n);
    const r = simulate(b.s, { spaceId: biz.id, kind: "OWNER_PAYOUT", amount: rub(100_000), date: b.d(0), title: "Себе", basis: "REIMBURSEMENT" });
    expect(r.basisLimit).toBe(rub(30_000));
    expect(r.verdict).toBe("NEEDS_DATA");
    expect(r.reasons.some((x) => x.code === "BASIS_LIMIT")).toBe(true);
  });

  it("T14: ранняя выплата существующего обязательства переносит его, а не удваивает", () => {
    const b = new B();
    const sp = b.space();
    b.account(sp, rub(300_000));
    const p = b.plan(sp, "OUT", rub(100_000), b.d(30));
    const r = simulate(b.s, { spaceId: sp.id, kind: "RESCHEDULE", movePlanId: p.id, amount: rub(100_000), date: b.d(2), title: "Раньше" });
    const out = r.base.after.events.filter((e) => e.deltaC < 0n);
    expect(out.length).toBe(1);
    expect(out[0].date).toBe(b.d(2));
    expect(r.base.after.endCash).toBe(rub(200_000));
  });

  it("T15: симуляция не меняет рабочие данные", () => {
    const b = new B();
    const sp = b.space();
    b.account(sp, rub(500_000));
    const before = JSON.stringify(b.s, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const r = simulate(b.s, { spaceId: sp.id, kind: "INVESTMENT", amount: rub(200_000), date: b.d(3), title: "ИИ-продакшн" });
    expect(r.base.after.endCash).toBe(rub(300_000));
    expect(JSON.stringify(b.s, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
  });

  it("T16: без налогов или без даты затраты лимит null", () => {
    const b = new B();
    const sp = b.space("BUSINESS", { taxStatus: "NOT_SET" });
    b.account(sp, rub(500_000));
    const f1 = forecastSpace(b.s, sp.id, base);
    expect(f1.limit).toBeNull();
    expect(f1.quality.status).toBe("INSUFFICIENT");
    sp.taxStatus = "ENTERED";
    const pr = { id: id("pr"), spaceId: sp.id, name: "Сериал", directionId: null, model: "SERVICE" as const, stage: "SHOOTING" as const, clientId: null, startDate: null, endDate: b.d(30), inForecast: true, metrics: {}, notes: "" };
    b.s.projects.push(pr);
    b.plan(sp, "OUT", rub(50_000), null, { certainty: "ESTIMATE", projectId: pr.id });
    const f2 = forecastSpace(b.s, sp.id, base);
    expect(f2.limit).toBeNull();
    expect(f2.quality.issues.map((i) => i.code)).toContain("UNDATED_COSTS");
    const sim = simulate(b.s, { spaceId: sp.id, kind: "EXPENSE", amount: rub(10_000), date: b.d(0), title: "Трата" });
    expect(sim.verdict).toBe("NEEDS_DATA");
    expect(sim.maxOnDate).toBeNull();
  });

  it("T23: выплата на 110-й день за окном 13 недель учитывается в решении", () => {
    const b = new B();
    const sp = b.space();
    b.account(sp, rub(100_000));
    const pr = { id: id("pr"), spaceId: sp.id, name: "Фильм", directionId: null, model: "SERVICE" as const, stage: "SHOOTING" as const, clientId: null, startDate: null, endDate: b.d(120), inForecast: true, metrics: {}, notes: "" };
    b.s.projects.push(pr);
    b.plan(sp, "OUT", rub(150_000), b.d(110), { projectId: pr.id });
    const f = forecastSpace(b.s, sp.id, base);
    expect(f.horizonEnd).toBe(b.d(90));
    expect(f.decisionEnd).toBe(b.d(120));
    expect(f.daily.length).toBe(91);
    expect(f.firstShortfall?.date).toBe(b.d(110));
    expect(f.limit).toBe(0n);
  });

  it("T25: переменный бюджет 30 000, факт 10 000, план 5 000", () => {
    const b = new B("2026-10-11");
    const me = b.space("PERSONAL");
    const a = b.account(me, rub(100_000), { openingDate: "2026-10-01", reconciledAt: "2026-10-11" });
    b.s.budgets.push({ id: id("bud"), spaceId: me.id, month: null, category: "Еда", limit: rub(30_000), kind: "VARIABLE", inMinimum: false });
    b.tx(me, "EXPENSE", [[a, -rub(10_000)]], { category: "Еда", occurredOn: "2026-10-05", effect: "PERSONAL_CONSUMPTION" });
    b.plan(me, "OUT", rub(5_000), "2026-10-20", { category: "Еда", effect: "PERSONAL_CONSUMPTION" });
    const f = forecastSpace(b.s, me.id, base, { horizonDays: 20 });
    const october = f.events.filter((e) => e.date <= "2026-10-31");
    const budget = october.filter((e) => e.kind === "BUDGET").reduce((a2, e) => a2 - e.deltaC, 0n);
    const plans = october.filter((e) => e.kind === "PLAN").reduce((a2, e) => a2 - e.deltaC, 0n);
    expect(budget).toBe(rub(15_000));
    expect(budget + plans).toBe(rub(20_000));
    // равномерно по 21 дню: 71428 коп × 20 + остаток в последний день
    const days = october.filter((e) => e.kind === "BUDGET");
    expect(days.length).toBe(21);
    expect(days[days.length - 1].deltaC).toBe(-(rub(15_000) - 71_428n * 20n));
  });

  it("T26: накопительный счёт и резерв цели не вычитаются дважды", () => {
    const b = new B();
    const me = b.space("PERSONAL");
    b.account(me, rub(50_000), { type: "SAVINGS" });
    b.reserve(me, rub(50_000), { purpose: "Отпуск" });
    const f = forecastSpace(b.s, me.id, base);
    expect(f.startCash).toBe(rub(50_000));
    expect(f.startReserved).toBe(rub(50_000));
    expect(f.points[0].free).toBe(0n);
  });

  it("T27: будущий взнос в цель меняет R, не C", () => {
    const b = new B();
    const me = b.space("PERSONAL");
    b.account(me, rub(100_000));
    const r = b.reserve(me, 0n, { purpose: "Цель" });
    b.s.reserveSchedules.push({ id: id("rs"), reserveId: r.id, date: b.d(5), amount: rub(20_000), status: "PLANNED" });
    const f = forecastSpace(b.s, me.id, base);
    expect(f.endCash).toBe(rub(100_000));
    const after = f.points[f.points.length - 1];
    expect(after.R).toBe(rub(20_000));
    expect(after.free).toBe(rub(80_000));
  });

  it("T29: просроченное поступление без новой даты не считается деньгами сегодня", () => {
    const b = new B();
    const sp = b.space();
    b.account(sp, rub(10_000));
    b.plan(sp, "IN", rub(200_000), b.d(-5));
    const f = forecastSpace(b.s, sp.id, base);
    expect(f.events.length).toBe(0);
    expect(f.excludedOverdueIncoming.length).toBe(1);
    expect(f.endCash).toBe(rub(10_000));
  });

  it("T32: покупка внутри переменного бюджета заменяет часть оценки", () => {
    const b = new B("2026-10-01");
    const me = b.space("PERSONAL");
    b.account(me, rub(30_000));
    b.s.budgets.push({ id: id("bud"), spaceId: me.id, month: "2026-10", category: "Покупки", limit: rub(30_000), kind: "VARIABLE", inMinimum: false });
    const sim = simulate(b.s, { spaceId: me.id, kind: "EXPENSE", amount: rub(5_000), date: b.d(0), title: "Кроссовки", category: "Покупки", effect: "PERSONAL_CONSUMPTION" });
    const total = (f: typeof sim.base.after) => f.events.reduce((a, e) => a - e.deltaC, 0n);
    const budgetAfter = sim.base.after.events.filter((e) => e.kind === "BUDGET").reduce((a, e) => a - e.deltaC, 0n);
    expect(budgetAfter).toBe(rub(25_000));
    expect(total(sim.base.before)).toBe(rub(30_000));
    expect(total(sim.base.after)).toBe(rub(30_000));
    expect(sim.base.after.firstShortfall).toBeNull();
    expect(sim.base.after.minFree.amount).toBe(0n);
    expect(sim.verdict).toBe("WITHIN_LIMIT");
  });
});

describe("Деньги и даты", () => {
  it("разбор сумм без float", () => {
    expect(parseRub("1 234,56")).toBe(123_456n);
    expect(parseRub("450000")).toBe(45_000_000n);
    expect(parseRub("0.1")).toBe(10n);
    expect(parseRub("abc")).toBeNull();
  });
  it("31-е в коротком месяце → последний день", async () => {
    const { recurrenceDates } = await import("../../src/modules/forecasting/forecast");
    const rule = { id: "r", spaceId: "s", freq: "MONTHLY" as const, day: 31, startDate: "2026-01-31", endDate: null, active: true, template: {} as never };
    expect(recurrenceDates(rule, "2026-01-01", "2026-04-30")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });
  it("перенос даты не скрывает просрочку по исходному сроку", () => {
    const b = new B();
    const sp = b.space();
    b.account(sp, rub(10_000));
    b.plan(sp, "IN", rub(50_000), b.d(-3), { expectedDate: b.d(4) });
    const f = forecastSpace(b.s, sp.id, base);
    expect(f.events[0].date).toBe(addDays(b.s.asOf, 4));
    expect(f.events[0].overdue).toBe(true);
  });
});
