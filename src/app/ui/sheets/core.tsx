// Основные панели: объяснение расчёта, план, оплата, перенос, отмена, новый план, операция, перевод, исправление, история.
import { useEffect, useState } from "preact/hooks";
import { addDays, formatDate, isISODate } from "../../../shared/dates";
import { formatRub, type Minor } from "../../../shared/money";
import type { EconomicEffect, PaymentPlan, TxKind, UUID } from "../../../shared/types";
import { indexSnapshot, planPaid, planRemaining, planStatus, accountBalance, isOverdue } from "../../../modules/forecasting/ledger";
import * as api from "../../api";
import * as act from "../../actions";
import { closeSheet, get, mutate, navigate, openSheet, useApp } from "../../store";
import { Badge, Btn, D, Field, FormError, KV, Money, MoneyInput, Quality, Select, Seg, SheetFrame, money, today } from "../kit";
import { CERTAINTY, CERTAINTY_OUT, EFFECT, FREQ, TX_KIND } from "../labels";

export const accountsOf = (spaceId: UUID) => get().s!.accounts.filter((a) => a.spaceId === spaceId && !a.archived).map((a) => [a.id, a.name] as [string, string]);
export const projectsOf = (spaceId: UUID) => get().s!.projects.filter((p) => p.spaceId === spaceId && p.stage !== "CANCELLED").map((p) => [p.id, p.name] as [string, string]);
export const cpsOf = (spaceId: UUID) => get().s!.counterparties.filter((c) => c.spaceId === spaceId).map((c) => [c.id, c.name] as [string, string]);
export const linesOf = (projectId: UUID | "") => get().s!.budgetLines.filter((l) => (projectId ? l.projectId === projectId : false)).map((l) => [l.id, l.category] as [string, string]);
export const categoriesOf = (spaceId: UUID) => [...new Set(get().s!.budgets.filter((b) => b.spaceId === spaceId).map((b) => b.category))].map((c) => [c, c] as [string, string]);
const spaceOf = (id: UUID) => get().s!.spaces.find((x) => x.id === id)!;
const dateOk = (d: string) => { if (!isISODate(d)) throw new FormError("Укажи дату"); return d; };

