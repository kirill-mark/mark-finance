// Проекты: карточка, статьи сметы, договорённости с подрядчиками, договоры выручки, финансирование, общие расходы.
import { useState } from "preact/hooks";
import { addDays, isISODate } from "../../../shared/dates";
import { formatRub } from "../../../shared/money";
import type { Project, UUID } from "../../../shared/types";
import { indexSnapshot, planRemaining } from "../../../modules/forecasting/ledger";
import * as api from "../../api";
import * as act from "../../actions";
import { get, mutate, navigate } from "../../store";
import { Btn, Field, FormError, MoneyInput, Select, Seg, SheetFrame, money, today } from "../kit";
import { COST_STAGE, FUNDING, MODEL, STAGE } from "../labels";
import { cpsOf, formatAmountInput, linesOf, projectsOf } from "./core";

const inp = (set: (v: string) => void) => (e: Event) => set((e.target as HTMLInputElement).value);
const dateOk = (d: string) => { if (!isISODate(d)) throw new FormError("Укажи дату"); return d; };

export function ProjectSheet({ projectId }: { projectId?: UUID }) {
  const app = get();
  const s = app.s!;
  const biz = app.businessId!;
  const p = projectId ? s.projects.find((x) => x.id === projectId) : null;
  const [name, setName] = useState(p?.name ?? "");
  const [direction, setDirection] = useState(p?.directionId ?? "");
  const [model, setModel] = useState<Project["model"]>(p?.model ?? "SERVICE");
  const [stage, setStage] = useState<Project["stage"]>(p?.stage ?? "PREPRODUCTION");
  const [client, setClient] = useState(p?.clientId ?? "");
  const [start, setStart] = useState(p?.startDate ?? "");
  const [end, setEnd] = useState(p?.endDate ?? "");
  const [inForecast, setIn] = useState(p?.inForecast ?? true);
  const [m, setM] = useState<Record<string, string>>(Object.fromEntries(Object.entries(p?.metrics ?? {}).map(([k, v]) => [k, String(v ?? "")])));
  const [notes, setNotes] = useState(p?.notes ?? "");
  const [key] = useState(api.newKey);
  const dirKind = s.directions.find((d) => d.id === direction)?.kind;
  const num = (k: string) => (m[k] && Number(m[k].replace(",", ".")) >= 0 ? Number(m[k].replace(",", ".")) : undefined);
  return (
    <SheetFrame title={p ? "Проект" : "Новый проект"} onSubmit={() => {
      if (!name.trim()) throw new FormError("Назови проект");
      const metrics: Record<string, unknown> = { episodes: num("episodes"), plannedShifts: num("plannedShifts"), actualShifts: num("actualShifts"), revisionRounds: num("revisionRounds"), acceptedMinutes: num("acceptedMinutes"), acceptedVideos: num("acceptedVideos"), aiKind: m.aiKind || undefined };
      const row = { name: name.trim(), direction_id: direction || null, model, stage, client_id: client || null, start_date: start || null, end_date: end || null, in_forecast: stage === "IDEA" ? false : inForecast, metrics, notes };
      return mutate(async () => {
        if (p) await api.update("cfo_projects", p.id, act.versionOf("projects", p.id), row);
        else { await api.insert("cfo_projects", { id: key, space_id: biz, ...row }); navigate(`project/${key}`); }
      }, "Проект сохранён");
    }}>
      <Field label="Название"><input value={name} onInput={inp(setName)} /></Field>
      <div class="two">
        <Field label="Направление"><Select value={direction} onChange={setDirection} options={s.directions.filter((d) => d.spaceId === biz).map((d) => [d.id, d.name] as [string, string])} empty="—" /></Field>
        <Field label="Модель"><Select value={model} onChange={(v) => setModel((v || "SERVICE") as any)} options={[["SERVICE", "Заказной (для клиента)"], ["OWN_IP", "Собственный"], ["EXPERIMENT", "Эксперимент / обучение"]]} /></Field>
      </div>
      <div class="two">
        <Field label="Стадия"><Select value={stage} onChange={(v) => setStage((v || "DEVELOPMENT") as any)} options={Object.entries(STAGE) as any} /></Field>
        {model === "SERVICE" && <Field label="Клиент"><Select value={client} onChange={setClient} options={cpsOf(biz)} empty="—" /></Field>}
      </div>
      <div class="two">
        <Field label="Начало"><input type="date" value={start} onInput={inp(setStart)} /></Field>
        <Field label="Окончание" hint="Нужно для горизонта решений; без него прогноз предварительный"><input type="date" value={end} onInput={inp(setEnd)} /></Field>
      </div>
      <label class="check"><input type="checkbox" checked={inForecast && stage !== "IDEA"} disabled={stage === "IDEA"} onChange={(e) => setIn((e.target as HTMLInputElement).checked)} /> Утверждённый план — выплаты проекта участвуют в прогнозе</label>
      {dirKind === "VERTICAL" && (
        <div class="two">
          <Field label="Серий"><input inputMode="numeric" value={m.episodes ?? ""} onInput={(e) => setM({ ...m, episodes: (e.target as HTMLInputElement).value })} /></Field>
          <Field label="Смен план / факт"><div class="two tight"><input inputMode="numeric" value={m.plannedShifts ?? ""} onInput={(e) => setM({ ...m, plannedShifts: (e.target as HTMLInputElement).value })} placeholder="план" /><input inputMode="numeric" value={m.actualShifts ?? ""} onInput={(e) => setM({ ...m, actualShifts: (e.target as HTMLInputElement).value })} placeholder="факт" /></div></Field>
        </div>
      )}
      {dirKind === "VERTICAL" && <Field label="Включённых раундов правок"><input inputMode="numeric" value={m.revisionRounds ?? ""} onInput={(e) => setM({ ...m, revisionRounds: (e.target as HTMLInputElement).value })} /></Field>}
      {dirKind === "AI" && (
        <div class="two">
          <Field label="Принятые минуты"><input inputMode="decimal" value={m.acceptedMinutes ?? ""} onInput={(e) => setM({ ...m, acceptedMinutes: (e.target as HTMLInputElement).value })} /></Field>
          <Field label="Статус"><Select value={(m.aiKind ?? "") as any} onChange={(v) => setM({ ...m, aiKind: v })} options={[["COMMERCIAL", "Коммерческий заказ"], ["EXPERIMENT", "Эксперимент"], ["TRAINING", "Обучение"]]} empty="—" /></Field>
        </div>
      )}
      <Field label="Заметки"><input value={notes} onInput={inp(setNotes)} /></Field>
      {p && <p class="fine">Модель «{MODEL[model]}». Закрыть проект с неразобранными затратами можно только после их явной отмены или переноса.</p>}
    </SheetFrame>
  );
}

