import { describe, expect, it } from "vitest";
import { detectIntent, parse, parseAmounts, parseDates } from "../../src/modules/assistant/parser";
import { csvCell, parseCsv, preview, autoMapping, TEMPLATE_CSV } from "../../src/modules/import-export/csv";
import { rub } from "../../src/shared/money";
import { B, id } from "../fixtures";

const TODAY = "2026-09-23";

describe("помощник: распознавание", () => {
  it("S01: «Пришло 450 тысяч, второй платёж за сериал для клиента»", () => {
    const b = new B(TODAY);
    const sp = b.space();
    b.s.projects.push({ id: "p1", spaceId: sp.id, name: "Сериал для клиента", directionId: null, model: "SERVICE", stage: "SHOOTING", clientId: null, startDate: null, endDate: null, inForecast: true, metrics: {}, notes: "" });
    b.s.projects.push({ id: "p2", spaceId: sp.id, name: "Свой фильм", directionId: null, model: "OWN_IP", stage: "DEVELOPMENT", clientId: null, startDate: null, endDate: null, inForecast: true, metrics: {}, notes: "" });
    const p = parse("Пришло 450 тысяч, второй платёж за сериал для клиента", b.s);
    expect(p.intent).toBe("draft_receipt");
    expect(p.amounts).toEqual([rub(450_000)]);
    expect(p.projectIds).toEqual(["p1"]);
  });
  it("S02: «Могу забрать себе 100 тысяч сегодня?»", () => {
    const p = parse("Могу забрать себе 100 тысяч сегодня?", new B(TODAY).s);
    expect(p.intent).toBe("simulate_owner_payout");
    expect(p.amounts).toEqual([rub(100_000)]);
    expect(p.dates).toEqual([TODAY]);
    expect(p.missing).toContain("основание выплаты");
  });
  it("S03: «Монтаж — 90 тысяч, 45 сейчас и 45 после сдачи 20 октября»", () => {
    const text = "Монтаж — 90 тысяч, 45 сейчас и 45 после сдачи 20 октября";
    expect(detectIntent(text)).toBe("draft_payment_plan");
    expect(parseAmounts(text)).toEqual([rub(90_000), rub(45_000), rub(45_000)]);
    expect(parseDates(text, TODAY)).toEqual([TODAY, "2026-10-20"]);
  });
  it("S04: оплата за компанию личными", () => {
    expect(detectIntent("Оплатил локацию 30 000 личной картой за проект")).toBe("draft_reimbursement");
    expect(parseAmounts("Оплатил локацию 30 000 личной картой")).toEqual([rub(30_000)]);
  });
  it("S05: «Что будет, если вложить 200 тысяч в ИИ-продакшн?»", () => {
    expect(detectIntent("Что будет, если вложить 200 тысяч в ИИ-продакшн?")).toBe("simulate_investment");
  });
  it("прочие намерения", () => {
    expect(detectIntent("Сколько я могу потратить?")).toBe("get_summary");
    expect(detectIntent("Могу купить ноутбук за 150к?")).toBe("simulate_expense");
    expect(detectIntent("Что платить на этой неделе")).toBe("get_payments");
    expect(detectIntent("Почему доступно так мало")).toBe("explain_metric");
    expect(detectIntent("Клиент перенёс оплату на 15 ноября")).toBe("draft_reschedule");
    expect(detectIntent("Перевёл 50 000 с расчётного на накопительный")).toBe("draft_transfer");
    expect(detectIntent("Обзор недели")).toBe("weekly_review");
  });
  it("суммы: млн, к, копейки", () => {
    expect(parseAmounts("1,5 млн")).toEqual([rub(1_500_000)]);
    expect(parseAmounts("150к")).toEqual([rub(150_000)]);
    expect(parseAmounts("1 234,50 ₽")).toEqual([123_450n]);
    expect(parseAmounts("через 5 дней")).toEqual([]);
  });
  it("даты: через N дней, 20.10, в пятницу", () => {
    expect(parseDates("через 5 дней", TODAY)).toEqual(["2026-09-28"]);
    expect(parseDates("до 20.10", TODAY)).toEqual(["2026-10-20"]);
    expect(parseDates("в пятницу", TODAY)).toEqual(["2026-09-25"]);
  });
});

describe("CSV", () => {
  it("кавычки и разделитель ;", () => {
    expect(parseCsv('a;b\n"x;y";"он сказал ""да"""\n')).toEqual([["a", "b"], ["x;y", 'он сказал "да"']]);
  });
  it("экранирует формулы", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-100", true)).toBe("-100");
  });
  it("предпросмотр: шаблон, дубли в файле, точка открытия, похожие строки", () => {
    const b = new B("2026-10-05");
    const sp = b.space();
    const acc = b.account(sp, rub(100), { name: "Расчётный счёт", openingDate: "2026-10-01" });
    b.tx(sp, "EXPENSE", [[acc, -rub(700)]], { occurredOn: "2026-10-03" });
    const csv = TEMPLATE_CSV +
      "bank-0001,2026-10-01,Расчётный счёт,OUT,12000.00,EXPENSE,,,,повтор id\n" +
      ",2026-09-20,Расчётный счёт,OUT,100,EXPENSE,,,,до открытия\n" +
      ",2026-10-03,Расчётный счёт,OUT,700,EXPENSE,,,,похожая\n" +
      "x,2026-10-03,Расчётный счёт,OUT,10 USD,EXPENSE,,,,валюта\n";
    const rows = parseCsv(csv);
    const m = autoMapping(rows[0]);
    const pv = preview(rows.slice(1), m, b.s, sp.id);
    expect(pv.map((r) => r.status)).toEqual(["READY", "READY", "DUPLICATE", "BLOCKED", "SIMILAR", "ERROR"]);
    expect(pv[4].decision).toBe("REVIEW");
    void id;
  });
});
