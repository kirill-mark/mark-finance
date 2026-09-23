// Календарные даты — строки "ГГГГ-ММ-ДД" в часовом поясе пространства.
// Арифметика дат — в UTC, чтобы переходы на летнее время не сдвигали дни.

export type ISODate = string;

const pad = (n: number) => String(n).padStart(2, "0");

export function toISO(d: Date): ISODate {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function parseISO(s: ISODate): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export const isISODate = (s: unknown): s is ISODate =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(parseISO(s)) === s;

export function addDays(s: ISODate, n: number): ISODate {
  const d = parseISO(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / 86_400_000);
}

export const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** Сдвиг на k месяцев; 31-е в коротком месяце → последний день (F07). */
export function addMonthsClamped(s: ISODate, k: number, anchorDay?: number): ISODate {
  const [y, m, d] = s.split("-").map(Number);
  const total = y * 12 + (m - 1) + k;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const day = Math.min(anchorDay ?? d, daysInMonth(ny, nm));
  return `${ny}-${pad(nm + 1)}-${pad(day)}`;
}

export const monthKey = (s: ISODate) => s.slice(0, 7);
export const monthStart = (s: ISODate): ISODate => s.slice(0, 7) + "-01";
export function monthEnd(s: ISODate): ISODate {
  const [y, m] = s.split("-").map(Number);
  return `${y}-${pad(m)}-${pad(daysInMonth(y, m - 1))}`;
}

export const maxDate = (...d: ISODate[]) => d.reduce((a, b) => (b > a ? b : a));
export const minDate = (...d: ISODate[]) => d.reduce((a, b) => (b < a ? b : a));

/** Сегодняшняя дата в заданном часовом поясе (по умолчанию Europe/Moscow). */
export function todayIn(tz = "Europe/Moscow", now: Date = new Date()): ISODate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

export function formatDate(s: ISODate | null | undefined, today?: ISODate): string {
  if (!s) return "без даты";
  const d = parseISO(s);
  const base = `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}`;
  const sameYear = !today || today.slice(0, 4) === s.slice(0, 4);
  return sameYear ? base : `${base} ${d.getUTCFullYear()}`;
}

export function formatRelative(s: ISODate, today: ISODate): string {
  const k = diffDays(today, s);
  if (k === 0) return "сегодня";
  if (k === 1) return "завтра";
  if (k === -1) return "вчера";
  if (k > 1 && k <= 7) return `через ${k} ${plural(k, "день", "дня", "дней")}`;
  if (k < -1) return `${-k} ${plural(-k, "день", "дня", "дней")} назад`;
  return formatDate(s, today);
}

export const weekday = (s: ISODate) => WEEKDAYS[parseISO(s).getUTCDay()];
export const monthName = (m0: number) => MONTHS[m0];
export const monthGen = (m0: number) => MONTHS_GEN[m0];

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