export function BudgetLineSheet({ projectId, lineId }: { projectId: UUID | null; lineId?: UUID }) {
  const app = get();
  const l = lineId ? app.s!.budgetLines.find((x) => x.id === lineId) : null;
  const [category, setCategory] = useState(l?.category ?? "");
  const [stage, setStage] = useState(l?.stage ?? "OTHER");
  const [amount, setAmount] = useState(l ? formatAmountInput(l.originalAmount) : "");
  const [mgmt, setMgmt] = useState(l && l.originalMgmt !== l.originalAmount ? formatAmountInput(l.originalMgmt) : "");
  const [estimate, setEstimate] = useState(!l);
  const [estDate, setEstDate] = useState("");
  const [key] = useState(api.newKey);
  const [key2] = useState(api.newKey);
  return (
    <SheetFrame title={l ? "Статья сметы" : projectId ? "Статья исходной сметы" : "Статья общих расходов"} onSubmit={() => {
      if (!category.trim()) throw new FormError("Назови статью");
      const amt = money(amount, { allowZero: true });
      const mg = mgmt.trim() ? money(mgmt, { allowZero: true }) : amt;
      const row = { category: category.trim(), stage, original_amount: amt.toString(), original_mgmt: mg.toString() };
      return mutate(async () => {
        if (l) return api.update("cfo_budget_lines", l.id, act.versionOf("budget_lines", l.id), row);
        await api.insert("cfo_budget_lines", { id: key, space_id: app.businessId, project_id: projectId, ...row });
        if (estimate && amt > 0n) {
          await act.createPlan({ spaceId: app.businessId!, direction: "OUT", amount: amt, mgmtAmount: mg, dueDate: estDate || null, certainty: "ESTIMATE", effect: projectId ? "PROJECT_COST" : "OVERHEAD_COST", title: `${category.trim()} — оценка`, projectId, budgetLineId: key }, key2);
        }
      }, "Статья сохранена");
    }}>
      <p class="fine">Исходная смета хранится отдельно и не перезаписывается текущим прогнозом. Прогноз затрат = оплачено + согласовано + оставшаяся оценка.</p>
      <Field label="Статья"><input value={category} onInput={inp(setCategory)} placeholder="Монтаж, аренда техники, актёры" /></Field>
      <Field label="Этап"><Select value={stage} onChange={(v) => setStage((v || "OTHER") as any)} options={Object.entries(COST_STAGE) as any} /></Field>
      <div class="two">
        <Field label="Исходная смета"><MoneyInput value={amount} onInput={setAmount} /></Field>
        <Field label="Управленческая сумма" hint="Если отличается: например, без возмещаемого НДС"><MoneyInput value={mgmt} onInput={setMgmt} /></Field>
      </div>
      {!l && (
        <>
          <label class="check"><input type="checkbox" checked={estimate} onChange={(e) => setEstimate((e.target as HTMLInputElement).checked)} /> Добавить оценку оставшихся затрат на эту сумму</label>
          {estimate && <Field label="Когда примерно платить" hint="Без даты прогноз будет помечен неполным"><input type="date" value={estDate} onInput={inp(setEstDate)} /></Field>}
        </>
      )}
    </SheetFrame>
  );
}

