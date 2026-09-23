// Текстовый помощник без языковой модели: распознаёт намерение и поля по правилам.
// Арифметику не делает — только извлекает суммы, даты и сущности; расчёт выполняет расчётный модуль.
// Текст сообщения — данные, не инструкции: он лишь сопоставляется с разрешёнными намерениями.
import { addDays, addMonthsClamped, isISODate, parseISO, toISO, type ISODate } from "../../shared/dates";
import type { Minor } from "../../shared/money";
import type { Snapshot, UUID } from "../../shared/types";

export type Intent =
  | "get_summary" | "explain_metric" | "get_payments" | "get_project_health" | "weekly_review"
  | "simulate_expense" | "simulate_owner_payout" | "simulate_investment"
  | "draft_receipt" | "draft_expense" | "draft_payment_plan" | "draft_transfer"
  | "draft_reimbursement" | "draft_reserve_allocation" | "draft_reschedule" | "unknown";

export const INTENT_TEXT: Record<Intent, string> = {
  get_summary: "Сводка", explain_metric: "Объяснение расчёта", get_payments: "Платежи", get_project_health: "Состояние проекта",
  weekly_review: "Обзор недели", simulate_expense: "Проверка траты", simulate_owner_payout: "Выплата себе", simulate_investment: "Вложение",
  draft_receipt: "Поступление", draft_expense: "Расход", draft_payment_plan: "Договорённость о платежах", draft_transfer: "Перевод",
  draft_reimbursement: "Оплата за компанию личными", draft_reserve_allocation: "Резерв", draft_reschedule: "Перенос платежа", unknown: "Не понял",
};

export interface Parsed {
  intent: Intent;
  text: string;
  amounts: Minor[];
  dates: ISODate[];
  spaceHint: "PERSONAL" | "BUSINESS" | null;
  projectIds: UUID[];
  counterpartyIds: UUID[];
  accountIds: UUID[];
  planIds: UUID[];
  directionIds: UUID[];
  category: string | null;
  basis: "FEE" | "REIMBURSEMENT" | "LOAN" | "DISTRIBUTION" | null;
  metric: string | null;
  isQuestion: boolean;
  missing: string[];
}

const MONTHS: Record<string, number> = {
  январ: 0, феврал: 1, март: 2, апрел: 3, ма: 4, июн: 5, июл: 6, август: 7, сентябр: 8, октябр: 9, ноябр: 10, декабр: 11,
};
const WEEKDAYS: Record<string, number> = { понедельник: 1, вторник: 2, сред: 3, четверг: 4, пятниц: 5, суббот: 6, воскресень: 0 };

const MULT: [RegExp, bigint][] = [
  [/^(млн|миллион[а-я]*|лям[а-я]*)$/, 1_000_000n],
  [/^(тыс\.?|тысяч[а-я]*|тыщ[а-я]*|к|k|т\.?)$/, 1_000n],
  [/^(руб[а-я]*|р\.?|₽)$/, 1n],
];

/** Суммы в копейках в порядке упоминания. Без множителя наследуют множитель соседних чисел: «90 тысяч, 45 сейчас и 45». */
export function parseAmounts(text: string): Minor[] {
  const t = text.toLowerCase().replace(/(\d)[\s  ](?=\d{3}\b)/g, "$1");
  // \b в JS не работает с кириллицей — границу после «к» проверяем явно
  const re = /(\d+(?:[.,]\d+)?)\s*(млн|миллион[а-я]*|лям[а-я]*|тыс\.?|тысяч[а-я]*|тыщ[а-я]*|[kк](?![а-яёa-z])|т\.|руб[а-я]*|р\.|₽)?/g;
  const raw: { n: string; mult: bigint | null; idx: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 2);
    const before = t.slice(Math.max(0, m.index - 1), m.index);
    // пропускаем даты вида 20.10 и числа, за которыми следует название месяца
    if (/^\d{1,2}[.]\d{1,2}$/.test(m[1]) && !m[2]) continue;
    if (/^[.\/]/.test(after) && /^\d{1,2}$/.test(m[1])) continue;
    if (before === "." || before === "/") continue;
    const rest = t.slice(m.index + m[0].length).trimStart();
    if (!m[2] && Object.keys(MONTHS).some((k) => rest.startsWith(k))) continue;
    if (!m[2] && /^(дн|недел|месяц|числ|сер|смен|минут|%|процент|раз)/.test(rest)) continue;
    let mult: bigint | null = null;
    if (m[2]) for (const [r, v] of MULT) if (r.test(m[2].replace(/\s/g, ""))) mult = v;
    raw.push({ n: m[1], mult, idx: m.index });
  }
  const explicit = raw.filter((r) => r.mult && r.mult > 1n).map((r) => r.mult!);
  const inherit = explicit.length ? explicit[explicit.length - 1] : 1n;
  return raw
    .map((r) => {
      const [whole, frac = ""] = r.n.replace(",", ".").split(".");
      const mult = r.mult ?? (BigInt(whole) < 1000n && explicit.length ? inherit : 1n);
      if (mult === 1n) return BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2)); // рубли и копейки
      // «1,5 млн» = 15 × 1 000 000 × 100 / 10 — точно в целых копейках
      return (BigInt(whole + frac) * mult * 100n) / 10n ** BigInt(frac.length);
    })
    .filter((v) => v > 0n);
}

