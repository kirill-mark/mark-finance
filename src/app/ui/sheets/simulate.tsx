// Симуляция решения (F09) и карточка вердикта в формате 9.2:
// вердикт → сумма и дата → до трёх причин → изменение прогноза → действие → раскрываемые детали.
import { useEffect, useState } from "preact/hooks";
import { formatDate, isISODate, type ISODate } from "../../../shared/dates";
import { formatRub } from "../../../shared/money";
import type { UUID } from "../../../shared/types";
import { simulate, VERDICT_TEXT, type Decision, type PayoutBasis, type SimulationResult } from "../../../modules/forecasting/simulate";
import { BASIS_TEXT } from "../../../modules/forecasting/partners";
import { get, openSheet } from "../../store";
import { Badge, Btn, D, Field, FormError, KV, Money, MoneyInput, Quality, Select, Seg, SheetFrame, money, today } from "../kit";
import { categoriesOf } from "./core";

export function VerdictCard({ r, onSave }: { r: SimulationResult; onSave?: () => void }) {
  const d = r.decision;
  const kind = r.verdict === "WITHIN_LIMIT" ? "ok" : r.verdict === "SHORTFALL" ? "bad" : "warn";
  const b = r.base, st = r.stress;
  return (
    <div class={`verdict v-${kind}`}>
      <div class="v-head">
        <Badge kind={kind}>{VERDICT_TEXT[r.verdict]}</Badge>
        <b>{formatRub(d.amount)} · {formatDate(d.date, today())}</b>
        <span class="muted">{d.title}</span>
      </div>
      {r.reasons.length > 0 && <ul class="v-reasons">{r.reasons.slice(0, 3).map((x) => <li key={x.code + (x.date ?? "")}>{x.message}</li>)}</ul>}
      <table class="tbl small">
        <thead><tr><th /><th>До</th><th>После</th></tr></thead>
        <tbody>
          <tr><td>Доступно (стресс)</td><td><Money v={st.before.limit} /></td><td><Money v={st.after.limit} /></td></tr>
          <tr><td>Доступно (базовый)</td><td><Money v={b.before.limit} /></td><td><Money v={b.after.limit} /></td></tr>
          <tr><td>Минимум свободного остатка</td><td><Money v={st.before.minFree.amount} /></td><td><Money v={st.after.minFree.amount} /></td></tr>
          <tr><td>Первая проблемная дата</td><td>{st.before.points.find((p) => p.free < 0n) ? <D d={st.before.points.find((p) => p.free < 0n)!.date} /> : "нет"}</td><td>{r.firstRiskDate ? <D d={r.firstRiskDate} /> : "нет"}</td></tr>
        </tbody>
      </table>
      <KV rows={[
        ["Максимум на эту дату (стресс / базовый)", <><Money v={r.maxOnDate} unknownText="не рассчитывается" /> / <Money v={r.maxOnDateBase} unknownText="—" /></>],
        ...(r.basisLimit !== null ? [["Лимит по основанию", <Money v={r.basisLimit} />] as [string, any]] : []),
        ...(r.alternativeSearched ? [["Более поздняя дата", r.alternativeDate ? <D d={r.alternativeDate} /> : "в горизонте подходящей даты нет"] as [string, any]] : []),
        ...(r.personal ? [["Личные деньги после", <><Money v={r.personal.after.limit} /> доступно</>] as [string, any]] : []),
      ]} />
      {r.missingData.length > 0 && <ul class="issues">{r.missingData.map((m) => <li key={m.code}><Badge kind={m.severity === "BLOCKING" ? "bad" : "warn"}>{m.severity === "BLOCKING" ? "Не хватает" : "Уточнить"}</Badge> {m.message}</li>)}</ul>}
      <details class="assump">
        <summary>Сценарий, горизонт, данные</summary>
        <p>{st.scenario.label}; горизонт до {formatDate(st.after.decisionEnd)}; <Quality status={st.after.quality.status} />; версия данных {r.dataVersion}.</p>
        <ul>{st.after.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
        <p>Это прогноз по введённым данным, а не гарантия. Симуляция не меняет рабочие данные.</p>
      </details>
      {onSave && <div class="actions-row"><Btn kind="primary" onClick={onSave}>Сохранить как утверждённый план</Btn></div>}
    </div>
  );
}

export function SimulateSheet(props: { kind?: Decision["kind"]; spaceId?: UUID; amount?: string; date?: ISODate; title?: string; basis?: PayoutBasis; category?: string }) {
  const app = get();
  const s = app.s!;
  const [kind, setKind] = useState<Decision["kind"]>(props.kind ?? "EXPENSE");
  const [spaceId, setSpaceId] = useState<UUID>(props.spaceId ?? (kind === "OWNER_PAYOUT" ? app.businessId! : app.mode === "PERSONAL" ? app.personalId! : app.businessId!));
  const [amount, setAmount] = useState(props.amount ?? "");
  const [date, setDate] = useState(props.date ?? today());
  const [title, setTitle] = useState(props.title ?? "");
  const [basis, setBasis] = useState<PayoutBasis>(props.basis ?? "NONE");
  const [category, setCategory] = useState(props.category ?? "");
  const [count, setCount] = useState("1");
  const [reserve, setReserve] = useState("");
  const [err, setErr] = useState("");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const space = s.spaces.find((x) => x.id === spaceId)!;
  const run = () => {
    setErr("");
    try {
      if (!isISODate(date)) throw new FormError("Укажи дату");
      const d: Decision = {
        spaceId: kind === "OWNER_PAYOUT" ? app.businessId! : spaceId, kind, amount: money(amount), date, title: title || { EXPENSE: "Трата", OWNER_PAYOUT: "Выплата себе", INVESTMENT: "Вложение", RESCHEDULE: "Перенос", INCOME: "Поступление" }[kind],
        basis: kind === "OWNER_PAYOUT" ? basis : undefined, category: category || null, reserveId: reserve || null,
        effect: space.type === "PERSONAL" && kind === "EXPENSE" ? "PERSONAL_CONSUMPTION" : undefined,
        installments: kind === "INVESTMENT" && Number(count) > 1 ? { count: Number(count), everyMonths: 1 } : null,
      };
      setResult(simulate(s, d));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { if (props.amount) run(); }, []);
  return (
    <SheetFrame title="Проверить решение" wide>
      <Seg value={kind} onChange={(k) => { setKind(k); setResult(null); if (k === "OWNER_PAYOUT") setSpaceId(app.businessId!); }} options={[["EXPENSE", "Трата"], ["INVESTMENT", "Вложение"], ["OWNER_PAYOUT", "Выплата себе"]]} />
      {kind !== "OWNER_PAYOUT" && app.businessId && app.personalId && <Seg value={spaceId} onChange={(v) => { setSpaceId(v); setResult(null); }} options={[[app.businessId, "Продакшн"], [app.personalId, "Я"]]} />}
      <div class="two">
        <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
        <Field label="Дата"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} /></Field>
      </div>
      <Field label="Что это"><input value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} placeholder={kind === "INVESTMENT" ? "Вложение в ИИ-продакшн" : "Ноутбук, отпуск, оборудование"} /></Field>
      {kind === "OWNER_PAYOUT" && (
        <Field label="Основание выплаты" hint="Без утверждённого основания покажу только финансовый эффект">
          <Select value={basis} onChange={(v) => setBasis((v || "NONE") as PayoutBasis)} options={[["NONE", "Не выбрано"], ["FEE", BASIS_TEXT.FEE], ["REIMBURSEMENT", BASIS_TEXT.REIMBURSEMENT], ["LOAN", "Возврат займа"], ["DISTRIBUTION", BASIS_TEXT.DISTRIBUTION]]} />
        </Field>
      )}
      {kind === "INVESTMENT" && <Field label="Платежей (ежемесячно)"><input type="number" min="1" max="24" value={count} onInput={(e) => setCount((e.target as HTMLInputElement).value)} /></Field>}
      {kind === "EXPENSE" && space.type === "PERSONAL" && categoriesOf(spaceId).length > 0 && (
        <Field label="Категория бюджета" hint="Покупка внутри лимита заменит часть оценки, а не добавится сверху"><Select value={category} onChange={setCategory} options={categoriesOf(spaceId)} empty="Сверх бюджета" /></Field>
      )}
      <Field label="Взять из резерва (только если осознанно)"><Select value={reserve} onChange={setReserve} options={s.reserves.filter((r) => r.spaceId === spaceId && !r.closed).map((r) => [r.id, r.purpose] as [string, string])} empty="Резервы не трогать" /></Field>
      {err && <p class="f-e">{err}</p>}
      <div class="actions-row"><Btn kind="primary" onClick={run}>Проверить</Btn></div>
      {result && <VerdictCard r={result} onSave={kind === "OWNER_PAYOUT" ? undefined : () => openSheet("plan-new", { spaceId: result.decision.spaceId, direction: "OUT" })} />}
      {result && kind === "OWNER_PAYOUT" && <p class="fine">Выплату себе оформляют по утверждённому основанию: «Ещё → Партнёры» — основание и график выплаты. Сумма без основания не называется причитающейся.</p>}
    </SheetFrame>
  );
}

