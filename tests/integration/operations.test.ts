// Сохранение, доступ и идемпотентность на настоящем Postgres (PGlite) с теми же миграциями.
import { beforeAll, describe, expect, it } from "vitest";
import { rub } from "../../src/shared/money";
import { baseScenario, forecastSpace } from "../../src/modules/forecasting/forecast";
import { accountBalance, indexSnapshot, planRemaining, spaceCash } from "../../src/modules/forecasting/ledger";
import { projectEconomics } from "../../src/modules/forecasting/projects";
import { TestDb, key } from "./db";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const TODAY = new Date().toISOString().slice(0, 10);
const r = (n: number) => rub(n).toString();

let db: TestDb;
let me: string;
let biz: string;
let bizAcc: string;
let bizAcc2: string;
let meAcc: string;
let self: string;
let project: string;

async function insert(user: string, table: string, row: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(row);
  const res = await db.as<{ id: string }>(user, `insert into ${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
  return res[0].id;
}

beforeAll(async () => {
  db = await TestDb.create();
  await db.addUser(A, "kirill@example.com");
  await db.addUser(B, "other@example.com");
  await db.addUser(C, "stranger@example.com", false);
  const boot = await db.rpc<any>(A, "cfo_bootstrap");
  me = boot.personal_space_id;
  biz = boot.business_space_id;
  bizAcc = await insert(A, "cfo_accounts", { space_id: biz, name: "Расчётный", opening_balance: r(200_000), opening_date: TODAY, reconciled_at: TODAY });
  bizAcc2 = await insert(A, "cfo_accounts", { space_id: biz, name: "Резервный", opening_balance: 0, opening_date: TODAY, reconciled_at: TODAY });
  meAcc = await insert(A, "cfo_accounts", { space_id: me, name: "Карта", opening_balance: r(100_000), opening_date: TODAY, reconciled_at: TODAY });
  self = (await db.as<{ id: string }>(A, "select id from cfo_counterparties where space_id = $1 and is_self", [biz]))[0].id;
  project = await insert(A, "cfo_projects", { space_id: biz, name: "Сериал для клиента", model: "SERVICE", stage: "SHOOTING", end_date: "2027-01-01" });
}, 60_000);

describe("вход и пространства", () => {
  it("первичная настройка создаёт два пространства, повтор не дублирует", async () => {
    const again = await db.rpc<any>(A, "cfo_bootstrap");
    expect(again.personal_space_id).toBe(me);
    const spaces = await db.as(A, "select type from cfo_spaces order by type");
    expect(spaces.map((x: any) => x.type)).toEqual(["BUSINESS", "PERSONAL"]);
  });
  it("аккаунт без разрешения не получает пространств", async () => {
    const e = await db.rpcError(C, "cfo_bootstrap");
    expect(e.code).toBe("NOT_ALLOWED");
    expect(e.http).toBe(403);
  });
});

describe("операции", () => {
  it("T01: атомарный перевод", async () => {
    await db.rpc(A, "cfo_transfer", { space_id: biz, idempotency_key: key(), from_account_id: bizAcc, to_account_id: bizAcc2, amount: r(50_000), occurred_on: TODAY });
    const { s } = await db.snapshot(A, TODAY);
    const ix = indexSnapshot(s);
    expect(accountBalance(ix, s.accounts.find((a) => a.id === bizAcc)!)).toBe(rub(150_000));
    expect(accountBalance(ix, s.accounts.find((a) => a.id === bizAcc2)!)).toBe(rub(50_000));
    expect(spaceCash(ix, biz)).toBe(rub(200_000));
  });

  it("T02 + переплата: план погашается фактом, лишнее — отклоняется", async () => {
    const plan = await insert(A, "cfo_payment_plans", { space_id: biz, direction: "IN", amount: r(400_000), due_date: TODAY, effect: "SALES", title: "Второй платёж", project_id: project });
    const over = await db.rpcError(A, "cfo_post_transaction", {
      space_id: biz, idempotency_key: key(), kind: "CLIENT_RECEIPT", effect: "SALES", occurred_on: TODAY, project_id: project,
      entries: [{ account_id: bizAcc, amount: r(500_000) }], settlements: [{ plan_id: plan, amount: r(500_000) }],
    });
    expect(over.code).toBe("OVERPAY_PLAN");
    await db.rpc(A, "cfo_post_transaction", {
      space_id: biz, idempotency_key: key(), kind: "CLIENT_RECEIPT", effect: "SALES", occurred_on: TODAY, project_id: project,
      entries: [{ account_id: bizAcc, amount: r(400_000) }], settlements: [{ plan_id: plan, amount: r(400_000) }],
    });
    const { s } = await db.snapshot(A, TODAY);
    const ix = indexSnapshot(s);
    expect(planRemaining(ix, s.plans.find((p) => p.id === plan)!)).toBe(0n);
    expect(forecastSpace(s, biz, baseScenario(), {}, ix).events.some((e) => e.planId === plan)).toBe(false);
  });

  it("T03 + T11: договорённость заменяет оценку; частичная оплата", async () => {
    const line = await insert(A, "cfo_budget_lines", { space_id: biz, project_id: project, category: "Монтаж", stage: "POSTPRODUCTION", original_amount: r(100_000), original_mgmt: r(100_000) });
    const est = await insert(A, "cfo_payment_plans", { space_id: biz, direction: "OUT", amount: r(100_000), certainty: "ESTIMATE", due_date: "2026-12-01", effect: "PROJECT_COST", title: "Монтаж — оценка", project_id: project, budget_line_id: line });
    const agreed = await db.rpc<any>(A, "cfo_agree_cost", {
      space_id: biz, idempotency_key: key(), project_id: project, budget_line_id: line, title: "Монтаж", counterparty_id: null, total: r(90_000),
      parts: [{ amount: r(45_000), date: TODAY }, { amount: r(45_000), date: "2026-10-20" }], replace_plan_ids: [est],
    });
    expect(agreed.plan_ids.length).toBe(2);
    let { s } = await db.snapshot(A, TODAY);
    let e = projectEconomics(s, indexSnapshot(s), project);
    const mont = e.lines.find((l) => l.lineId === line)!;
    expect(mont.forecast).toBe(rub(90_000));
    expect(mont.original).toBe(rub(100_000));
    await db.rpc(A, "cfo_post_transaction", {
      space_id: biz, idempotency_key: key(), kind: "EXPENSE", effect: "PROJECT_COST", occurred_on: TODAY,
      entries: [{ account_id: bizAcc, amount: "-" + r(45_000) }], settlements: [{ plan_id: agreed.plan_ids[0], amount: r(45_000) }],
    });
    ({ s } = await db.snapshot(A, TODAY));
    e = projectEconomics(s, indexSnapshot(s), project);
    const after = e.lines.find((l) => l.lineId === line)!;
    expect(after.paid).toBe(rub(45_000));
    expect(after.agreed).toBe(rub(45_000));
    expect(after.forecast).toBe(rub(90_000));
  });

  it("T05: оплатил за компанию личными — затрата один раз, возврат закрывает долг", async () => {
    const res = await db.rpc<any>(A, "cfo_paid_for_company", {
      personal_space_id: me, business_space_id: biz, idempotency_key: key(), personal_account_id: meAcc, amount: r(30_000),
      occurred_on: TODAY, description: "Локация", project_id: project, reimburse_on: "2026-12-15",
    });
    let { s } = await db.snapshot(A, TODAY);
    const costBefore = projectEconomics(s, indexSnapshot(s), project).paid;
    await db.rpc(A, "cfo_owner_payout", {
      personal_space_id: me, business_space_id: biz, idempotency_key: key(), business_account_id: bizAcc, personal_account_id: meAcc,
      amount: r(30_000), occurred_on: TODAY, basis: "REIMBURSEMENT", claim_id: res.claim_id, plan_id: res.business_plan_id,
    });
    ({ s } = await db.snapshot(A, TODAY));
    const ix = indexSnapshot(s);
    expect(projectEconomics(s, ix, project).paid).toBe(costBefore);
    expect(s.costRecords.filter((c) => c.paidByCounterpartyId === self).length).toBe(1);
    expect(planRemaining(ix, s.plans.find((p) => p.id === res.business_plan_id)!)).toBe(0n);
    expect(planRemaining(ix, s.plans.find((p) => p.id === res.personal_plan_id)!)).toBe(0n);
    expect(spaceCash(ix, me)).toBe(rub(100_000));
    expect(s.transactions.filter((t) => t.spaceId === me && t.effect === "PERSONAL_CONSUMPTION").length).toBe(0);
  });

  it("T13: выплата себе сверх основания отклоняется сервером", async () => {
    const claim = await insert(A, "cfo_partner_claims", { space_id: biz, counterparty_id: self, direction: "COMPANY_OWES", basis: "REIMBURSEMENT", amount: r(30_000), approved: true });
    const e = await db.rpcError(A, "cfo_owner_payout", {
      personal_space_id: me, business_space_id: biz, idempotency_key: key(), business_account_id: bizAcc, personal_account_id: meAcc,
      amount: r(100_000), occurred_on: TODAY, basis: "REIMBURSEMENT", claim_id: claim,
    });
    expect(e.code).toBe("BASIS_LIMIT");
  });

  it("T17: резерв не превышает незарезервированные деньги", async () => {
    const acc = await insert(A, "cfo_accounts", { space_id: me, name: "Накопительный", type: "SAVINGS", opening_balance: 0, opening_date: TODAY, reconciled_at: TODAY });
    void acc;
    const { s } = await db.snapshot(A, TODAY);
    const free = spaceCash(indexSnapshot(s), me);
    const part = (free * 8n) / 10n;
    await db.rpc(A, "cfo_reserve_change", { space_id: me, idempotency_key: key(), action: "ALLOCATE", amount: part.toString(), new_reserve: { purpose: "Подушка", kind: "GOAL" } });
    const e = await db.rpcError(A, "cfo_reserve_change", { space_id: me, idempotency_key: key(), action: "ALLOCATE", amount: part.toString(), new_reserve: { purpose: "Отпуск", kind: "GOAL" } });
    expect(e.code).toBe("RESERVE_EXCEEDS_FREE");
    expect(e.http).toBe(409);
    const reserved = await db.as<{ s: string }>(A, "select coalesce(sum(amount),0)::text as s from cfo_reserve_events where space_id = $1", [me]);
    expect(BigInt(reserved[0].s)).toBe(part);
  });

  it("T18: повтор с тем же ключом — одна операция; другое тело — конфликт", async () => {
    const k = key();
    const body = { space_id: biz, idempotency_key: k, kind: "EXPENSE", effect: "OVERHEAD_COST", occurred_on: TODAY, description: "Сервисы", entries: [{ account_id: bizAcc, amount: "-" + r(1_000) }] };
    const first = await db.rpc<any>(A, "cfo_post_transaction", body);
    const second = await db.rpc<any>(A, "cfo_post_transaction", body);
    expect(second.transaction_id).toBe(first.transaction_id);
    expect(second.replayed).toBe(true);
    const n = await db.as<{ n: number }>(A, "select count(*)::int as n from cfo_account_entries where transaction_id = $1", [first.transaction_id]);
    expect(n[0].n).toBe(1);
    const e = await db.rpcError(A, "cfo_post_transaction", { ...body, description: "Другое" });
    expect(e.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(e.http).toBe(409);
  });

  it("T20: исправление 10 000 → 12 000 со сторно и историей", async () => {
    const plan = await insert(A, "cfo_payment_plans", { space_id: biz, direction: "OUT", amount: r(12_000), due_date: TODAY, effect: "OVERHEAD_COST", title: "Аренда оборудования" });
    const t = await db.rpc<any>(A, "cfo_post_transaction", {
      space_id: biz, idempotency_key: key(), kind: "EXPENSE", effect: "OVERHEAD_COST", occurred_on: TODAY, description: "Оборудование",
      entries: [{ account_id: bizAcc, amount: "-" + r(10_000) }], settlements: [{ plan_id: plan, amount: r(10_000) }],
    });
    let { s } = await db.snapshot(A, TODAY);
    const before = accountBalance(indexSnapshot(s), s.accounts.find((a) => a.id === bizAcc)!);
    const c = await db.rpc<any>(A, "cfo_correct_transaction", {
      space_id: biz, idempotency_key: key(), transaction_id: t.transaction_id, reason: "Сумма по чеку 12 000",
      replacement: { kind: "EXPENSE", effect: "OVERHEAD_COST", occurred_on: TODAY, description: "Оборудование", entries: [{ account_id: bizAcc, amount: "-" + r(12_000) }], settlements: [{ plan_id: plan, amount: r(12_000) }] },
    });
    ({ s } = await db.snapshot(A, TODAY));
    const ix = indexSnapshot(s);
    expect(accountBalance(ix, s.accounts.find((a) => a.id === bizAcc)!)).toBe(before + rub(10_000) - rub(12_000));
    expect(s.transactions.find((x) => x.id === t.transaction_id)!.status).toBe("REVERSED");
    expect(s.transactions.find((x) => x.id === c.storno_id)!.correctionOf).toBe(t.transaction_id);
    expect(planRemaining(ix, s.plans.find((p) => p.id === plan)!)).toBe(0n);
    expect(s.settlements.filter((x) => x.planId === plan && x.status === "ACTIVE").length).toBe(1);
    expect(s.costRecords.filter((x) => x.planId === plan && x.status === "ACTIVE").map((x) => x.amount)).toEqual([rub(12_000)]);
    const again = await db.rpcError(A, "cfo_correct_transaction", { space_id: biz, idempotency_key: key(), transaction_id: t.transaction_id, reason: "ещё раз" });
    expect(again.code).toBe("ALREADY_REVERSED");
    const hist = await db.as(A, "select * from cfo_audit($1, $2)", [biz, t.transaction_id]);
    expect(hist.length).toBeGreaterThanOrEqual(2);
  });

  it("T30: операция раньше точки открытия блокируется", async () => {
    const e = await db.rpcError(A, "cfo_post_transaction", {
      space_id: biz, idempotency_key: key(), kind: "EXPENSE", effect: "NONE", occurred_on: "2020-01-01", entries: [{ account_id: bizAcc, amount: "-100" }],
    });
    expect(e.code).toBe("BEFORE_OPENING");
  });

  it("T19: повтор файла и external_id не дублируются; похожие строки ждут решения", async () => {
    const rows = [
      { row_no: 1, external_id: "bank-1", date: TODAY, account_id: bizAcc, direction: "OUT", amount: r(700), kind: "EXPENSE", description: "Такси" },
      { row_no: 2, external_id: "bank-2", date: TODAY, account_id: bizAcc, direction: "IN", amount: r(5_000), kind: "INCOME", description: "Возврат" },
    ];
    const one = await db.rpc<any>(A, "cfo_import_commit", { space_id: biz, idempotency_key: key(), fingerprint: "file-1", file_name: "a.csv", rows });
    expect(one.imported).toBe(2);
    const rep = await db.rpc<any>(A, "cfo_import_commit", { space_id: biz, idempotency_key: key(), fingerprint: "file-1", file_name: "a.csv", rows });
    expect(rep.duplicate_file).toBe(true);
    const other = await db.rpc<any>(A, "cfo_import_commit", {
      space_id: biz, idempotency_key: key(), fingerprint: "file-2", file_name: "b.csv",
      rows: [{ ...rows[0], row_no: 1 }, { row_no: 2, date: TODAY, account_id: bizAcc, direction: "OUT", amount: r(700), kind: "EXPENSE", description: "Такси", decision: "REVIEW" }],
    });
    expect(other.counts.DUPLICATE).toBe(1);
    expect(other.counts.CONFLICT).toBe(1);
    const { s } = await db.snapshot(A, TODAY);
    expect(s.importConflicts.length).toBe(1);
    expect(forecastSpace(s, biz, baseScenario()).quality.issues.map((i) => i.code)).toContain("IMPORT_CONFLICTS");
  });

  it("T24/T31 на сервере: наибольшие остатки, сумма пула сходится", async () => {
    const [n1, n2] = (await db.as<{ id: string }>(A, "select id from cfo_counterparties where space_id = $1 and not is_self order by sort_order", [biz])).map((x) => x.id);
    const res = await db.rpc<any>(A, "cfo_create_distribution", {
      space_id: biz, idempotency_key: key(), period: "тест", amount: "2", approved_on: TODAY,
      recipients: [{ counterparty_id: self, share_bp: 2500 }, { counterparty_id: n1, share_bp: 2500 }, { counterparty_id: n2, share_bp: 2500 }, { counterparty_id: self, share_bp: 2500 }],
    });
    const amounts = await db.as<{ a: string }>(A, "select amount::text as a from cfo_partner_claims where pool_id = $1 order by created_at", [res.pool_id]);
    expect(amounts.map((x) => x.a)).toEqual(["1", "1"]);
    const bad = await db.rpcError(A, "cfo_create_distribution", { space_id: biz, idempotency_key: key(), amount: "100", approved_on: TODAY, recipients: [{ counterparty_id: self, share_bp: 5000 }] });
    expect(bad.code).toBe("SHARES_NOT_100");
  });
});

describe("доступ", () => {
  it("T21: чужой пользователь не видит и не меняет данные по известному ID", async () => {
    await db.rpc(B, "cfo_bootstrap");
    const rows = await db.as(B, "select * from cfo_accounts where id = $1", [bizAcc]);
    expect(rows.length).toBe(0);
    const snap = await db.rpc<any>(B, "cfo_snapshot");
    expect(JSON.stringify(snap)).not.toContain("Расчётный");
    expect(JSON.stringify(snap)).not.toContain(biz);
    const e = await db.rpcError(B, "cfo_post_transaction", { space_id: biz, idempotency_key: key(), kind: "EXPENSE", occurred_on: TODAY, entries: [{ account_id: bizAcc, amount: "-1" }] });
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).not.toContain("Расчётный");
    await expect(db.as(B, "select * from cfo_audit($1)", [biz])).rejects.toThrow();
    await expect(db.as(B, "update cfo_payment_plans set title = 'x' where space_id = $1 returning id", [biz])).resolves.toEqual([]);
    await expect(db.as(B, "insert into cfo_payment_plans (space_id, direction, amount, due_date, effect) values ($1, 'OUT', 1, now(), 'NONE')", [biz])).rejects.toThrow();
  });

  it("чужой проект нельзя привязать к плану; движения нельзя менять напрямую", async () => {
    const bBiz = (await db.as<{ id: string }>(B, "select id from cfo_spaces where type = 'BUSINESS'"))[0].id;
    const bProject = await insert(B, "cfo_projects", { space_id: bBiz, name: "Проект B", model: "SERVICE" });
    await expect(insert(A, "cfo_payment_plans", { space_id: biz, direction: "OUT", amount: 100, due_date: TODAY, effect: "NONE", project_id: bProject })).rejects.toThrow();
    await expect(db.as(A, "update cfo_account_entries set amount = 1")).rejects.toThrow();
    await expect(db.as(A, "insert into cfo_transactions (space_id, kind, occurred_on) values ($1, 'EXPENSE', now())", [biz])).rejects.toThrow();
  });
});
