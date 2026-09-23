// Универсальный CSV (раздел 11): разбор, сопоставление, предпросмотр, проверки дублей; экспорт.
// В предпросмотре ничего не записывается в денежный журнал.
import { isISODate, type ISODate } from "../../shared/dates";
import { parseRub, type Minor } from "../../shared/money";
import type { Snapshot, UUID } from "../../shared/types";

export const TEMPLATE_COLUMNS = ["external_id", "date", "account", "direction", "amount_rub", "kind", "counterparty", "project", "category", "description"] as const;
export type Column = (typeof TEMPLATE_COLUMNS)[number];

export const TEMPLATE_CSV =
  TEMPLATE_COLUMNS.join(",") + "\n" +
  "bank-0001,2026-10-01,Расчётный счёт,OUT,12000.00,EXPENSE,Прокат света,Пример проекта,Оборудование,Аренда света (пример)\n" +
  "bank-0002,2026-10-02,Расчётный счёт,IN,150000,CLIENT_RECEIPT,Пример клиента,Пример проекта,,Аванс по договору (пример)\n";

/** RFC 4180: кавычки, переносы строк внутри кавычек; разделитель , или ; определяется по заголовку. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

export async function fingerprint(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.replace(/\r\n/g, "\n").trim()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Mapping = Partial<Record<Column, number>>;

/** Автосопоставление колонок по заголовкам (в т.ч. русским). */
export function autoMapping(header: string[]): Mapping {
  const aliases: Record<Column, RegExp> = {
    external_id: /^(external_id|id|номер|№|ид)/i,
    date: /^(date|дата)/i,
    account: /^(account|сч[её]т)/i,
    direction: /^(direction|направлен|тип движ|приход\/расход)/i,
    amount_rub: /^(amount|сумма)/i,
    kind: /^(kind|вид|тип операц)/i,
    counterparty: /^(counterparty|контрагент|получатель|плательщик)/i,
    project: /^(project|проект)/i,
    category: /^(category|категор|статья)/i,
    description: /^(description|описан|назначен|комментар)/i,
  };
  const m: Mapping = {};
  header.forEach((h, i) => {
    for (const c of TEMPLATE_COLUMNS) if (m[c] === undefined && aliases[c].test(h.trim())) m[c] = i;
  });
  return m;
}

export type RowStatus = "READY" | "DUPLICATE" | "SIMILAR" | "ERROR" | "BLOCKED";
export interface PreviewRow {
  rowNo: number;
  raw: Record<string, string>;
  status: RowStatus;
  message: string;
  externalId: string | null;
  date: ISODate | null;
  accountId: UUID | null;
  toAccountId: UUID | null;
  direction: "IN" | "OUT" | null;
  amount: Minor | null;
  kind: string | null;
  counterpartyId: UUID | null;
  projectId: UUID | null;
  category: string | null;
  description: string;
  /** Решение пользователя по строке: провести, пропустить, отложить на проверку. */
  decision: "IMPORT" | "SKIP" | "REVIEW";
}

const KINDS = new Set(["CLIENT_RECEIPT", "INCOME", "EXPENSE", "TRANSFER", "LOAN_IN", "LOAN_REPAYMENT", "INTEREST", "PARTNER_PAYOUT", "REIMBURSEMENT", "TAX"]);
const EFFECT_BY_KIND: Record<string, string> = {
  CLIENT_RECEIPT: "SALES", INCOME: "NONE", EXPENSE: "NONE", TRANSFER: "INTERNAL_TRANSFER", LOAN_IN: "FINANCING", LOAN_REPAYMENT: "FINANCING",
  INTEREST: "OVERHEAD_COST", PARTNER_PAYOUT: "NONE", REIMBURSEMENT: "REIMBURSEMENT", TAX: "TAX",
};
export const effectForKind = (k: string | null) => (k ? EFFECT_BY_KIND[k] ?? "NONE" : "NONE");

function parseDate(v: string): ISODate | null {
  const s = v.trim();
  if (isISODate(s)) return s;
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (m) {
    const d = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return isISODate(d) ? d : null;
  }
  return null;
}

const findByName = <T extends { name: string }>(list: T[], name: string) => {
  const n = name.trim().toLowerCase();
  return n ? list.find((x) => x.name.trim().toLowerCase() === n) ?? null : null;
};

/**
 * Предпросмотр: сопоставление сущностей и проверки.
 * Повтор external_id на том же счёте — дубль; похожая операция без external_id — требует решения (не удаляется молча).
 * Строка раньше точки открытия счёта блокируется (T30). Неподдерживаемая валюта — ошибка.
 */
