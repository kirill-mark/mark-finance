// Демо-набор: вымышленные цифры, только в памяти браузера, никогда не записывается в базу.
// Даты привязаны к сегодняшнему дню, чтобы все экраны показывали живую картину.
import { addDays, monthKey, todayIn } from "../shared/dates";
import type { DbSnapshot } from "../modules/data/snapshot";

const r = (rub: number) => String(Math.round(rub * 100));
let n = 0;
const id = (p: string) => `demo-${p}-${String(++n).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(0, 36);

export function demoSnapshot(): DbSnapshot & Record<string, any> {
  n = 0;
  const t = todayIn();
  const d = (k: number) => addDays(t, k);
  const me = id("me"), biz = id("biz");
  const accBiz = id("acc"), accBiz2 = id("acc"), accMe = id("acc"), accSave = id("acc");
  const self = id("cp"), nikita = id("cp"), sergey = id("cp"), client = id("cp"), editor = id("cp");
  const dirFilm = id("dir"), dirVert = id("dir"), dirAi = id("dir");
  const pVert = id("prj"), pFilm = id("prj"), pAi = id("prj");
  const lineEdit = id("bl"), lineShoot = id("bl"), lineFilm = id("bl"), lineGpu = id("bl");
  const fsFilm = id("fs");
  const pIn2 = id("pl"), pIn3 = id("pl"), pEdit1 = id("pl"), pEdit2 = id("pl"), pTeam = id("pl"), pTax = id("pl"), pFilmIn = id("pl"), pLate = id("pl"), pReimb = id("pl"), pReimbMe = id("pl"), pRent = id("pl");
  const claimReimb = id("cl");
  const resTax = id("res"), resCushion = id("res");
  const goalCushion = id("goal");
  const tx1 = id("tx"), tx2 = id("tx"), tx3 = id("tx"), tx4 = id("tx");
  const ts = new Date().toISOString();
  const common = { created_at: ts, updated_at: ts, version: 1 };
  const plan = (o: Record<string, any>) => ({
    ...common, mgmt_amount: null, expected_date: null, expected_time: null, counterparty_id: null, certainty: "CONTRACTED", basis: "", project_id: null,
    budget_line_id: null, funding_source_id: null, partner_claim_id: null, loan_id: null, category: null, in_forecast: true, cancelled_at: null,
    cancel_reason: "", recurrence_rule_id: null, occurrence_date: null, linked_plan_id: null, ...o,
  });
  return {
    spaces: [
      { ...common, id: biz, type: "BUSINESS", name: "Продакшн (демо)", timezone: "Europe/Moscow", min_balance: r(150_000), tax_status: "ENTERED", tax_horizon_until: d(120), tax_note: "Демо", stress_delay_days: 14, reconcile_stale_days: 7, monthly_minimum: null, data_version: "1", onboarding: { step: 6 } },
      { ...common, id: me, type: "PERSONAL", name: "Я (демо)", timezone: "Europe/Moscow", min_balance: r(0), tax_status: "ENTERED", tax_horizon_until: d(120), tax_note: "", stress_delay_days: 14, reconcile_stale_days: 7, monthly_minimum: r(120_000), data_version: "1" },
    ],
    accounts: [
      { ...common, id: accBiz, space_id: biz, name: "Расчётный счёт", type: "BANK", opening_balance: r(620_000), opening_date: d(-30), reconciled_at: d(-2), archived: false },
      { ...common, id: accBiz2, space_id: biz, name: "Резервный счёт", type: "SAVINGS", opening_balance: r(180_000), opening_date: d(-30), reconciled_at: d(-2), archived: false },
      { ...common, id: accMe, space_id: me, name: "Карта", type: "CARD", opening_balance: r(140_000), opening_date: d(-30), reconciled_at: d(-1), archived: false },
      { ...common, id: accSave, space_id: me, name: "Накопительный", type: "SAVINGS", opening_balance: r(300_000), opening_date: d(-30), reconciled_at: d(-1), archived: false },
    ],
    counterparties: [
      { ...common, id: self, space_id: biz, name: "Кирилл (я)", types: ["PARTNER"], is_self: true, sort_order: 0 },
      { ...common, id: nikita, space_id: biz, name: "Никита", types: ["PARTNER"], is_self: false, sort_order: 1 },
      { ...common, id: sergey, space_id: biz, name: "Сергей", types: ["PARTNER"], is_self: false, sort_order: 2 },
      { ...common, id: client, space_id: biz, name: "Клиент «Пример»", types: ["CLIENT"], is_self: false, sort_order: 10 },
      { ...common, id: editor, space_id: biz, name: "Монтажёр", types: ["CONTRACTOR"], is_self: false, sort_order: 11 },
    ],
    directions: [
      { ...common, id: dirFilm, space_id: biz, name: "Кино и сериалы", kind: "FILM" },
      { ...common, id: dirVert, space_id: biz, name: "Вертикальные сериалы", kind: "VERTICAL" },
      { ...common, id: dirAi, space_id: biz, name: "ИИ-продакшн", kind: "AI" },
    ],
    projects: [
      { ...common, id: pVert, space_id: biz, name: "Вертикальный сериал для клиента", direction_id: dirVert, model: "SERVICE", stage: "SHOOTING", client_id: client, start_date: d(-40), end_date: d(45), in_forecast: true, metrics: { episodes: 20, plannedShifts: 6, actualShifts: 4 }, notes: "" },
      { ...common, id: pFilm, space_id: biz, name: "Собственный фильм", direction_id: dirFilm, model: "OWN_IP", stage: "DEVELOPMENT", client_id: null, start_date: d(-10), end_date: d(200), in_forecast: true, metrics: {}, notes: "" },
      { ...common, id: pAi, space_id: biz, name: "ИИ-ролики, эксперимент", direction_id: dirAi, model: "EXPERIMENT", stage: "PREPRODUCTION", client_id: null, start_date: d(-5), end_date: d(60), in_forecast: true, metrics: { acceptedMinutes: 6, aiKind: "EXPERIMENT" }, notes: "" },
    ],
    revenue_agreements: [{ ...common, id: id("ra"), space_id: biz, project_id: pVert, client_id: client, amount: r(1_500_000), mgmt_amount: r(1_500_000), status: "SIGNED", reference: "Договор (демо)", is_extra_work: false }],
    funding_sources: [{ ...common, id: fsFilm, space_id: biz, project_id: pFilm, kind: "INVESTOR", name: "Инвестор (демо)", declared: r(3_000_000), confirmed: r(1_000_000), status: "CONFIRMED", terms: "Возврат из первых продаж", is_reallocation: false }],
    budget_lines: [
      { ...common, id: lineEdit, space_id: biz, project_id: pVert, category: "Монтаж", stage: "POSTPRODUCTION", original_amount: r(100_000), original_mgmt: r(100_000), note: "" },
      { ...common, id: lineShoot, space_id: biz, project_id: pVert, category: "Съёмочная команда", stage: "SHOOTING", original_amount: r(600_000), original_mgmt: r(600_000), note: "" },
      { ...common, id: lineFilm, space_id: biz, project_id: pFilm, category: "Разработка сценария", stage: "PREPRODUCTION", original_amount: r(1_800_000), original_mgmt: r(1_800_000), note: "" },
      { ...common, id: lineGpu, space_id: biz, project_id: pAi, category: "Генерации и сервисы", stage: "SERVICES", original_amount: r(90_000), original_mgmt: r(90_000), note: "" },
    ],
    plans: [
      plan({ id: pIn2, space_id: biz, direction: "IN", amount: r(450_000), due_date: d(5), counterparty_id: client, effect: "SALES", title: "Второй платёж по сериалу", project_id: pVert }),
      plan({ id: pIn3, space_id: biz, direction: "IN", amount: r(600_000), due_date: d(40), counterparty_id: client, effect: "SALES", title: "Финальный платёж по сериалу", project_id: pVert }),
      plan({ id: pLate, space_id: biz, direction: "IN", amount: r(120_000), due_date: d(-6), counterparty_id: client, effect: "SALES", title: "Допработы: правки", project_id: pVert }),
      plan({ id: pEdit1, space_id: biz, direction: "OUT", amount: r(45_000), due_date: d(1), counterparty_id: editor, effect: "PROJECT_COST", title: "Монтаж — аванс", project_id: pVert, budget_line_id: lineEdit }),
      plan({ id: pEdit2, space_id: biz, direction: "OUT", amount: r(45_000), due_date: d(27), counterparty_id: editor, effect: "PROJECT_COST", title: "Монтаж — после сдачи", project_id: pVert, budget_line_id: lineEdit }),
      plan({ id: pTeam, space_id: biz, direction: "OUT", amount: r(480_000), due_date: d(9), effect: "PROJECT_COST", title: "Съёмочная команда — смены 5–6", project_id: pVert, budget_line_id: lineShoot }),
      plan({ id: pTax, space_id: biz, direction: "OUT", amount: r(95_000), due_date: d(33), effect: "TAX", title: "УСН за квартал (внесено бухгалтером)" }),
      plan({ id: pFilmIn, space_id: biz, direction: "IN", amount: r(1_000_000), due_date: d(25), effect: "FINANCING", title: "Транш инвестора", project_id: pFilm, funding_source_id: fsFilm }),
      plan({ id: id("pl"), space_id: biz, direction: "OUT", amount: r(900_000), due_date: d(60), certainty: "ESTIMATE", effect: "PROJECT_COST", title: "Сценарий — оценка", project_id: pFilm, budget_line_id: lineFilm }),
      plan({ id: id("pl"), space_id: biz, direction: "OUT", amount: r(90_000), due_date: d(20), certainty: "ESTIMATE", effect: "PROJECT_COST", title: "Генерации — оценка", project_id: pAi, budget_line_id: lineGpu }),
      plan({ id: pReimb, space_id: biz, direction: "OUT", amount: r(30_000), due_date: d(12), counterparty_id: self, effect: "REIMBURSEMENT", title: "Возмещение: локация", partner_claim_id: claimReimb, linked_plan_id: pReimbMe }),
      plan({ id: pReimbMe, space_id: me, direction: "IN", amount: r(30_000), due_date: d(12), effect: "REIMBURSEMENT", title: "Возмещение от компании: локация", linked_plan_id: pReimb }),
      plan({ id: pRent, space_id: me, direction: "OUT", amount: r(85_000), due_date: d(4), effect: "PERSONAL_CONSUMPTION", title: "Аренда квартиры", category: "Жильё" }),
      plan({ id: id("pl"), space_id: biz, direction: "IN", amount: r(700_000), due_date: d(50), certainty: "ESTIMATE", counterparty_id: client, effect: "SALES", title: "Второй сезон — предварительно" }),
    ],
    recurrences: [
      { ...common, id: id("rr"), space_id: biz, freq: "MONTHLY", day: Number(d(15).slice(8, 10)), start_date: d(15), end_date: null, active: true, template: { direction: "OUT", amount: r(60_000), certainty: "CONTRACTED", effect: "OVERHEAD_COST", title: "Аренда студии", in_forecast: true } },
      { ...common, id: id("rr"), space_id: me, freq: "MONTHLY", day: Number(d(34).slice(8, 10)), start_date: d(34), end_date: null, active: true, template: { direction: "OUT", amount: r(85_000), certainty: "CONTRACTED", effect: "PERSONAL_CONSUMPTION", title: "Аренда квартиры", category: "Жильё", in_forecast: true } },
    ],
    transactions: [
      { ...common, id: tx1, space_id: biz, kind: "CLIENT_RECEIPT", description: "Аванс по сериалу (демо)", status: "POSTED", source: "MANUAL", occurred_on: d(-20), counterparty_id: client, project_id: pVert, category: null, effect: "SALES", correction_of: null, loan_id: null },
      { ...common, id: tx2, space_id: biz, kind: "EXPENSE", description: "Съёмочная команда, смены 1–4", status: "POSTED", source: "MANUAL", occurred_on: d(-8), counterparty_id: null, project_id: pVert, category: null, effect: "PROJECT_COST", correction_of: null, loan_id: null },
      { ...common, id: tx3, space_id: me, kind: "EXPENSE", description: "Продукты", status: "POSTED", source: "MANUAL", occurred_on: d(-3), counterparty_id: null, project_id: null, category: "Еда", effect: "PERSONAL_CONSUMPTION", correction_of: null, loan_id: null },
      { ...common, id: tx4, space_id: me, kind: "CROSS_SPACE", description: "За компанию: локация", status: "POSTED", source: "MANUAL", occurred_on: d(-4), counterparty_id: null, project_id: null, category: null, effect: "FINANCING", correction_of: null, loan_id: null },
    ],
    entries: [
      { id: id("en"), space_id: biz, transaction_id: tx1, account_id: accBiz, amount: r(450_000), effective_on: d(-20) },
      { id: id("en"), space_id: biz, transaction_id: tx2, account_id: accBiz, amount: r(-320_000), effective_on: d(-8) },
      { id: id("en"), space_id: me, transaction_id: tx3, account_id: accMe, amount: r(-12_400), effective_on: d(-3) },
      { id: id("en"), space_id: me, transaction_id: tx4, account_id: accMe, amount: r(-30_000), effective_on: d(-4) },
    ],
    settlements: [],
    cost_records: [
      { ...common, id: id("cr"), space_id: biz, budget_line_id: lineShoot, project_id: pVert, amount: r(320_000), mgmt_amount: r(320_000), paid_by_counterparty_id: null, transaction_id: tx2, plan_id: null, occurred_on: d(-8), status: "ACTIVE" },
      { ...common, id: id("cr"), space_id: biz, budget_line_id: null, project_id: pVert, amount: r(30_000), mgmt_amount: r(30_000), paid_by_counterparty_id: self, transaction_id: null, plan_id: null, occurred_on: d(-4), status: "ACTIVE" },
    ],
    reserves: [
      { ...common, id: resTax, space_id: biz, purpose: "УСН за квартал", kind: "PAYMENT_LINKED", plan_id: pTax, goal_id: null, closed: false },
      { ...common, id: resCushion, space_id: me, purpose: "Подушка", kind: "GOAL", plan_id: null, goal_id: goalCushion, closed: false },
    ],
    reserve_events: [
      { id: id("re"), space_id: biz, reserve_id: resTax, kind: "ALLOCATE", amount: r(95_000), date: d(-10) },
      { id: id("re"), space_id: me, reserve_id: resCushion, kind: "ALLOCATE", amount: r(300_000), date: d(-30) },
    ],
    reserve_schedules: [],
    goals: [{ ...common, id: goalCushion, space_id: me, name: "Подушка на 3 месяца", target: r(360_000), due_date: d(120), priority: 0, kind: "EMERGENCY" }],
    budgets: [
      { ...common, id: id("bu"), space_id: me, month: null, category: "Еда", limit_amount: r(40_000), kind: "VARIABLE", in_minimum: true },
      { ...common, id: id("bu"), space_id: me, month: null, category: "Транспорт", limit_amount: r(8_000), kind: "VARIABLE", in_minimum: false },
      { ...common, id: id("bu"), space_id: me, month: null, category: "Жильё", limit_amount: r(85_000), kind: "FIXED", in_minimum: true },
      { ...common, id: id("bu"), space_id: me, month: monthKey(t), category: "Развлечения", limit_amount: r(15_000), kind: "VARIABLE", in_minimum: false },
    ],
    claims: [{ ...common, id: claimReimb, space_id: biz, counterparty_id: self, direction: "COMPANY_OWES", basis: "REIMBURSEMENT", amount: r(30_000), approved: true, note: "Локация на съёмочный день", cost_record_id: null, pool_id: null, cancelled: false }],
    loans: [],
    pools: [],
    overheads: [],
    import_conflicts: [],
    recommendation_states: [],
    reconciliations: [],
    forecast_history: [],
  };
}