/** S03: «Монтаж — 90 тысяч, 45 сейчас и 45 после сдачи 20 октября». */
export function AgreeCostSheet(props: { projectId?: UUID; lineId?: UUID; total?: string; parts?: { amount: string; date: string }[]; title?: string; fromAssistant?: string }) {
  const app = get();
  const s = app.s!;
  const biz = app.businessId!;
  const ix = indexSnapshot(s);
  const [project, setProject] = useState(props.projectId ?? "");
  const [line, setLine] = useState(props.lineId ?? "");
  const [newLine, setNewLine] = useState(props.title ?? "");
  const [title, setTitle] = useState(props.title ?? "");
  const [cp, setCp] = useState("");
  const [total, setTotal] = useState(props.total ?? "");
  const [parts, setParts] = useState<{ amount: string; date: string }[]>(props.parts ?? [{ amount: "", date: today() }, { amount: "", date: addDays(today(), 30) }]);
  const [key] = useState(props.fromAssistant ?? api.newKey());
  const estimates = s.plans.filter((p) => p.projectId === project && p.budgetLineId === (line || "__") && p.certainty === "ESTIMATE" && !p.cancelledAt && planRemaining(ix, p) > 0n);
  const [replace, setReplace] = useState<string[]>([]);
  const matchLine = !line && newLine ? s.budgetLines.find((l) => l.projectId === project && l.category.toLowerCase() === newLine.trim().toLowerCase()) : null;
  return (
    <SheetFrame title="Договорённость о затрате" wide onSubmit={() => {
      if (!project) throw new FormError("Выбери проект");
      const tot = money(total);
      const ps = parts.filter((p) => p.amount.trim()).map((p) => ({ amount: money(p.amount).toString(), date: dateOk(p.date) }));
      if (!ps.length) throw new FormError("Добавь хотя бы один платёж");
      const sum = ps.reduce((a, p) => a + BigInt(p.amount), 0n);
      if (sum !== tot) throw new FormError(`Сумма платежей ${formatRub(sum)} не равна договорённости ${formatRub(tot)}`);
      const lineId = line || matchLine?.id || null;
      return mutate(() => api.rpc("cfo_agree_cost", {
        space_id: biz, project_id: project, budget_line_id: lineId, new_line: lineId ? undefined : { category: newLine.trim() || title || "Затрата", stage: "OTHER", original_amount: tot.toString() },
        title: title || newLine || "Договорённость", counterparty_id: cp || null, total: tot.toString(), parts: ps, replace_plan_ids: replace,
      }, key), "Сохранено: одна затрата и график платежей");
    }}>
      <p class="fine">Создаётся одна затрата и плановые платежи. Если это уточнение существующей статьи — выбери её и отметь оценку, которую заменяет договорённость: сумма перенесётся, а не прибавится. Платёж считается совершённым только после внесения факта.</p>
      <div class="two">
        <Field label="Проект"><Select value={project} onChange={(v) => { setProject(v); setLine(""); }} options={projectsOf(biz)} empty="—" /></Field>
        <Field label="Подрядчик"><Select value={cp} onChange={setCp} options={cpsOf(biz)} empty="—" /></Field>
      </div>
      <div class="two">
        <Field label="Статья сметы"><Select value={line} onChange={(v) => { setLine(v); setReplace([]); }} options={linesOf(project)} empty="Новая статья" /></Field>
        {!line && <Field label="Название новой статьи" hint={matchLine ? "Такая статья уже есть — обновлю её, а не создам вторую" : undefined}><input value={newLine} onInput={inp(setNewLine)} placeholder="Монтаж" /></Field>}
      </div>
      <Field label="Описание"><input value={title} onInput={inp(setTitle)} placeholder="Монтаж сезона" /></Field>
      <Field label="Сумма договорённости"><MoneyInput value={total} onInput={setTotal} /></Field>
      <h3>График платежей</h3>
      {parts.map((p, i) => (
        <div class="two" key={i}>
          <Field label={`Платёж ${i + 1}`}><MoneyInput value={p.amount} onInput={(v) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: v } : x)))} /></Field>
          <Field label="Дата"><input type="date" value={p.date} onInput={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, date: (e.target as HTMLInputElement).value } : x)))} /></Field>
        </div>
      ))}
      <Btn small onClick={() => setParts([...parts, { amount: "", date: addDays(today(), 60) }])}>+ Ещё платёж</Btn>
      {estimates.length > 0 && (
        <>
          <h3>Заменить оценку</h3>
          {estimates.map((e) => (
            <label class="check" key={e.id}><input type="checkbox" checked={replace.includes(e.id)} onChange={(ev) => setReplace((ev.target as HTMLInputElement).checked ? [...replace, e.id] : replace.filter((x) => x !== e.id))} /> {e.title} — {formatRub(planRemaining(ix, e))}</label>
          ))}
        </>
      )}
    </SheetFrame>
  );
}