export function preview(rows: string[][], mapping: Mapping, s: Snapshot, spaceId: UUID): PreviewRow[] {
  const accounts = s.accounts.filter((a) => a.spaceId === spaceId);
  const cps = s.counterparties.filter((c) => c.spaceId === spaceId);
  const projects = s.projects.filter((p) => p.spaceId === spaceId);
  const txExternal = new Set<string>();
  const existing: { accountId: UUID; date: ISODate; amount: Minor }[] = [];
  for (const t of s.transactions) {
    if (t.spaceId !== spaceId || t.status === "REVERSED") continue;
    for (const e of s.entries.filter((x) => x.transactionId === t.id)) existing.push({ accountId: e.accountId, date: t.occurredOn, amount: e.amount });
  }
  // external_id известны только серверу — их полный список в снимок не входит; сервер отсечёт повторы.
  const seenInFile = new Set<string>();
  const get = (r: string[], c: Column) => (mapping[c] !== undefined ? (r[mapping[c]!] ?? "").trim() : "");
  const out: PreviewRow[] = [];
  rows.forEach((r, i) => {
    const raw: Record<string, string> = {};
    for (const c of TEMPLATE_COLUMNS) raw[c] = get(r, c);
    const row: PreviewRow = {
      rowNo: i + 2, raw, status: "READY", message: "", externalId: raw.external_id || null, date: null, accountId: null, toAccountId: null,
      direction: null, amount: null, kind: null, counterpartyId: null, projectId: null, category: raw.category || null, description: raw.description, decision: "IMPORT",
    };
    const errs: string[] = [];
    row.date = parseDate(raw.date);
    if (!row.date) errs.push("дата");
    const acc = findByName(accounts, raw.account);
    if (!acc) errs.push(`счёт «${raw.account}» не найден`);
    else row.accountId = acc.id;
    const dir = raw.direction.toUpperCase();
    if (["IN", "ПРИХОД", "+"].includes(dir)) row.direction = "IN";
    else if (["OUT", "РАСХОД", "-"].includes(dir)) row.direction = "OUT";
    else errs.push("направление IN/OUT");
    if (/[a-z]{3}|\$|€/i.test(raw.amount_rub.replace(/руб|₽/gi, ""))) errs.push("поддерживается только RUB");
    const amt = parseRub(raw.amount_rub);
    if (amt === null || amt === 0n) errs.push("сумма");
    else row.amount = amt < 0n ? -amt : amt;
    const kind = (raw.kind || (row.direction === "IN" ? "INCOME" : "EXPENSE")).toUpperCase();
    if (!KINDS.has(kind)) errs.push(`вид операции ${kind}`);
    else row.kind = kind;
    row.counterpartyId = findByName(cps, raw.counterparty)?.id ?? null;
    row.projectId = findByName(projects, raw.project)?.id ?? null;
    if (raw.project && !row.projectId) row.message = `проект «${raw.project}» не сопоставлен`;
    if (errs.length) {
      row.status = "ERROR";
      row.message = "Проверь: " + errs.join(", ");
      row.decision = "SKIP";
    } else if (acc && row.date! < acc.openingDate) {
      row.status = "BLOCKED";
      row.message = `Раньше точки открытия счёта (${acc.openingDate}) — сначала пересчитай точку открытия, иначе остаток удвоится`;
      row.decision = "SKIP";
    } else if (row.externalId && (txExternal.has(`${row.accountId}:${row.externalId}`) || seenInFile.has(`${row.accountId}:${row.externalId}`))) {
      row.status = "DUPLICATE";
      row.message = "Повтор external_id";
      row.decision = "SKIP";
    } else {
      const signed = row.direction === "OUT" ? -row.amount! : row.amount!;
      if (!row.externalId && existing.some((x) => x.accountId === row.accountId && x.date === row.date && x.amount === signed)) {
        row.status = "SIMILAR";
        row.message = "Похожая операция уже есть в журнале — реши, проводить ли";
        row.decision = "REVIEW";
      }
    }
    if (row.externalId) seenInFile.add(`${row.accountId}:${row.externalId}`);
    out.push(row);
  });
  pairTransfers(out);
  return out;
}

/** Пары переводов: списание и зачисление на ту же сумму в ту же дату между счетами — одна атомарная операция. */
function pairTransfers(rows: PreviewRow[]) {
  const outs = rows.filter((r) => r.kind === "TRANSFER" && r.direction === "OUT" && r.status === "READY");
  for (const o of outs) {
    const pair = rows.find((r) => r !== o && r.kind === "TRANSFER" && r.direction === "IN" && r.status === "READY" && r.date === o.date && r.amount === o.amount && r.accountId !== o.accountId && r.decision !== "SKIP");
    if (pair) {
      o.toAccountId = pair.accountId;
      pair.decision = "SKIP";
      pair.message = `Вторая сторона перевода из строки ${o.rowNo}`;
    } else {
      o.status = "SIMILAR";
      o.decision = "REVIEW";
      o.message = "Непарный перевод — вторая сторона не найдена; не будет превращён в расход автоматически";
    }
  }
  for (const r of rows.filter((x) => x.kind === "TRANSFER" && x.direction === "IN" && x.status === "READY" && x.decision !== "SKIP")) {
    r.status = "SIMILAR";
    r.decision = "REVIEW";
    r.message = "Непарный перевод — не будет превращён в доход автоматически";
  }
}

/** Экранирование потенциальных формул в CSV (=, +, -, @ в начале текста). */
export function csvCell(v: unknown, numeric = false): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (!numeric && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][], numericCols: number[] = []): string {
  return "﻿" + [header.map((h) => csvCell(h)), ...rows.map((r) => r.map((v, i) => csvCell(v, numericCols.includes(i))))].map((r) => r.join(",")).join("\r\n");
}
