// Календарь платежей (5.2): по дням и по неделям; фильтры; сумма, остаток, исходный срок и ожидаемая дата.
import { useState } from "preact/hooks";
import { addDays, formatDate, parseISO, weekday, type ISODate } from "../../../shared/dates";
import { formatRub, type Minor } from "../../../shared/money";
import type { PaymentPlan, UUID } from "../../../shared/types";
import { baseScenario, buildEvents } from "../../../modules/forecasting/forecast";
import { indexSnapshot, isOverdue, planRemaining, planStatus } from "../../../modules/forecasting/ledger";
import * as act from "../../actions";
import { mutate, openSheet, useApp } from "../../store";
import { Badge, Btn, Card, D, Empty, Money, Seg, Select } from "../kit";
import { CERTAINTY, CERTAINTY_OUT } from "../labels";

interface Item {
  key: string;
  plan: PaymentPlan | null;
  ruleId: UUID | null;
  spaceId: UUID;
  date: ISODate | null;
  due: ISODate | null;
  direction: "IN" | "OUT";
  title: string;
  amount: Minor;
  remaining: Minor;
  status: string;
  overdue: boolean;
  certainty: string;
  projectId: UUID | null;
  counterpartyId: UUID | null;
}

export function Calendar({ params }: { params: URLSearchParams }) {
  const app = useApp();
  const s = app.s!;
  const ix = indexSnapshot(s);
  const [view, setView] = useState<"list" | "week">("list");
  const [dir, setDir] = useState<"" | "IN" | "OUT">("");
  const [status, setStatus] = useState<"open" | "overdue" | "paid" | "cancelled" | "all">(params.get("undated") ? "open" : "open");
  const [certainty, setCertainty] = useState("");
  const [project, setProject] = useState("");
  const [cp, setCp] = useState("");
  const [space, setSpace] = useState<string>(params.get("space") ?? "");
  const t = s.asOf;
  const spaceIds = s.spaces.filter((x) => (space ? x.id === space : app.mode === "BOTH" || x.type === app.mode)).map((x) => x.id);

  const items: Item[] = [];
  for (const p of s.plans) {
    if (!spaceIds.includes(p.spaceId)) continue;
    const st = planStatus(ix, p);
    items.push({
      key: p.id, plan: p, ruleId: p.recurrenceRuleId, spaceId: p.spaceId, date: p.expectedDate ?? p.dueDate, due: p.dueDate, direction: p.direction,
      title: p.title, amount: p.amount, remaining: planRemaining(ix, p), status: st, overdue: isOverdue(ix, p, t), certainty: p.certainty,
      projectId: p.projectId, counterpartyId: p.counterpartyId,
    });
  }
  // Будущие вхождения регулярных платежей — отдельные события с ключом правила и даты
  for (const sp of s.spaces.filter((x) => spaceIds.includes(x.id))) {
    const { events } = buildEvents(s, ix, sp, t, addDays(t, 120), { ...baseScenario(), includeEstimateIncome: true, includePipeline: true });
    for (const e of events) {
      if (e.kind !== "RECURRENCE") continue;
      const r = s.recurrences.find((x) => x.id === e.ruleId)!;
      items.push({
        key: e.key, plan: null, ruleId: e.ruleId, spaceId: sp.id, date: e.date, due: e.originalDate ?? e.date, direction: e.deltaC > 0n ? "IN" : "OUT",
        title: e.title, amount: e.deltaC < 0n ? -e.deltaC : e.deltaC, remaining: e.deltaC < 0n ? -e.deltaC : e.deltaC, status: "PLANNED",
        overdue: e.overdue, certainty: r.template.certainty, projectId: e.projectId, counterpartyId: e.counterpartyId,
      });
    }
  }
  const filtered = items.filter((i) =>
    (!dir || i.direction === dir) &&
    (!certainty || i.certainty === certainty) &&
    (!project || i.projectId === project) &&
    (!cp || i.counterpartyId === cp) &&
    (status === "all" ||
      (status === "open" && (i.status === "PLANNED" || i.status === "PARTIALLY_PAID")) ||
      (status === "overdue" && i.overdue) ||
      (status === "paid" && i.status === "PAID") ||
      (status === "cancelled" && i.status === "CANCELLED")),
  );
  const undated = filtered.filter((i) => !i.date);
  const dated = filtered.filter((i) => i.date).sort((a, b) => (a.overdue === b.overdue ? (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0) : a.overdue ? -1 : 1));
  const groups = new Map<string, Item[]>();
  for (const i of dated) {
    const k = i.overdue && status !== "paid" ? "overdue" : i.date!;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }

  const open = async (i: Item) => {
    if (i.plan) return openSheet("plan", { planId: i.plan.id });
    // вхождение регулярного платежа материализуется при первом действии
    const id = await mutate(() => act.materialize(i.ruleId!, i.due!));
    if (id) openSheet("plan", { planId: id });
  };

  return (
    <div class="screen">
      <div class="toolbar">
        <Seg value={view} onChange={setView} options={[["list", "По дням"], ["week", "По неделям"]]} />
        <Btn kind="primary" onClick={() => openSheet("plan-new", { spaceId: space || undefined })}>+ План</Btn>
      </div>
      <div class="filters">
        {app.mode === "BOTH" && <Select value={space} onChange={setSpace} options={s.spaces.map((x) => [x.id, x.type === "BUSINESS" ? "Продакшн" : "Я"] as [string, string])} empty="Все пространства" />}
        <Select value={dir} onChange={(v) => setDir(v as any)} options={[["IN", "Входящие"], ["OUT", "Исходящие"]]} empty="Входящие и исходящие" />
        <Select value={status} onChange={(v) => setStatus((v || "open") as any)} options={[["open", "Неоплаченные"], ["overdue", "Просроченные"], ["paid", "Оплаченные"], ["cancelled", "Отменённые"], ["all", "Все статусы"]]} />
        <Select value={certainty} onChange={setCertainty} options={[["CONTRACTED", "По договору / согласовано"], ["ESTIMATE", "Предварительно / оценка"], ["PIPELINE", "Возможные"]]} empty="Любая подтверждённость" />
        <Select value={project} onChange={setProject} options={s.projects.filter((p) => spaceIds.includes(p.spaceId)).map((p) => [p.id, p.name] as [string, string])} empty="Все проекты" />
        <Select value={cp} onChange={setCp} options={s.counterparties.filter((c) => spaceIds.includes(c.spaceId)).map((c) => [c.id, c.name] as [string, string])} empty="Все контрагенты" />
      </div>

      {undated.length > 0 && (
        <Card title="Без даты — прогноз неполный">
          <ul class="rows">{undated.map((i) => <Row key={i.key} i={i} onOpen={open} />)}</ul>
        </Card>
      )}

      {view === "list" ? (
        dated.length ? (
          [...groups.entries()].map(([k, list]) => (
            <Card key={k} title={k === "overdue" ? "Просрочено" : `${formatDate(k, t)}, ${weekday(k)}`} className={k === "overdue" ? "card-bad" : ""}
              actions={<DaySum list={list} />}>
              <ul class="rows">{list.map((i) => <Row key={i.key} i={i} onOpen={open} />)}</ul>
            </Card>
          ))
        ) : <Empty text="Платежей по этим фильтрам нет." action={<Btn onClick={() => openSheet("plan-new", {})}>+ План платежа</Btn>} />
      ) : (
        <Weeks items={dated} today={t} onOpen={open} />
      )}
    </div>
  );
}