export function RevenueSheet({ projectId }: { projectId: UUID }) {
  const app = get();
  const p = app.s!.projects.find((x) => x.id === projectId)!;
  const [amount, setAmount] = useState("");
  const [mgmt, setMgmt] = useState("");
  const [ref, setRef] = useState("");
  const [extra, setExtra] = useState(false);
  const [status, setStatus] = useState<"SIGNED" | "DRAFT">("SIGNED");
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title="Договор выручки" onSubmit={() => {
      const a = money(amount);
      const mg = mgmt.trim() ? money(mgmt) : a;
      return mutate(() => api.insert("cfo_revenue_agreements", { id: key, space_id: p.spaceId, project_id: p.id, client_id: p.clientId, amount: a.toString(), mgmt_amount: mg.toString(), reference: ref, is_extra_work: extra, status }), "Договор сохранён");
    }}>
      <p class="fine">Маржа считается от договорной выручки, а не от полученных авансов. График поступлений добавь планами «По договору».</p>
      <div class="two">
        <Field label="Сумма по договору"><MoneyInput value={amount} onInput={setAmount} /></Field>
        <Field label="Управленческая сумма" hint="Например, без возмещаемого НДС"><MoneyInput value={mgmt} onInput={setMgmt} /></Field>
      </div>
      <Field label="Номер / ссылка"><input value={ref} onInput={inp(setRef)} /></Field>
      <Seg value={status} onChange={setStatus} options={[["SIGNED", "Подписан"], ["DRAFT", "Черновик — не в марже"]]} />
      <label class="check"><input type="checkbox" checked={extra} onChange={(e) => setExtra((e.target as HTMLInputElement).checked)} /> Дополнительные согласованные работы</label>
    </SheetFrame>
  );
}

