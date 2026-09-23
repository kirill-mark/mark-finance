// График прогноза: денежный остаток C(t) и свободный остаток C − R − B по дням на 13 недель.
// Отрицательные значения рисуются как есть — не заменяются нулём.
import { useEffect, useRef, useState } from "preact/hooks";
import { formatDate } from "../../shared/dates";
import { formatRub, formatShort } from "../../shared/money";
import type { ForecastResult } from "../../modules/forecasting/forecast";

const MSH = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const shortDate = (d: string) => `${Number(d.slice(8, 10))} ${MSH[Number(d.slice(5, 7)) - 1]}`;

function niceStep(raw: number) {
  if (!(raw > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

export function ForecastChart({ f }: { f: ForecastResult }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(300, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const daily = f.daily;
  const H = w < 520 ? 200 : 240;
  const pl = w < 520 ? 48 : 60, pr = 8, pt = 12, pb = 24;
  const cw = w - pl - pr, ch = H - pt - pb;
  // рубли как числа — только для координат рисунка, не для расчётов
  const C = daily.map((d) => Number(d.cMin / 100n));
  const F = daily.map((d) => Number(d.freeMin / 100n));
  let lo = Math.min(0, ...C, ...F), hi = Math.max(0, ...C, ...F);
  const step = niceStep((hi - lo || 1) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (hi === lo) hi = lo + step;
  const x = (i: number) => pl + (cw * i) / Math.max(1, daily.length - 1);
  const y = (v: number) => pt + ch - ((v - lo) / (hi - lo)) * ch;
  const path = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-6; v += step) ticks.push(v);
  const negIdx = F.map((v, i) => (v < 0 ? i : -1)).filter((i) => i >= 0);
  const hv = hover !== null ? daily[hover] : null;
  const minIdx = daily.findIndex((d) => d.date >= f.minFree.date);

  const onMove = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * w;
    const i = Math.round(((px - pl) / cw) * (daily.length - 1));
    setHover(i >= 0 && i < daily.length ? i : null);
  };

  return (
    <div class="chart" ref={ref}>
      <svg viewBox={`0 0 ${w} ${H}`} width={w} height={H} role="img" aria-label="Прогноз денежного и свободного остатка на 13 недель"
        onPointerMove={onMove as any} onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pl} x2={w - pr} y1={y(v)} y2={y(v)} class={v === 0 ? "zero" : "grid"} />
            <text x={pl - 6} y={y(v) + 4} text-anchor="end" class="ax">{formatShort(BigInt(Math.round(v)) * 100n)}</text>
          </g>
        ))}
        {daily.map((d, i) => (i % (w < 520 ? 28 : 14) === 0 ? <text key={d.date} x={x(i)} y={H - 6} text-anchor={i === 0 ? "start" : "middle"} class="ax">{shortDate(d.date)}</text> : null))}
        {negIdx.map((i) => <rect key={i} x={x(i) - cw / daily.length / 2} y={pt} width={Math.max(1, cw / daily.length)} height={ch} class="neg-band" />)}
        <path d={path(C)} class="l-cash" />
        <path d={path(F)} class="l-free" />
        {minIdx >= 0 && <circle cx={x(minIdx)} cy={y(F[minIdx])} r={4} class={F[minIdx] < 0 ? "pt-bad" : "pt"} />}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pt} y2={pt + ch} class="cursor" />}
      </svg>
      {hv && (
        <div class="tip" style={{ left: `${Math.min(Math.max(0, x(hover!) - 100), w - 210)}px` }}>
          <b>{formatDate(hv.date)}</b>
          <div><span>Деньги (минимум дня)</span><span>{formatRub(hv.cMin)}</span></div>
          <div><span>Свободно после защиты</span><span>{formatRub(hv.freeMin)}</span></div>
          <div><span>Событий</span><span>{hv.events}</span></div>
        </div>
      )}
      <div class="legend">
        <span><i class="sw sw-cash" />Деньги на счетах</span>
        <span><i class="sw sw-free" />Свободно после резервов и минимального остатка</span>
        {negIdx.length > 0 && <span><i class="sw sw-neg" />Дни с нехваткой</span>}
      </div>
    </div>
  );
}