/* ---------- «Из чего сложилось» ---------- */
export function ExplainSheet({ spaceId, what }: { spaceId: UUID; what: "available" | "cash" | "reserved" }) {
  const app = useApp();
  const sp = app.summary!.spaces.find((x) => x.space.id === spaceId)!;
  const s = app.s!;
  const ix = indexSnapshot(s);
  const f = sp.stress;
  if (what === "cash") {
    return (
      <SheetFrame title="На счетах — из чего сложилось">
        <p class="fine">Остаток счёта = начальный остаток на точке открытия + проведённые движения после неё.</p>
        <table class="tbl">
          <thead><tr><th>Счёт</th><th>Открытие</th><th>Движения</th><th>Остаток</th><th>Сверка</th></tr></thead>
          <tbody>
            {s.accounts.filter((a) => a.spaceId === spaceId).map((a) => {
              const bal = accountBalance(ix, a);
              return (
                <tr key={a.id}>
                  <td>{a.name}{a.archived ? " (архив)" : ""}</td>
                  <td><Money v={a.openingBalance} /><small> на <D d={a.openingDate} /></small></td>
                  <td><Money v={bal - a.openingBalance} sign /></td>
                  <td><b><Money v={bal} /></b></td>
                  <td>{a.reconciledAt ? <D d={a.reconciledAt} /> : <Badge kind="bad">не сверен</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr><td colSpan={3}>Итого</td><td><b><Money v={sp.cash} /></b></td><td /></tr></tfoot>
        </table>
        <Btn kind="link" onClick={() => navigate(`accounts?space=${spaceId}`)}>Открыть счета и операции</Btn>
      </SheetFrame>
    );
  }
  if (what === "reserved") {
    return (
      <SheetFrame title="Защищённые деньги">
        <p class="fine">Резерв — назначение денег внутри пространства, а не расход. Одна копейка числится только в одном резерве.</p>
        <table class="tbl">
          <thead><tr><th>Назначение</th><th>Вид</th><th>Сумма</th></tr></thead>
          <tbody>
            {s.reserves.filter((r) => r.spaceId === spaceId).map((r) => (
              <tr key={r.id}><td>{r.purpose}</td><td>{r.kind === "PAYMENT_LINKED" ? "Под платёж" : "Цель"}</td><td><Money v={ix.reserveBalance.get(r.id) ?? 0n} /></td></tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={2}>Итого R</td><td><b><Money v={sp.reserved} /></b></td></tr></tfoot>
        </table>
        <KV rows={[["Минимальный остаток B", <Money v={sp.minBalance} unknownText="не задан" />], ["Незарезервировано сейчас", <Money v={sp.cash - sp.reserved} />]]} />
        <Btn kind="link" onClick={() => navigate(`reserves?space=${spaceId}`)}>Резервы и цели</Btn>
      </SheetFrame>
    );
  }
  const minPointIdx = f.points.findIndex((p) => p.eventKey === f.minFree.eventKey && p.date === f.minFree.date);
  const upto = f.events.slice(0, Math.max(0, minPointIdx));
  return (
    <SheetFrame title="Доступно для новых решений — расчёт" wide>
      <p class="fine">Свободный остаток в момент t = деньги C(t) − защищённые резервы R(t) − минимальный остаток B. Лимит новой выплаты сегодня = max(0, минимум свободного остатка по всему горизонту решения). Будущие поступления не разрешают тратить деньги, которых сейчас нет.</p>
      <KV rows={[
        ["Сценарий", f.scenario.label],
        ["Горизонт решения", <>сегодня — <D d={f.decisionEnd} /></>],
        ["Качество данных", <Quality status={f.quality.status} />],
        ["Деньги сейчас C", <Money v={f.startCash} />],
        ["Резервы сейчас R", <Money v={f.startReserved} />],
        ["Минимальный остаток B", f.minBalanceKnown ? <Money v={f.minBalance} /> : "не задан"],
        ["Свободно сейчас", <Money v={f.points[0].free} />],
        ["Минимум свободного остатка", <><Money v={f.minFree.amount} /> — <D d={f.minFree.date} /></>],
        ["Расчётный лимит", <b><Money v={f.limit} unknownText="не рассчитывается — недостаточно данных" /></b>],
        ["Базовый сценарий", <Money v={sp.base.limit} />],
      ]} />
      {f.quality.issues.length > 0 && <ul class="issues">{f.quality.issues.map((i) => <li key={i.code}><Badge kind={i.severity === "BLOCKING" ? "bad" : "warn"}>{i.severity === "BLOCKING" ? "Не хватает" : "Уточнить"}</Badge> {i.message}</li>)}</ul>}
      <h3>События до самой низкой точки</h3>
      {upto.length ? (
        <table class="tbl">
          <thead><tr><th>Дата</th><th>Событие</th><th>Сумма</th><th>Свободно после</th></tr></thead>
          <tbody>
            {upto.map((e, i) => (
              <tr key={e.key} class={e.planId ? "click" : ""} onClick={() => e.planId && openSheet("plan", { planId: e.planId })}>
                <td><D d={e.date} />{e.originalDate && <small> (было <D d={e.originalDate} />)</small>}</td>
                <td>{e.title}{e.overdue && <Badge kind="bad">просрочено</Badge>}{e.kind === "BUDGET" && <small> — распределённый бюджет</small>}</td>
                <td><Money v={e.deltaC} sign />{e.deltaR !== 0n && <small> резерв {formatRub(e.deltaR, { sign: true })}</small>}</td>
                <td><Money v={f.points[i + 1].free} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p class="fine">Минимум — сейчас: будущие события свободный остаток не уменьшают.</p>}
      {f.excludedOverdueIncoming.length > 0 && <p class="warn-line">Не включены просроченные поступления без новой даты: {f.excludedOverdueIncoming.map((o) => `${o.title} ${formatRub(o.amount)}`).join("; ")}</p>}
      <details class="assump" open><summary>Допущения</summary><ul>{f.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></details>
      <p class="fine">Версия данных {f.dataVersion} · расчёт на {formatDate(f.asOf)}</p>
    </SheetFrame>
  );
}

/* ---------- План платежа ---------- */
export function PlanSheet({ planId }: { planId: UUID }) {
  const app = useApp();
  const s = app.s!;
  const p = s.plans.find((x) => x.id === planId);
  const [hist, setHist] = useState<any[] | null>(null);
  useEffect(() => {
    if (!p || app.demo) return;
    api.audit(p.spaceId, p.id, 50).then(setHist).catch(() => setHist([]));
  }, [planId]);
  if (!p) return <SheetFrame title="План не найден"><p>Возможно, он был удалён или относится к недоступному пространству.</p></SheetFrame>;
  const ix = indexSnapshot(s);
  const st = planStatus(ix, p);
  const rem = planRemaining(ix, p);
  const project = s.projects.find((x) => x.id === p.projectId);
  const cp = s.counterparties.find((x) => x.id === p.counterpartyId);
  const claim = s.claims.find((x) => x.id === p.partnerClaimId);
  const linked = s.plans.find((x) => x.id === p.linkedPlanId);
  const facts = s.settlements.filter((x) => x.planId === p.id);
  return (
    <SheetFrame title={p.title || (p.direction === "IN" ? "Поступление" : "Выплата")}>
      <div class="chips">
        <Badge kind={p.direction === "IN" ? "ok" : "info"}>{p.direction === "IN" ? "Входящий" : "Исходящий"}</Badge>
        <Badge kind="muted">{p.direction === "IN" ? CERTAINTY[p.certainty] : CERTAINTY_OUT[p.certainty]}</Badge>
        <Badge kind={st === "PAID" ? "ok" : st === "CANCELLED" ? "muted" : st === "PARTIALLY_PAID" ? "warn" : "info"}>
          {{ PLANNED: "Запланирован", PARTIALLY_PAID: "Оплачен частично", PAID: "Оплачен", CANCELLED: "Отменён" }[st]}
        </Badge>
        {isOverdue(ix, p, s.asOf) && <Badge kind="bad">Просрочен</Badge>}
      </div>
      <KV rows={[
        ["Сумма плана", <Money v={p.amount} />],
        ["Оплачено", <Money v={planPaid(ix, p.id)} />],
        ["Неоплаченный остаток", <b><Money v={rem} /></b>],
        ["Исходный срок", <D d={p.dueDate} />],
        ["Ожидаемая дата", p.expectedDate ? <D d={p.expectedDate} /> : "= исходному сроку"],
        ["Экономический смысл", EFFECT[p.effect]],
        ...(cp ? [["Контрагент", cp.name] as [string, string]] : []),
        ...(project ? [["Проект", <a href={`#project/${project.id}`}>{project.name}</a>] as [string, any]] : []),
        ...(claim ? [["Основание выплаты", `${claim.note || claim.basis} · ${formatRub(claim.amount)}`] as [string, string]] : []),
        ...(linked ? [["Связанный план", `${linked.title} (${linked.spaceId === app.personalId ? "личное" : "продакшн"})`] as [string, string]] : []),
        ...(p.basis ? [["Основание", p.basis] as [string, string]] : []),
        ...(p.cancelledAt ? [["Отменён", `${formatDate(p.cancelledAt)} — ${p.cancelReason}`] as [string, string]] : []),
      ]} />
      {facts.length > 0 && (
        <>
          <h3>Факты оплаты</h3>
          <ul class="rows">
            {facts.map((f) => {
              const tx = s.transactions.find((t) => t.id === f.transactionId);
              return (
                <li key={f.id} class="row click" onClick={() => openSheet("tx", { txId: f.transactionId })}>
                  <span class="when"><D d={tx?.occurredOn} /></span>
                  <span class="grow">{tx?.description}{f.status === "VOID" && <Badge kind="muted">аннулировано исправлением</Badge>}</span>
                  <Money v={f.amount} />
                </li>
              );
            })}
          </ul>
        </>
      )}
      {!p.cancelledAt && rem > 0n && (
        <div class="actions-row">
          <Btn kind="primary" onClick={() => openSheet("pay", { planId: p.id })}>Отметить оплату</Btn>
          <Btn onClick={() => openSheet("reschedule", { planId: p.id })}>Изменить ожидаемую дату</Btn>
          <Btn kind="danger" onClick={() => openSheet("cancel-plan", { planId: p.id })}>Отменить план</Btn>
        </div>
      )}
      {!p.cancelledAt && <Btn small kind="link" onClick={() => openSheet("plan-edit", { planId: p.id })}>Изменить сумму, уверенность, связи</Btn>}
      {hist && hist.length > 0 && (
        <details class="assump"><summary>История изменений ({hist.length})</summary><History events={hist} /></details>
      )}
    </SheetFrame>
  );
}

export function History({ events }: { events: any[] }) {
  return (
    <ul class="hist">
      {events.map((e) => {
        const changed = e.before && e.after ? Object.keys(e.after).filter((k) => !["updated_at", "version"].includes(k) && JSON.stringify(e.before[k]) !== JSON.stringify(e.after[k])) : [];
        return (
          <li key={e.id}>
            <span class="when">{new Date(e.at).toLocaleString("ru-RU")}</span>
            <b>{{ INSERT: "Создано", UPDATE: "Изменено", DELETE: "Удалено" }[e.action as string] ?? e.action}</b>
            <span class="muted"> {e.entity.replace("cfo_", "")}</span>
            {changed.length > 0 && <small> — {changed.map((k) => `${k}: ${fmtVal(e.before[k])} → ${fmtVal(e.after[k])}`).join("; ")}</small>}
          </li>
        );
      })}
    </ul>
  );
}
const fmtVal = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? "…" : String(v));

/* ---------- Оплата плана (полностью или частично) ---------- */
export function PaySheet({ planId }: { planId: UUID }) {
  const s = get().s!;
  const p = s.plans.find((x) => x.id === planId)!;
  const rem = planRemaining(indexSnapshot(s), p);
  const [key] = useState(api.newKey);
  const [amount, setAmount] = useState(formatAmountInput(rem));
  const [account, setAccount] = useState(accountsOf(p.spaceId)[0]?.[0] ?? "");
  const [personal, setPersonal] = useState(get().personalId ? accountsOf(get().personalId!)[0]?.[0] ?? "" : "");
  const [date, setDate] = useState(today());
  const claim = p.partnerClaimId ? s.claims.find((c) => c.id === p.partnerClaimId) : null;
  const toSelf = !!claim && !!s.counterparties.find((c) => c.id === claim.counterpartyId && c.isSelf) && p.direction === "OUT";
  return (
    <SheetFrame title={p.direction === "IN" ? "Поступление по плану" : "Оплата по плану"} submitText="Провести" onSubmit={async () => {
      const amt = money(amount);
      if (amt > rem) throw new FormError(`Больше неоплаченного остатка (${formatRub(rem)}). Переплату оформи как отдельный план или аванс.`);
      if (!account) throw new FormError("Выбери счёт");
      await mutate(() => act.payPlan({ planId, accountId: account, amount: amt, date: dateOk(date), key, personalAccountId: toSelf ? personal || null : null }),
        amt === rem ? "Оплачено полностью" : "Оплата проведена частично");
    }}>
      <p class="fine">{p.title} · неоплаченный остаток <b>{formatRub(rem)}</b>. Платёж считается совершённым только после этой отметки.</p>
      <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
      <Field label={p.direction === "IN" ? "На какой счёт пришло" : "С какого счёта оплачено"}><Select value={account} onChange={setAccount} options={accountsOf(p.spaceId)} empty="—" /></Field>
      {toSelf && <Field label="Личный счёт, куда пришли деньги" hint="Поступление отразится в личных деньгах той же операцией"><Select value={personal} onChange={setPersonal} options={accountsOf(get().personalId!)} empty="не отражать в личных" /></Field>}
      <Field label="Дата"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} /></Field>
    </SheetFrame>
  );
}

export const formatAmountInput = (v: Minor) => {
  const r = v / 100n, k = v % 100n;
  return k ? `${r},${k.toString().padStart(2, "0")}` : r.toString();
};

export function RescheduleSheet({ planId }: { planId: UUID }) {
  const s = get().s!;
  const p = s.plans.find((x) => x.id === planId)!;
  const [date, setDate] = useState(p.expectedDate ?? p.dueDate ?? today());
  return (
    <SheetFrame title="Новая ожидаемая дата" onSubmit={() => mutate(() => act.reschedule(p, dateOk(date)), "Дата обновлена")}>
      <p class="fine">Исходный срок {p.dueDate ? formatDate(p.dueDate) : "не задан"} сохраняется — перенос не скрывает просрочку. {p.linkedPlanId ? "Связанный план в другом пространстве перенесётся согласованно." : ""} Договорные сроки и переписка с клиентом автоматически не меняются.</p>
      <Field label="Ожидаемая дата"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} /></Field>
    </SheetFrame>
  );
}

export function CancelPlanSheet({ planId }: { planId: UUID }) {
  const p = get().s!.plans.find((x) => x.id === planId)!;
  const [reason, setReason] = useState("");
  return (
    <SheetFrame title="Отменить план" danger submitText="Отменить план" onSubmit={() => {
      if (!reason.trim()) throw new FormError("Укажи причину отмены");
      return mutate(() => act.cancelPlan(p, reason.trim(), today()), "План отменён");
    }}>
      <p class="fine">«{p.title}» перестанет участвовать в прогнозе. Уже проведённые оплаты сохранятся.</p>
      <Field label="Причина"><input value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} placeholder="Например: клиент отказался от допработ" /></Field>
    </SheetFrame>
  );
}

/* ---------- Новый план / регулярный платёж ---------- */
const EFFECTS_BIZ_OUT: EconomicEffect[] = ["PROJECT_COST", "OVERHEAD_COST", "TAX", "FINANCING", "REIMBURSEMENT", "PROFIT_DISTRIBUTION", "NONE"];
const EFFECTS_BIZ_IN: EconomicEffect[] = ["SALES", "FINANCING", "REIMBURSEMENT", "NONE"];
const EFFECTS_ME_OUT: EconomicEffect[] = ["PERSONAL_CONSUMPTION", "TAX", "FINANCING", "NONE"];
const EFFECTS_ME_IN: EconomicEffect[] = ["PERSONAL_INCOME", "REIMBURSEMENT", "FINANCING", "NONE"];
export const effectsFor = (type: string, dir: "IN" | "OUT") =>
  (type === "BUSINESS" ? (dir === "IN" ? EFFECTS_BIZ_IN : EFFECTS_BIZ_OUT) : dir === "IN" ? EFFECTS_ME_IN : EFFECTS_ME_OUT).map((e) => [e, EFFECT[e]] as [EconomicEffect, string]);

export function PlanNewSheet(props: { spaceId?: UUID; projectId?: UUID; direction?: "IN" | "OUT"; budgetLineId?: UUID; certainty?: PaymentPlan["certainty"] }) {
  const app = get();
  const [spaceId, setSpaceId] = useState<UUID>(props.spaceId ?? app.businessId ?? app.personalId!);
  const sp = spaceOf(spaceId);
  const [dir, setDir] = useState<"IN" | "OUT">(props.direction ?? "OUT");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(addDays(today(), 7));
  const [noDate, setNoDate] = useState(false);
  const [time, setTime] = useState("");
  const [certainty, setCertainty] = useState<PaymentPlan["certainty"]>(props.certainty ?? "CONTRACTED");
  const [effect, setEffect] = useState<EconomicEffect>(sp.type === "BUSINESS" ? (dir === "IN" ? "SALES" : "PROJECT_COST") : dir === "IN" ? "PERSONAL_INCOME" : "PERSONAL_CONSUMPTION");
  const [cp, setCp] = useState("");
  const [project, setProject] = useState(props.projectId ?? "");
  const [line, setLine] = useState(props.budgetLineId ?? "");
  const [category, setCategory] = useState("");
  const [repeat, setRepeat] = useState<"" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY">("");
  const [until, setUntil] = useState("");
  const [basis, setBasis] = useState("");
  const [key] = useState(api.newKey);
  useEffect(() => { setEffect(effectsFor(sp.type, dir)[0][0]); }, [dir, spaceId]);
  return (
    <SheetFrame title={repeat ? "Регулярный платёж" : "План платежа"} onSubmit={async () => {
      if (!title.trim()) throw new FormError("Назови платёж");
      const amt = money(amount);
      if (noDate && !(dir === "OUT" && certainty === "ESTIMATE")) throw new FormError("Дата обязательна; без даты можно сохранить только оценку затрат — прогноз будет помечен неполным");
      const input: act.PlanInput = {
        spaceId, direction: dir, amount: amt, dueDate: noDate ? null : dateOk(date), expectedTime: time || null, certainty, effect, title: title.trim(),
        basis, counterpartyId: cp || null, projectId: project || null, budgetLineId: line || null, category: category || null,
      };
      if (repeat) {
        const d = dateOk(date);
        await mutate(() => act.createRecurrence(input, repeat, repeat === "WEEKLY" ? new Date(d).getUTCDay() : Number(d.slice(8, 10)), d, until || null, key), "Регулярный платёж создан");
      } else await mutate(() => act.createPlan(input, key), "План сохранён");
    }}>
      {app.mode === "BOTH" && !props.spaceId && <Field label="Пространство"><Seg value={spaceId} onChange={setSpaceId} options={[[app.businessId!, "Продакшн"], [app.personalId!, "Я"]]} /></Field>}
      <Seg value={dir} onChange={setDir} options={[["OUT", "Выплата"], ["IN", "Поступление"]]} label="Направление" />
      <Field label="Название"><input value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} placeholder={dir === "IN" ? "Второй платёж по договору" : "Монтаж, аренда, налог…"} /></Field>
      <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
      <div class="two">
        <Field label={dir === "IN" ? "Срок по договору" : "Срок оплаты"}>
          <input type="date" value={date} disabled={noDate} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Время (необязательно)" hint="Без времени выплаты считаются раньше поступлений"><input type="time" value={time} onInput={(e) => setTime((e.target as HTMLInputElement).value)} /></Field>
      </div>
      {dir === "OUT" && certainty === "ESTIMATE" && (
        <label class="check"><input type="checkbox" checked={noDate} onChange={(e) => setNoDate((e.target as HTMLInputElement).checked)} /> Дата ещё неизвестна (прогноз будет неполным)</label>
      )}
      <Field label="Подтверждённость">
        <Select value={certainty} onChange={(v) => setCertainty((v || "CONTRACTED") as any)} options={dir === "IN"
          ? [["CONTRACTED", "По договору — в базовом прогнозе"], ["ESTIMATE", "Предварительно — отдельный сценарий"], ["PIPELINE", "Возможная сделка — не в прогнозе"]]
          : [["CONTRACTED", "Согласовано"], ["ESTIMATE", "Оценка — входит в прогноз"], ["PIPELINE", "Черновая идея — не в прогнозе"]]} />
      </Field>
      <Field label="Экономический смысл"><Select value={effect} onChange={(v) => setEffect(v as EconomicEffect)} options={effectsFor(sp.type, dir)} /></Field>
      <div class="two">
        <Field label="Контрагент"><Select value={cp} onChange={setCp} options={cpsOf(spaceId)} empty="—" /></Field>
        {sp.type === "BUSINESS"
          ? <Field label="Проект"><Select value={project} onChange={(v) => { setProject(v); setLine(""); }} options={projectsOf(spaceId)} empty="Общие / без проекта" /></Field>
          : <Field label="Категория бюджета"><Select value={category} onChange={setCategory} options={categoriesOf(spaceId)} empty="—" /></Field>}
      </div>
      {project && dir === "OUT" && <Field label="Статья сметы"><Select value={line} onChange={setLine} options={linesOf(project)} empty="—" /></Field>}
      <Field label="Основание (договор, счёт)"><input value={basis} onInput={(e) => setBasis((e.target as HTMLInputElement).value)} placeholder="Договор №12 от 01.09, этап 2" /></Field>
      <div class="two">
        <Field label="Повторять"><Select value={repeat} onChange={(v) => setRepeat(v as any)} options={Object.entries(FREQ) as any} empty="Разовый платёж" /></Field>
        {repeat && <Field label="До (необязательно)"><input type="date" value={until} onInput={(e) => setUntil((e.target as HTMLInputElement).value)} /></Field>}
      </div>
      {repeat && <p class="fine">Каждое вхождение — отдельное событие прогноза. Изменение серии коснётся только непроведённых будущих платежей; 31-е в коротком месяце — последний день.</p>}
    </SheetFrame>
  );
}

export function PlanEditSheet({ planId }: { planId: UUID }) {
  const s = get().s!;
  const p = s.plans.find((x) => x.id === planId)!;
  const [title, setTitle] = useState(p.title);
  const [amount, setAmount] = useState(formatAmountInput(p.amount));
  const [certainty, setCertainty] = useState(p.certainty);
  const [due, setDue] = useState(p.dueDate ?? "");
  const [cp, setCp] = useState(p.counterpartyId ?? "");
  const [inForecast, setIn] = useState(p.inForecast);
  return (
    <SheetFrame title="Изменить план" onSubmit={() => {
      const amt = money(amount);
      return mutate(() => api.update("cfo_payment_plans", p.id, act.versionOf("plans", p.id), {
        title, amount: amt.toString(), certainty, due_date: due || null, counterparty_id: cp || null, in_forecast: inForecast,
      }), "План обновлён");
    }}>
      <p class="fine">Изменения сохраняются в истории. Сумма не может стать меньше уже оплаченного. Если оценку заменила договорённость — поменяй подтверждённость на «Согласовано» и сумму: затрата не удвоится.</p>
      <Field label="Название"><input value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} /></Field>
      <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
      <Field label="Исходный срок"><input type="date" value={due} onInput={(e) => setDue((e.target as HTMLInputElement).value)} /></Field>
      <Field label="Подтверждённость"><Select value={certainty} onChange={(v) => setCertainty((v || "CONTRACTED") as any)} options={Object.entries(p.direction === "IN" ? CERTAINTY : CERTAINTY_OUT) as any} /></Field>
      <Field label="Контрагент"><Select value={cp} onChange={setCp} options={cpsOf(p.spaceId)} empty="—" /></Field>
      <label class="check"><input type="checkbox" checked={inForecast} onChange={(e) => setIn((e.target as HTMLInputElement).checked)} /> Учитывать в прогнозе</label>
    </SheetFrame>
  );
}

/* ---------- Операция и перевод ---------- */
const KINDS_BIZ: [TxKind, string, EconomicEffect, "IN" | "OUT"][] = [
  ["EXPENSE", "Расход проекта", "PROJECT_COST", "OUT"], ["EXPENSE", "Общий расход компании", "OVERHEAD_COST", "OUT"],
  ["CLIENT_RECEIPT", "Оплата от клиента", "SALES", "IN"], ["LOAN_IN", "Получен заём / кредит", "FINANCING", "IN"],
  ["LOAN_REPAYMENT", "Погашение основного долга", "FINANCING", "OUT"], ["INTEREST", "Проценты по займу", "OVERHEAD_COST", "OUT"],
  ["TAX", "Налог", "TAX", "OUT"], ["INCOME", "Прочее поступление", "NONE", "IN"],
];
const KINDS_ME: [TxKind, string, EconomicEffect, "IN" | "OUT"][] = [
  ["EXPENSE", "Личная трата", "PERSONAL_CONSUMPTION", "OUT"], ["INCOME", "Личный доход", "PERSONAL_INCOME", "IN"],
  ["TAX", "Налог", "TAX", "OUT"], ["INCOME", "Прочее поступление", "NONE", "IN"], ["EXPENSE", "Прочее списание", "NONE", "OUT"],
];

export function OperationSheet(props: { spaceId?: UUID; direction?: "IN" | "OUT"; projectId?: UUID }) {
  const app = get();
  const [spaceId, setSpaceId] = useState<UUID>(props.spaceId ?? (app.mode === "PERSONAL" ? app.personalId! : app.businessId!));
  const sp = spaceOf(spaceId);
  const kinds = sp.type === "BUSINESS" ? KINDS_BIZ : KINDS_ME;
  const [ki, setKi] = useState(String(Math.max(0, kinds.findIndex((k) => k[3] === (props.direction ?? "OUT")))));
  const k = kinds[Number(ki)] ?? kinds[0];
  const [amount, setAmount] = useState("");
  const [account, setAccount] = useState(accountsOf(spaceId)[0]?.[0] ?? "");
  const [date, setDate] = useState(today());
  const [desc, setDesc] = useState("");
  const [project, setProject] = useState(props.projectId ?? "");
  const [line, setLine] = useState("");
  const [cp, setCp] = useState("");
  const [category, setCategory] = useState("");
  const [plan, setPlan] = useState("");
  const [loan, setLoan] = useState("");
  const [key] = useState(api.newKey);
  const s = app.s!;
  const ix = indexSnapshot(s);
  const openPlans = s.plans.filter((p) => p.spaceId === spaceId && p.direction === k[3] && !p.cancelledAt && planRemaining(ix, p) > 0n)
    .map((p) => [p.id, `${p.title} · ${formatRub(planRemaining(ix, p))}${p.dueDate ? " · " + formatDate(p.dueDate) : ""}`] as [string, string]);
  return (
    <SheetFrame title={k[3] === "IN" ? "Поступление" : "Расход"} submitText="Провести" onSubmit={async () => {
      const amt = money(amount);
      if (!account) throw new FormError("Сначала добавь счёт");
      const settlements = plan ? [{ planId: plan, amount: amt < planRemaining(ix, s.plans.find((p) => p.id === plan)!) ? amt : planRemaining(ix, s.plans.find((p) => p.id === plan)!) }] : [];
      await mutate(() => act.postOperation({
        spaceId, kind: k[0], effect: k[2], date: dateOk(date), accountId: account, amount: amt, direction: k[3], description: desc || k[1],
        projectId: project || null, counterpartyId: cp || null, category: category || null, budgetLineId: line || null, loanId: loan || null, settlements, key,
      }), "Операция проведена");
    }}>
      {app.mode === "BOTH" && !props.spaceId && <Field label="Пространство"><Seg value={spaceId} onChange={(v) => { setSpaceId(v); setAccount(accountsOf(v)[0]?.[0] ?? ""); setKi("0"); }} options={[[app.businessId!, "Продакшн"], [app.personalId!, "Я"]]} /></Field>}
      <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
      <Field label="Счёт"><Select value={account} onChange={setAccount} options={accountsOf(spaceId)} empty="—" /></Field>
      <Field label="Назначение"><Select value={ki} onChange={(v) => { setKi(v || "0"); setPlan(""); }} options={kinds.map((x, i) => [String(i), x[1]] as [string, string])} /></Field>
      <details class="more">
        <summary>Дата, проект, основание</summary>
        <Field label="Дата"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} /></Field>
        <Field label="Описание"><input value={desc} onInput={(e) => setDesc((e.target as HTMLInputElement).value)} /></Field>
        {openPlans.length > 0 && <Field label="Погасить план" hint="Факт погасит ожидаемый платёж и не будет учтён в прогнозе дважды"><Select value={plan} onChange={setPlan} options={openPlans} empty="Не связан с планом" /></Field>}
        {sp.type === "BUSINESS" ? (
          <>
            <Field label="Проект"><Select value={project} onChange={(v) => { setProject(v); setLine(""); }} options={projectsOf(spaceId)} empty="—" /></Field>
            {project && k[2] === "PROJECT_COST" && <Field label="Статья сметы"><Select value={line} onChange={setLine} options={linesOf(project)} empty="—" /></Field>}
            {(k[0] === "LOAN_IN" || k[0] === "LOAN_REPAYMENT") && <Field label="Заём"><Select value={loan} onChange={setLoan} options={s.loans.filter((l) => l.spaceId === spaceId).map((l) => [l.id, l.lenderName] as [string, string])} empty="—" /></Field>}
          </>
        ) : (
          <Field label="Категория бюджета"><Select value={category} onChange={setCategory} options={categoriesOf(spaceId)} empty="—" /></Field>
        )}
        <Field label="Контрагент"><Select value={cp} onChange={setCp} options={cpsOf(spaceId)} empty="—" /></Field>
      </details>
    </SheetFrame>
  );
}

export function TransferSheet({ spaceId }: { spaceId?: UUID }) {
  const app = get();
  const sid = spaceId ?? (app.mode === "PERSONAL" ? app.personalId! : app.businessId!);
  const accs = accountsOf(sid);
  const [from, setFrom] = useState(accs[0]?.[0] ?? "");
  const [to, setTo] = useState(accs[1]?.[0] ?? "");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("");
  const [date, setDate] = useState(today());
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title="Перевод между своими счетами" submitText="Провести" onSubmit={async () => {
      if (!from || !to || from === to) throw new FormError("Выбери два разных счёта");
      const amt = money(amount);
      const f = fee.trim() ? money(fee) : 0n;
      await mutate(() => api.rpc("cfo_transfer", { space_id: sid, from_account_id: from, to_account_id: to, amount: amt.toString(), fee: f.toString(), occurred_on: dateOk(date) }, key), "Перевод проведён");
    }}>
      <p class="fine">Одна атомарная операция: сумма денег пространства не меняется. Комиссия — отдельный расход. Перевод между личными деньгами и продакшном оформляется через «Партнёры».</p>
      <div class="two">
        <Field label="Откуда"><Select value={from} onChange={setFrom} options={accs} /></Field>
        <Field label="Куда"><Select value={to} onChange={setTo} options={accs} /></Field>
      </div>
      <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
      <div class="two">
        <Field label="Комиссия (если есть)"><MoneyInput value={fee} onInput={setFee} /></Field>
        <Field label="Дата"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} /></Field>
      </div>
    </SheetFrame>
  );
}

/* ---------- Операция и её исправление ---------- */
export function TxSheet({ txId }: { txId: UUID }) {
  const app = useApp();
  const s = app.s!;
  const t = s.transactions.find((x) => x.id === txId);
  const [hist, setHist] = useState<any[] | null>(null);
  useEffect(() => { if (t && !app.demo) api.audit(t.spaceId, t.id, 50).then(setHist).catch(() => setHist([])); }, [txId]);
  if (!t) return <SheetFrame title="Операция не найдена"><p>Нет доступа или операция удалена.</p></SheetFrame>;
  const entries = s.entries.filter((e) => e.transactionId === t.id);
  const sts = s.settlements.filter((x) => x.transactionId === t.id);
  const orig = t.correctionOf ? s.transactions.find((x) => x.id === t.correctionOf) : null;
  const versions = s.transactions.filter((x) => x.correctionOf === t.id);
  return (
    <SheetFrame title={TX_KIND[t.kind] ?? t.kind}>
      <div class="chips">
        <Badge kind="muted">{EFFECT[t.effect]}</Badge>
        {t.status === "REVERSED" && <Badge kind="warn">Исправлена</Badge>}
        <Badge kind="muted">{{ MANUAL: "Вручную", IMPORT: "Импорт", ASSISTANT: "Помощник" }[t.source]}</Badge>
      </div>
      <KV rows={[
        ["Дата", <D d={t.occurredOn} />],
        ["Описание", t.description || "—"],
        ...entries.map((e) => [s.accounts.find((a) => a.id === e.accountId)?.name ?? "Счёт", <Money v={e.amount} sign />] as [string, any]),
        ...(t.projectId ? [["Проект", s.projects.find((p) => p.id === t.projectId)?.name ?? "—"] as [string, string]] : []),
        ...(t.category ? [["Категория", t.category] as [string, string]] : []),
      ]} />
      {sts.length > 0 && <><h3>Погашения планов</h3><ul class="rows">{sts.map((x) => (
        <li key={x.id} class="row click" onClick={() => openSheet("plan", { planId: x.planId })}>
          <span class="grow">{s.plans.find((p) => p.id === x.planId)?.title}{x.status === "VOID" && <Badge kind="muted">аннулировано</Badge>}</span><Money v={x.amount} />
        </li>))}</ul></>}
      {orig && <p class="fine">Исправляет операцию от {formatDate(orig.occurredOn)}: <a href="#" onClick={(e) => { e.preventDefault(); openSheet("tx", { txId: orig.id }); }}>{orig.description}</a></p>}
      {versions.length > 0 && <p class="fine">Исправлена: {versions.map((v) => <a key={v.id} href="#" onClick={(e) => { e.preventDefault(); openSheet("tx", { txId: v.id }); }}> {v.description}</a>)}</p>}
      {t.status === "POSTED" && entries.length > 0 && !t.description.startsWith("Сторно") && t.kind !== "TRANSFER" && (
        <div class="actions-row"><Btn onClick={() => openSheet("correct", { txId: t.id })}>Исправить</Btn></div>
      )}
      <p class="fine">Проведённые операции не удаляются: исправление создаёт сторно и новую версию, история сохраняется.</p>
      {hist && hist.length > 0 && <details class="assump"><summary>История ({hist.length})</summary><History events={hist} /></details>}
    </SheetFrame>
  );
}

export function CorrectSheet({ txId }: { txId: UUID }) {
  const s = get().s!;
  const t = s.transactions.find((x) => x.id === txId)!;
  const entry = s.entries.find((e) => e.transactionId === t.id)!;
  const sts = s.settlements.filter((x) => x.transactionId === t.id && x.status === "ACTIVE");
  const amt0 = entry.amount < 0n ? -entry.amount : entry.amount;
  const [amount, setAmount] = useState(formatAmountInput(amt0));
  const [date, setDate] = useState(t.occurredOn);
  const [desc, setDesc] = useState(t.description);
  const [reason, setReason] = useState("");
  const [cancelOnly, setCancelOnly] = useState(false);
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title="Исправить операцию" submitText="Сохранить исправление" onSubmit={async () => {
      if (!reason.trim()) throw new FormError("Укажи причину исправления");
      const amt = cancelOnly ? 0n : money(amount);
      const sign = entry.amount < 0n ? -1n : 1n;
      const replacement = cancelOnly ? null : {
        kind: t.kind, effect: t.effect, occurred_on: dateOk(date), description: desc, project_id: t.projectId, counterparty_id: t.counterpartyId,
        category: t.category, loan_id: t.loanId, entries: [{ account_id: entry.accountId, amount: (sign * amt).toString() }],
        settlements: sts.length === 1 ? [{ plan_id: sts[0].planId, amount: amt.toString() }] : [],
      };
      await mutate(() => api.rpc("cfo_correct_transaction", { space_id: t.spaceId, transaction_id: t.id, reason: reason.trim(), replacement }, key), "Исправлено: сторно и новая версия сохранены");
    }}>
      <p class="fine">Исходная операция останется в истории со сторнирующими движениями; связанные погашения и резервы скорректируются в той же транзакции.</p>
      <label class="check"><input type="checkbox" checked={cancelOnly} onChange={(e) => setCancelOnly((e.target as HTMLInputElement).checked)} /> Операции не было — только сторнировать</label>
      {!cancelOnly && (
        <>
          <Field label="Правильная сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
          <Field label="Дата"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} /></Field>
          <Field label="Описание"><input value={desc} onInput={(e) => setDesc((e.target as HTMLInputElement).value)} /></Field>
          {sts.length > 1 && <p class="warn-line">Операция погашала несколько планов — новую версию привяжи к планам вручную после сохранения.</p>}
        </>
      )}
      <Field label="Причина"><input value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} placeholder="Сумма по чеку другая" /></Field>
    </SheetFrame>
  );
}

/* ---------- Меню «Добавить» ---------- */
export function AddMenuSheet() {
  const app = get();
  const biz = app.businessId, me = app.personalId;
  const items: [string, string, () => void][] = [
    ["Расход", "Факт оплаты: сумма, счёт, назначение", () => openSheet("operation", { direction: "OUT" })],
    ["Поступление", "Деньги пришли — можно погасить ожидаемый платёж", () => openSheet("operation", { direction: "IN" })],
    ["План платежа", "Будущая выплата или поступление, в т.ч. регулярные", () => openSheet("plan-new", {})],
    ["Договорённость с подрядчиком", "Одна затрата и график платежей по проекту", () => openSheet("agree-cost", {})],
    ["Перевод между счетами", "Не меняет сумму денег", () => openSheet("transfer", {})],
    ...(biz && me ? [
      ["Оплатил за компанию личными", "Затрата проекта + долг компании тебе", () => openSheet("paid-for-company", {})],
      ["Проверить выплату себе", "Симуляция без записи", () => openSheet("simulate", { kind: "OWNER_PAYOUT" })],
    ] as [string, string, () => void][] : []),
    ["Проверить трату или вложение", "Симуляция: что будет с прогнозом", () => openSheet("simulate", { kind: "EXPENSE" })],
    ["Резерв или цель", "Защитить деньги под платёж или накопление", () => openSheet("reserve", {})],
    ["Проект", "Заказной, собственный или эксперимент", () => openSheet("project", {})],
    ["Спросить помощника", "Текстом, как в чате", () => navigate("assistant")],
  ];
  return (
    <SheetFrame title="Добавить">
      <ul class="menu">
        {items.map(([t, d, fn]) => (
          <li key={t}><button type="button" onClick={() => { closeSheet(); fn(); }}><b>{t}</b><span>{d}</span></button></li>
        ))}
      </ul>
    </SheetFrame>
  );
}

export function HistorySheet({ spaceId, entityId, title }: { spaceId: UUID; entityId?: string; title?: string }) {
  const [events, setEvents] = useState<any[] | null>(null);
  useEffect(() => { api.audit(spaceId, entityId ?? null, 200).then(setEvents).catch(() => setEvents([])); }, [spaceId, entityId]);
  return <SheetFrame title={title ?? "История изменений"}>{events === null ? <p>Загружаю…</p> : events.length ? <History events={events} /> : <p>Изменений нет.</p>}</SheetFrame>;
}