export function FundingSheet({ projectId }: { projectId: UUID }) {
  const p = get().s!.projects.find((x) => x.id === projectId)!;
  const [kind, setKind] = useState("INVESTOR");
  const [name, setName] = useState("");
  const [declared, setDeclared] = useState("");
  const [confirmed, setConfirmed] = useState("");
  const [realloc, setRealloc] = useState(false);
  const [terms, setTerms] = useState("");
  const [planDate, setPlanDate] = useState("");
  const [key] = useState(api.newKey);
  const [key2] = useState(api.newKey);
  return (
    <SheetFrame title="Источник финансирования" onSubmit={() => {
      const dec = money(declared, { allowZero: true });
      const conf = confirmed.trim() ? money(confirmed, { allowZero: true }) : 0n;
      if (conf > dec && dec > 0n) throw new FormError("Подтверждено больше заявленного");
      return mutate(async () => {
        await api.insert("cfo_funding_sources", { id: key, space_id: p.spaceId, project_id: p.id, kind, name, declared: dec.toString(), confirmed: conf.toString(), status: conf > 0n ? "CONFIRMED" : "DECLARED", terms, is_reallocation: realloc });
        if (!realloc && conf > 0n && planDate) {
          await act.createPlan({ spaceId: p.spaceId, direction: "IN", amount: conf, dueDate: dateOk(planDate), certainty: "CONTRACTED", effect: "FINANCING", title: `Финансирование: ${name || FUNDING[kind]}`, projectId: p.id, fundingSourceId: key }, key2);
        }
      }, "Источник сохранён");
    }}>
      <p class="fine">Полученные суммы — часть подтверждённого финансирования, а не прибавка к нему. Выделение уже имеющихся денег компании меняет назначение, но не создаёт поступления.</p>
      <Field label="Источник"><Select value={kind} onChange={(v) => setKind(v || "OTHER")} options={Object.entries(FUNDING) as any} /></Field>
      <Field label="Название"><input value={name} onInput={inp(setName)} placeholder="Фонд, инвестор, собственные" /></Field>
      <div class="two">
        <Field label="Заявлено"><MoneyInput value={declared} onInput={setDeclared} /></Field>
        <Field label="Подтверждено"><MoneyInput value={confirmed} onInput={setConfirmed} /></Field>
      </div>
      {kind === "OWN_FUNDS" && <label class="check"><input type="checkbox" checked={realloc} onChange={(e) => setRealloc((e.target as HTMLInputElement).checked)} /> Выделяю уже имеющиеся деньги компании (без нового поступления)</label>}
      {!realloc && <Field label="Ожидаемая дата поступления подтверждённой суммы" hint="Создаст план поступления «Финансирование»"><input type="date" value={planDate} onInput={inp(setPlanDate)} /></Field>}
      <Field label="Условия возврата инвестиций (текстом)"><input value={terms} onInput={inp(setTerms)} /></Field>
    </SheetFrame>
  );
}

export function OverheadSheet({ lineId }: { lineId: UUID }) {
  const app = get();
  const l = app.s!.budgetLines.find((x) => x.id === lineId)!;
  const [project, setProject] = useState("");
  const [mode, setMode] = useState<"AMOUNT" | "SHARE">("SHARE");
  const [val, setVal] = useState("");
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title={`Распределить «${l.category}»`} onSubmit={() => {
      if (!project) throw new FormError("Выбери проект");
      const row = mode === "AMOUNT" ? { amount: money(val).toString(), share_bp: null } : { amount: null, share_bp: Math.round(Number(val.replace(",", ".")) * 100) };
      if (mode === "SHARE" && !(row.share_bp! > 0 && row.share_bp! <= 10000)) throw new FormError("Доля от 0 до 100%");
      return mutate(() => api.insert("cfo_overhead_allocations", { id: key, space_id: l.spaceId, budget_line_id: l.id, project_id: project, ...row }), "Распределение сохранено");
    }}>
      <p class="fine">Аналитика: распределение не создаёт второго денежного расхода. Сумма распределений не может превысить статью ({formatRub(l.originalMgmt)}).</p>
      <Field label="Проект"><Select value={project} onChange={setProject} options={projectsOf(l.spaceId)} empty="—" /></Field>
      <Seg value={mode} onChange={setMode} options={[["SHARE", "Доля, %"], ["AMOUNT", "Сумма"]]} />
      <Field label={mode === "SHARE" ? "Доля, %" : "Сумма"}>{mode === "SHARE" ? <input inputMode="decimal" value={val} onInput={inp(setVal)} /> : <MoneyInput value={val} onInput={setVal} />}</Field>
    </SheetFrame>
  );
}