/** Даты: «сегодня», «завтра», «через 5 дней», «20 октября», «20.10», «в пятницу». */
export function parseDates(text: string, today: ISODate): ISODate[] {
  const t = text.toLowerCase();
  const found: { d: ISODate; i: number }[] = [];
  const push = (d: ISODate, i: number) => found.push({ d, i });
  let m: RegExpExecArray | null;
  const words: [RegExp, number][] = [[/послезавтра/g, 2], [/сегодня/g, 0], [/(?<!после)завтра/g, 1], [/вчера/g, -1], [/сейчас/g, 0]];
  for (const [re, k] of words) while ((m = re.exec(t))) push(addDays(today, k), m.index);
  const rel = /через\s+(\d+)?\s*(дн[а-яёa-z0-9_]*|день|недел[а-яёa-z0-9_]*|месяц[а-яёa-z0-9_]*)/g;
  while ((m = rel.exec(t))) {
    const n = Number(m[1] ?? 1);
    push(m[2].startsWith("недел") ? addDays(today, 7 * n) : m[2].startsWith("месяц") ? addMonthsClamped(today, n) : addDays(today, n), m.index);
  }
  const dm = /(\d{1,2})\s+(январ[а-яёa-z0-9_]*|феврал[а-яёa-z0-9_]*|март[а-яёa-z0-9_]*|апрел[а-яёa-z0-9_]*|ма[яй][а-яёa-z0-9_]*|июн[а-яёa-z0-9_]*|июл[а-яёa-z0-9_]*|август[а-яёa-z0-9_]*|сентябр[а-яёa-z0-9_]*|октябр[а-яёa-z0-9_]*|ноябр[а-яёa-z0-9_]*|декабр[а-яёa-z0-9_]*)(?:\s+(\d{4}))?/g;
  while ((m = dm.exec(t))) {
    const key = Object.keys(MONTHS).find((k) => m![2].startsWith(k))!;
    const y = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    let d = toISO(new Date(Date.UTC(y, MONTHS[key], Number(m[1]))));
    if (!m[3] && d < addDays(today, -60)) d = toISO(new Date(Date.UTC(y + 1, MONTHS[key], Number(m[1]))));
    if (isISODate(d)) push(d, m.index);
  }
  const num = /(?<![\d.])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d])/g;
  while ((m = num.exec(t))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(today.slice(0, 4));
    const d = `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (isISODate(d)) push(d, m.index);
  }
  const wd = /в\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)/g;
  while ((m = wd.exec(t))) {
    const key = Object.keys(WEEKDAYS).find((k) => m![1].startsWith(k))!;
    const cur = parseISO(today).getUTCDay();
    push(addDays(today, (WEEKDAYS[key] - cur + 7) % 7 || 7), m.index);
  }
  return found.sort((a, b) => a.i - b.i).map((x) => x.d);
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
const stems = (s: string) => norm(s).split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, Math.max(4, w.length - 2)));

/** Сопоставление по основам слов: проект «Сериал для клиента» находится по «за сериал для клиента». */
function matchEntities<T extends { id: string; name: string }>(text: string, items: T[]): T[] {
  const t = norm(text);
  const scored = items
    .map((it) => {
      const st = stems(it.name);
      if (!st.length) return { it, score: 0 };
      const hits = st.filter((s) => t.includes(s)).length;
      return { it, score: hits / st.length };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  const top = scored[0].score;
  return scored.filter((x) => x.score === top).map((x) => x.it);
}

export function detectIntent(text: string): Intent {
  const t = norm(text);
  const q = /\?|^(могу|можно|хватит|сколько|что будет|а если|если)/.test(t.trim());
  if (/(недел[а-яёa-z0-9_]*|еженедельн)\s*(обзор|сводк|итог)|обзор\s+недел|итоги\s+недел/.test(t)) return "weekly_review";
  if (/почему|из чего|как (посчитан|считал|считается|получил)|объясни/.test(t)) return "explain_metric";
  if (/(вложить|вложиться|инвестир|вложение)/.test(t)) return "simulate_investment";
  if (/(забрать|вывести|взять|выплатить|снять)\s*(себе|мне)|себе\s+\d|(дивиденд|выплат[а-яёa-z0-9_]* себе)/.test(t) && (q || /могу|можно/.test(t))) return "simulate_owner_payout";
  if (q && /\d/.test(t) && /(потратить|купить|заплатить|оплатить|позволить)/.test(t)) return "simulate_expense";
  if (/(перенес|перенос|сдвин|задерж|отлож[а-яёa-z0-9_]* оплат|перен[её]с)/.test(t) && /(оплат|платеж|срок|клиент|дат)/.test(t)) return "draft_reschedule";
  if (/(личн[а-яёa-z0-9_]*|сво[а-яёa-z0-9_]+ (карт|деньг))/.test(t) && /(компани|продакшн|проект|за фирм|локац|за съемк)/.test(t)) return "draft_reimbursement";
  if (/(перев[её]л|перекин|переброс)[а-яёa-z0-9_]*.*\s(с|со)\s.*\sна\s/.test(t)) return "draft_transfer";
  if (/(отлож|зарезерв|защити|в резерв|в подушк|на цел)/.test(t)) return "draft_reserve_allocation";
  if (/(договорил|договорились|согласовал|сошлись|сейчас и|после сдачи|частями|двумя платеж|аванс[а-яёa-z0-9_]* и)/.test(t)) return "draft_payment_plan";
  if (/(пришл|поступил|поступлени|получил|зачислил|оплатил[а-яёa-z0-9_]* клиент|клиент оплатил|перевел[а-яёa-z0-9_]* нам)/.test(t)) return "draft_receipt";
  if (/(заплатил|оплатил|потратил|купил|списал|отдал)/.test(t)) return "draft_expense";
  if (/(что|кому|когда).*(платить|заплатить|оплатить)|платеж[а-яёa-z0-9_]*|календар|ближайш|на этой недел/.test(t)) return "get_payments";
  if (/проект/.test(t) && /(как|что|состояни|маржа|смет|затрат|здоров)/.test(t)) return "get_project_health";
  if (/(сводк|обзор|как дела|сколько|доступн|свободн|что с деньгами|остат|денег|прогноз)/.test(t)) return "get_summary";
  return "unknown";
}

export function parse(text: string, s: Snapshot): Parsed {
  const intent = detectIntent(text);
  const t = norm(text);
  const amounts = parseAmounts(text);
  const dates = parseDates(text, s.asOf);
  let spaceHint: Parsed["spaceHint"] = null;
  if (/(личн|себе|мне|сво[а-яёa-z0-9_]+ деньг|дом|семь)/.test(t)) spaceHint = "PERSONAL";
  if (/(компани|продакшн|бизнес|проект|клиент|подрядчик|команд|сериал|фильм|ии-|ии )/.test(t)) spaceHint = "BUSINESS";
  if (intent === "simulate_owner_payout" || intent === "draft_reimbursement") spaceHint = "BUSINESS";
  const projects = matchEntities(text, s.projects.map((p) => ({ id: p.id, name: p.name })));
  const directions = matchEntities(text, s.directions.map((d) => ({ id: d.id, name: d.name })));
  const aiDir = /(ии|ai|нейро)/.test(t) ? s.directions.filter((d) => d.kind === "AI") : [];
  const cps = matchEntities(text, s.counterparties.map((c) => ({ id: c.id, name: c.name })));
  const accounts = matchEntities(text, s.accounts.filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name })));
  let basis: Parsed["basis"] = null;
  if (/возмещ|верн[а-яёa-z0-9_]* (расход|потрачен)|компенс/.test(t)) basis = "REIMBURSEMENT";
  else if (/гонорар|за работ|зарплат|оплат[а-яёa-z0-9_]* работ/.test(t)) basis = "FEE";
  else if (/займ|заем|долг|верн[а-яёa-z0-9_]* (займ|долг)/.test(t)) basis = "LOAN";
  else if (/прибыл|дивиденд|распредел/.test(t)) basis = "DISTRIBUTION";
  let metric: string | null = null;
  if (/доступн|свобод|могу потратить|лимит/.test(t)) metric = "available";
  else if (/остат|на счет/.test(t)) metric = "cash";
  else if (/маржа|маржин/.test(t)) metric = "margin";
  else if (/прогноз|нехватк|разрыв/.test(t)) metric = "forecast";
  const cats = [...new Set(s.budgets.map((b) => b.category))];
  const category = cats.find((c) => norm(text).includes(norm(c).slice(0, Math.max(4, c.length - 2)))) ?? null;
  // планы для переноса: по контрагенту/проекту/названию
  const openPlans = s.plans.filter((p) => !p.cancelledAt);
  const planIds = matchEntities(text, openPlans.map((p) => ({ id: p.id, name: p.title }))).map((p) => p.id);

  const missing: string[] = [];
  const needAmount: Intent[] = ["simulate_expense", "simulate_owner_payout", "simulate_investment", "draft_receipt", "draft_expense", "draft_payment_plan", "draft_transfer", "draft_reimbursement", "draft_reserve_allocation"];
  if (needAmount.includes(intent) && !amounts.length) missing.push("сумма");
  if (intent === "simulate_owner_payout" && !basis) missing.push("основание выплаты");
  if (intent === "draft_payment_plan" && !projects.length) missing.push("проект");
  if (intent === "draft_reschedule" && !dates.length) missing.push("новая дата");

  return {
    intent, text, amounts, dates, spaceHint,
    projectIds: (projects.length ? projects : []).map((p) => p.id),
    counterpartyIds: cps.map((c) => c.id),
    accountIds: accounts.map((a) => a.id),
    planIds,
    category,
    basis,
    metric,
    directionIds: (directions.length ? directions : aiDir).map((d) => d.id),
    isQuestion: /\?/.test(text),
    missing,
  };
}