function DaySum({ list }: { list: Item[] }) {
  const inn = list.filter((i) => i.direction === "IN").reduce((a, i) => a + i.remaining, 0n);
  const out = list.filter((i) => i.direction === "OUT").reduce((a, i) => a + i.remaining, 0n);
  return <span class="daysum">{inn > 0n && <span class="pos">+{formatRub(inn)}</span>} {out > 0n && <span class="neg">−{formatRub(out)}</span>}</span>;
}

function Row({ i, onOpen }: { i: Item; onOpen: (i: Item) => void }) {
  const app = useApp();
  const pr = app.s!.projects.find((p) => p.id === i.projectId);
  const cp = app.s!.counterparties.find((c) => c.id === i.counterpartyId);
  return (
    <li class={`row click ${i.overdue ? "overdue" : ""}`} onClick={() => onOpen(i)}>
      <span class={`dir ${i.direction === "IN" ? "in" : "out"}`} aria-label={i.direction === "IN" ? "Входящий" : "Исходящий"}>{i.direction === "IN" ? "↓" : "↑"}</span>
      <span class="grow">
        {i.title}{i.ruleId && <span class="muted"> ↻</span>}
        <small>
          {[cp?.name, pr?.name].filter(Boolean).join(" · ")}
          {i.due && i.date && i.due !== i.date && <> · срок <D d={i.due} />, ожидается <D d={i.date} /></>}
          {i.overdue && i.date && <> · срок <D d={i.due} /></>}
        </small>
      </span>
      <span class="tags">
        {i.overdue && <Badge kind="bad">просрочено</Badge>}
        {i.status === "PARTIALLY_PAID" && <Badge kind="warn">частично</Badge>}
        {i.status === "PAID" && <Badge kind="ok">оплачено</Badge>}
        {i.status === "CANCELLED" && <Badge kind="muted">отменён</Badge>}
        {i.certainty !== "CONTRACTED" && <Badge kind="muted">{(i.direction === "IN" ? CERTAINTY : CERTAINTY_OUT)[i.certainty]}</Badge>}
      </span>
      <span class="amt">
        <Money v={i.direction === "IN" ? i.remaining : -i.remaining} sign />
        {i.remaining !== i.amount && i.status !== "CANCELLED" && <small>из {formatRub(i.amount)}</small>}
      </span>
    </li>
  );
}

function Weeks({ items, today, onOpen }: { items: Item[]; today: ISODate; onOpen: (i: Item) => void }) {
  const monday = addDays(today, -((parseISO(today).getUTCDay() + 6) % 7));
  const weeks = Array.from({ length: 13 }, (_, w) => addDays(monday, 7 * w));
  return (
    <>
      {weeks.map((ws) => {
        const we = addDays(ws, 6);
        const list = items.filter((i) => (i.overdue && ws === monday) || (!i.overdue && i.date! >= ws && i.date! <= we));
        if (!list.length) return null;
        return (
          <Card key={ws} title={`${formatDate(ws, today)} — ${formatDate(we, today)}`} actions={<DaySum list={list} />}>
            <div class="week">
              {Array.from({ length: 7 }, (_, d) => addDays(ws, d)).map((day) => {
                const dl = list.filter((i) => (i.overdue ? ws === monday && day === today : i.date === day));
                return (
                  <div key={day} class={`wday ${day === today ? "is-today" : ""}`}>
                    <span class="wd">{weekday(day)} {parseISO(day).getUTCDate()}</span>
                    {dl.map((i) => (
                      <button type="button" key={i.key} class={`chip-ev ${i.direction === "IN" ? "in" : "out"} ${i.overdue ? "overdue" : ""}`} onClick={() => onOpen(i)} title={i.title}>
                        {i.direction === "IN" ? "+" : "−"}{formatRub(i.remaining).replace(/\s₽$/, "")} <span>{i.title}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </>
  );
}
