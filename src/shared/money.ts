// Деньги — только целые копейки (bigint). Никаких вычислений через float.
// Проценты и доли — целые базисные пункты (1% = 100 bp, 100% = 10 000 bp).

export type Minor = bigint;

export const ZERO: Minor = 0n;
export const BP_100 = 10_000n;

/** Разбор десятичной строки рублей ("1 234,56", "-50000", "1.5") в копейки. Без float. */
export function parseRub(input: string): Minor | null {
  const s = input.replace(/[\s  ]/g, "").replace(/₽|руб\.?|р\.?$/gi, "").replace(",", ".");
  const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const kop = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] === "-" ? -kop : kop;
}

/** Копейки из строки целых копеек (формат API). */
export function fromMinorString(s: string | number | bigint | null | undefined): Minor {
  if (s === null || s === undefined || s === "") return 0n;
  if (typeof s === "bigint") return s;
  if (typeof s === "number") {
    if (!Number.isSafeInteger(s)) throw new Error("Сумма должна быть целым числом копеек");
    return BigInt(s);
  }
  if (!/^-?\d+$/.test(s)) throw new Error(`Неверная сумма в копейках: ${s}`);
  return BigInt(s);
}

export const toMinorString = (v: Minor): string => v.toString();

export const rub = (r: number | bigint): Minor => BigInt(r) * 100n;

export const abs = (v: Minor): Minor => (v < 0n ? -v : v);
export const min = (...v: Minor[]): Minor => v.reduce((a, b) => (b < a ? b : a));
export const max = (...v: Minor[]): Minor => v.reduce((a, b) => (b > a ? b : a));
export const sum = (v: Iterable<Minor>): Minor => {
  let s = 0n;
  for (const x of v) s += x;
  return s;
};

/** a × num / den с округлением half-up (от нуля при .5). */
export function mulDivHalfUp(a: Minor, num: bigint, den: bigint): Minor {
  if (den === 0n) throw new Error("Деление на ноль");
  const neg = (a < 0n) !== (num < 0n) !== (den < 0n);
  const n = abs(a) * (num < 0n ? -num : num);
  const d = den < 0n ? -den : den;
  const q = n / d;
  const r = n % d;
  const res = r * 2n >= d ? q + 1n : q;
  return neg ? -res : res;
}

/** Процент от суммы в базисных пунктах, half-up. */
export const applyBp = (a: Minor, bp: bigint): Minor => mulDivHalfUp(a, bp, BP_100);

/** Отношение a/b в базисных пунктах (для маржинальности), half-up; null при b = 0. */
export function ratioBp(a: Minor, b: Minor): bigint | null {
  if (b === 0n) return null;
  return mulDivHalfUp(a, BP_100, b);
}

/**
 * Распределение пула по долям методом наибольших остатков (F11):
 * целые копейки вниз, остаток копеек — по убыванию дробного остатка,
 * при равенстве — в сохранённом порядке получателей.
 */
export function allocateLargestRemainder(pool: Minor, sharesBp: bigint[]): Minor[] {
  if (pool < 0n) throw new Error("Пул не может быть отрицательным");
  const total = sharesBp.reduce((a, b) => a + b, 0n);
  if (total !== BP_100) throw new Error("Сумма долей должна быть ровно 100%");
  if (sharesBp.some((s) => s < 0n)) throw new Error("Доля не может быть отрицательной");
  const base = sharesBp.map((s) => (pool * s) / BP_100);
  const rema = sharesBp.map((s, i) => ({ i, r: (pool * s) % BP_100 }));
  let left = pool - base.reduce((a, b) => a + b, 0n);
  rema.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of rema) {
    if (left <= 0n) break;
    base[i] += 1n;
    left -= 1n;
  }
  return base;
}

/**
 * Пропорциональное деление управленческой суммы при частичной оплате:
 * каждая часть half-up, последнему погашению — остаток, чтобы итог сошёлся до копейки.
 */
export function proportionalParts(total: Minor, weights: Minor[], isFinal: boolean[]): Minor[] {
  const wsum = sum(weights);
  let used = 0n;
  return weights.map((w, i) => {
    if (isFinal[i]) {
      const v = total - used;
      used += v;
      return v;
    }
    const v = wsum === 0n ? 0n : mulDivHalfUp(total, w, wsum);
    used += v;
    return v;
  });
}

const nf = new Intl.NumberFormat("ru-RU");

/** 123456789n → "1 234 567,89 ₽"; копейки показываем только если они есть. */
export function formatRub(v: Minor | null | undefined, opts: { sign?: boolean; kopecks?: boolean } = {}): string {
  if (v === null || v === undefined) return "нет данных";
  const neg = v < 0n;
  const a = abs(v);
  const r = a / 100n;
  const k = a % 100n;
  const whole = nf.format(Number(r)); // рубли до 9e15 точно представимы
  const kop = k !== 0n || opts.kopecks ? "," + k.toString().padStart(2, "0") : "";
  const sign = neg ? "−" : opts.sign && v > 0n ? "+" : "";
  return `${sign}${whole}${kop} ₽`;
}

/** Короткий формат для осей: "1,2 млн", "450 тыс". */
export function formatShort(v: Minor): string {
  const neg = v < 0n;
  const r = abs(v) / 100n;
  const s = neg ? "−" : "";
  if (r >= 1_000_000n) {
    const tenths = (r * 10n + 500_000n) / 1_000_000n;
    const t = tenths % 10n;
    return `${s}${tenths / 10n}${t ? "," + t : ""} млн`;
  }
  if (r >= 1000n) return `${s}${(r + 500n) / 1000n} тыс`;
  return `${s}${r}`;
}

export const formatBp = (bp: bigint | null): string => {
  if (bp === null) return "—";
  const neg = bp < 0n;
  const a = neg ? -bp : bp;
  const whole = a / 100n;
  const frac = a % 100n;
  return `${neg ? "−" : ""}${whole}${frac ? "," + frac.toString().padStart(2, "0").replace(/0$/, "") : ""}%`;
};
