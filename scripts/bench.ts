// Нагрузочная проверка расчётного модуля (раздел 12): 10 000 операций, 100 проектов, 2 000 плановых событий.
import { B, id } from "../tests/fixtures";
import { rub } from "../src/shared/money";
import { computeSummary } from "../src/modules/recommendations/summary";
import { simulate } from "../src/modules/forecasting/simulate";

const b = new B("2026-10-01");
const biz = b.space("BUSINESS", { minBalance: rub(100_000) });
b.space("PERSONAL");
const acc = b.account(biz, rub(50_000_000), { openingDate: "2025-10-01" });
for (let i = 0; i < 100; i++) b.s.projects.push({ id: id("pr"), spaceId: biz.id, name: `Проект ${i}`, directionId: null, model: "SERVICE", stage: "SHOOTING", clientId: null, startDate: null, endDate: b.d(200 + i), inForecast: true, metrics: {}, notes: "" });
for (let i = 0; i < 10_000; i++) b.tx(biz, "EXPENSE", [[acc, -rub(100 + (i % 50))]], { occurredOn: b.d(-(i % 360)), projectId: b.s.projects[i % 100].id, effect: "PROJECT_COST" });
for (let i = 0; i < 2_000; i++) b.plan(biz, i % 3 ? "OUT" : "IN", rub(10_000 + i), b.d(1 + (i % 300)), { projectId: b.s.projects[i % 100].id });
const t0 = performance.now();
const sum = computeSummary(b.s);
const t1 = performance.now();
simulate(b.s, { spaceId: biz.id, kind: "INVESTMENT", amount: rub(200_000), date: b.d(3), title: "тест" });
const t2 = performance.now();
console.log(`Сводка (2 пространства × 3 сценария + рекомендации): ${(t1 - t0).toFixed(0)} мс; симуляция с поиском даты: ${(t2 - t1).toFixed(0)} мс; событий в прогнозе: ${sum.spaces[0].stress.events.length}`);
