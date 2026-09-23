// Счета и сверка, резервы и цели, личный бюджет, расчёты с партнёрами.
import { useState } from "preact/hooks";
import { addDays, isISODate } from "../../../shared/dates";
import { BP_100, formatBp, formatRub } from "../../../shared/money";
import type { UUID } from "../../../shared/types";
import { accountBalance, indexSnapshot, planRemaining, reserveBalanceNow, spaceCash, spaceReserved } from "../../../modules/forecasting/ledger";
import { computeDistribution } from "../../../modules/forecasting/partners";
import * as api from "../../api";
import * as act from "../../actions";
import { get, mutate } from "../../store";
import { Badge, Btn, Field, FormError, KV, Money, MoneyInput, Select, Seg, SheetFrame, money, today } from "../kit";
import { ACCOUNT_TYPE } from "../labels";
import { BASIS_TEXT } from "../../../modules/forecasting/partners";
import { accountsOf, formatAmountInput, projectsOf } from "./core";

const dateOk = (d: string) => { if (!isISODate(d)) throw new FormError("Укажи дату"); return d; };
const inp = (set: (v: string) => void) => (e: Event) => set((e.target as HTMLInputElement).value);

/* ---------- Счета ---------- */
export function AccountSheet({ spaceId }: { spaceId: UUID }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("BANK");
  const [bal, setBal] = useState("");
  const [date, setDate] = useState(today());
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title="Новый счёт" onSubmit={() => {
      if (!name.trim()) throw new FormError("Назови счёт");
      const b = money(bal, { allowZero: true, allowNegative: true });
      return mutate(() => api.insert("cfo_accounts", { id: key, space_id: spaceId, name: name.trim(), type, opening_balance: b.toString(), opening_date: dateOk(date), reconciled_at: dateOk(date) }), "Счёт добавлен");
    }}>
      <p class="fine">Начальный остаток — сверенная сумма на выбранную дату. Это точка отсечения: операции раньше неё в остаток не входят. Кредитный лимит сюда не включай.</p>
      <Field label="Название"><input value={name} onInput={inp(setName)} placeholder="Расчётный счёт, карта, наличные" /></Field>
      <Field label="Тип"><Select value={type} onChange={(v) => setType(v || "BANK")} options={Object.entries(ACCOUNT_TYPE) as any} /></Field>
      <div class="two">
        <Field label="Остаток сейчас (сверенный)"><MoneyInput value={bal} onInput={setBal} allowNegative /></Field>
        <Field label="На дату"><input type="date" value={date} onInput={inp(setDate)} /></Field>
      </div>
    </SheetFrame>
  );
}

export function ReconcileSheet({ accountId }: { accountId: UUID }) {
  const s = get().s!;
  const a = s.accounts.find((x) => x.id === accountId)!;
  const [date, setDate] = useState(today());
  const [entered, setEntered] = useState("");
  const [reason, setReason] = useState("");
  const [key] = useState(api.newKey);
  const ix = indexSnapshot(s);
  const computed = isISODate(date) ? accountBalance(ix, a, date) : null;
  let diff: bigint | null = null;
  try { diff = entered.trim() && computed !== null ? money(entered, { allowZero: true, allowNegative: true }) - computed : null; } catch { diff = null; }
  return (
    <SheetFrame title={`Сверка: ${a.name}`} submitText={diff ? "Сохранить с корректировкой" : "Подтвердить остаток"} onSubmit={() => {
      const e = money(entered, { allowZero: true, allowNegative: true });
      if (diff && !reason.trim()) throw new FormError("Есть расхождение — укажи причину корректировки или найди пропущенные операции");
      return mutate(() => api.rpc("cfo_reconcile", { space_id: a.spaceId, account_id: a.id, at: dateOk(date), entered: e.toString(), adjust: !!diff, reason: reason.trim() }, key),
        diff ? "Остаток скорректирован отдельной операцией" : "Остаток сверен");
    }}>
      <p class="fine">Введи фактический остаток из банка. Если он отличается от расчётного — сначала поищи пропущенные операции; корректировка — отдельная операция с причиной, она не становится выручкой или расходом проекта.</p>
      <div class="two">
        <Field label="Дата сверки"><input type="date" value={date} onInput={inp(setDate)} /></Field>
        <Field label="Фактический остаток"><MoneyInput value={entered} onInput={setEntered} allowNegative /></Field>
      </div>
      <KV rows={[["Расчётный остаток", <Money v={computed} />], ["Разница", diff === null ? "—" : diff === 0n ? <Badge kind="ok">совпадает</Badge> : <Money v={diff} sign />]]} />
      {!!diff && <Field label="Причина корректировки"><input value={reason} onInput={inp(setReason)} placeholder="Банковская комиссия, не нашёл операцию…" /></Field>}
    </SheetFrame>
  );
}

export function OpeningSheet({ accountId }: { accountId: UUID }) {
  const a = get().s!.accounts.find((x) => x.id === accountId)!;
  const [date, setDate] = useState(a.openingDate);
  const [bal, setBal] = useState(formatAmountInput(a.openingBalance < 0n ? -a.openingBalance : a.openingBalance));
  const [reason, setReason] = useState("");
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title="Пересчитать точку открытия" onSubmit={() => {
      if (!reason.trim()) throw new FormError("Укажи причину");
      const b = money(bal, { allowZero: true, allowNegative: true });
      return mutate(() => api.rpc("cfo_change_opening", { space_id: a.spaceId, account_id: a.id, opening_date: dateOk(date), opening_balance: b.toString(), reason, expected_version: act.versionOf("accounts", a.id) }, key), "Точка открытия изменена");
    }}>
      <p class="warn-line">Нужно, если хочешь импортировать операции раньше текущей точки. Новый начальный остаток — сумма на новую дату, ДО этих операций; иначе они посчитаются дважды.</p>
      <div class="two">
        <Field label="Новая дата открытия"><input type="date" value={date} onInput={inp(setDate)} /></Field>
        <Field label="Остаток на эту дату"><MoneyInput value={bal} onInput={setBal} allowNegative /></Field>
      </div>
      <Field label="Причина"><input value={reason} onInput={inp(setReason)} /></Field>
    </SheetFrame>
  );
}

/* ---------- Резервы и цели ---------- */
export function ReserveSheet({ spaceId: sid, reserveId, action: act0, planId }: { spaceId?: UUID; reserveId?: UUID; action?: "ALLOCATE" | "RELEASE"; planId?: UUID }) {
  const app = get();
  const s = app.s!;
  const ix = indexSnapshot(s);
  const existing = reserveId ? s.reserves.find((r) => r.id === reserveId) : null;
  const [spaceId, setSpaceId] = useState<UUID>(existing?.spaceId ?? sid ?? (app.mode === "PERSONAL" ? app.personalId! : app.businessId!));
  const [action, setAction] = useState<"ALLOCATE" | "RELEASE">(act0 ?? "ALLOCATE");
  const [kind, setKind] = useState<"GOAL" | "PAYMENT_LINKED">(planId ? "PAYMENT_LINKED" : "GOAL");
  const [purpose, setPurpose] = useState("");
  const [plan, setPlan] = useState(planId ?? "");
  const [goal, setGoal] = useState("");
  const [amount, setAmount] = useState("");
  const [key] = useState(api.newKey);
  const free = spaceCash(ix, spaceId) - spaceReserved(ix, spaceId);
  const plans = s.plans.filter((p) => p.spaceId === spaceId && p.direction === "OUT" && !p.cancelledAt && planRemaining(ix, p) > 0n)
    .map((p) => [p.id, `${p.title} · ${formatRub(planRemaining(ix, p))}`] as [string, string]);
  return (
    <SheetFrame title={existing ? (action === "ALLOCATE" ? `Пополнить «${existing.purpose}»` : `Освободить «${existing.purpose}»`) : "Новый резерв"} onSubmit={() => {
      const amt = money(amount);
      if (!existing && kind === "PAYMENT_LINKED" && !plan) throw new FormError("Выбери платёж, под который резерв");
      const payload: Record<string, unknown> = { space_id: spaceId, action, amount: amt.toString(), date: today() };
      if (existing) payload.reserve_id = existing.id;
      else payload.new_reserve = { purpose: purpose.trim() || (kind === "PAYMENT_LINKED" ? s.plans.find((p) => p.id === plan)?.title : s.goals.find((g) => g.id === goal)?.name) || "Резерв", kind, plan_id: plan || null, goal_id: goal || null };
      return mutate(() => api.rpc("cfo_reserve_change", payload, key), action === "ALLOCATE" ? "Деньги защищены" : "Резерв освобождён");
    }}>
      <p class="fine">Резерв не расход и не отдельный счёт: он назначает часть денег. Сверх незарезервированного остатка защитить нельзя — можно сохранить необеспеченную цель.</p>
      {!existing && app.mode === "BOTH" && <Seg value={spaceId} onChange={setSpaceId} options={[[app.businessId!, "Продакшн"], [app.personalId!, "Я"]]} />}
      {existing && <Seg value={action} onChange={setAction} options={[["ALLOCATE", "Пополнить"], ["RELEASE", "Освободить"]]} />}
      {!existing && (
        <>
          <Seg value={kind} onChange={setKind} options={[["GOAL", "Цель / фонд"], ["PAYMENT_LINKED", "Под будущий платёж"]]} />
          {kind === "PAYMENT_LINKED"
            ? <Field label="Платёж" hint="Защита уменьшится одновременно с его оплатой"><Select value={plan} onChange={setPlan} options={plans} empty="—" /></Field>
            : <Field label="Цель"><Select value={goal} onChange={setGoal} options={s.goals.filter((g) => g.spaceId === spaceId).map((g) => [g.id, g.name] as [string, string])} empty="Без цели (фонд)" /></Field>}
          <Field label="Назначение"><input value={purpose} onInput={inp(setPurpose)} placeholder="Подушка, налог за квартал, фонд развития" /></Field>
        </>
      )}
      <Field label="Сумма" hint={action === "ALLOCATE" ? `Незарезервировано сейчас: ${formatRub(free)}` : existing ? `В резерве: ${formatRub(reserveBalanceNow(ix, existing.id))}` : undefined}><MoneyInput value={amount} onInput={setAmount} /></Field>
    </SheetFrame>
  );
}

export function GoalSheet({ spaceId, goalId }: { spaceId: UUID; goalId?: UUID }) {
  const s = get().s!;
  const g = goalId ? s.goals.find((x) => x.id === goalId) : null;
  const [name, setName] = useState(g?.name ?? "");
  const [target, setTarget] = useState(g ? formatAmountInput(g.target) : "");
  const [due, setDue] = useState(g?.dueDate ?? "");
  const [kind, setKind] = useState<"EMERGENCY" | "OTHER">(g?.kind ?? "OTHER");
  const [priority, setPriority] = useState(String(g?.priority ?? 1));
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title={g ? "Цель" : "Новая цель"} onSubmit={() => {
      if (!name.trim()) throw new FormError("Назови цель");
      const row = { name: name.trim(), target: money(target, { allowZero: true }).toString(), due_date: due || null, kind, priority: Number(priority) || 0 };
      return mutate<unknown>(() => (g ? api.update("cfo_goals", g.id, act.versionOf("goals", g.id), row) : api.insert("cfo_goals", { id: key, space_id: spaceId, ...row })), "Цель сохранена");
    }}>
      <p class="fine">Накоплено = связанные резервы. Цель сама по себе деньги не блокирует — защищай их резервом. Если подушка защищена целью, не повторяй её в минимальном остатке.</p>
      <Field label="Название"><input value={name} onInput={inp(setName)} /></Field>
      <div class="two">
        <Field label="Целевая сумма"><MoneyInput value={target} onInput={setTarget} /></Field>
        <Field label="Срок"><input type="date" value={due} onInput={inp(setDue)} /></Field>
      </div>
      <div class="two">
        <Field label="Вид"><Select value={kind} onChange={(v) => setKind((v || "OTHER") as any)} options={[["EMERGENCY", "Подушка безопасности"], ["OTHER", "Другая цель"]]} /></Field>
        <Field label="Приоритет"><input type="number" min="0" value={priority} onInput={inp(setPriority)} /></Field>
      </div>
    </SheetFrame>
  );
}

export function ScheduleSheet({ reserveId }: { reserveId: UUID }) {
  const r = get().s!.reserves.find((x) => x.id === reserveId)!;
  const [date, setDate] = useState(addDays(today(), 30));
  const [amount, setAmount] = useState("");
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title={`Будущий взнос в «${r.purpose}»`} onSubmit={() => mutate(() => api.insert("cfo_reserve_schedules", { id: key, space_id: r.spaceId, reserve_id: r.id, date: dateOk(date), amount: money(amount).toString() }), "Взнос запланирован")}>
      <p class="fine">Взнос увеличивает защиту R с этой даты и не является расходом: деньги пространства не меняются, свободный остаток уменьшается.</p>
      <div class="two">
        <Field label="Дата"><input type="date" value={date} onInput={inp(setDate)} /></Field>
        <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
      </div>
    </SheetFrame>
  );
}

/* ---------- Личный бюджет ---------- */
export function BudgetSheet({ spaceId, budgetId }: { spaceId: UUID; budgetId?: UUID }) {
  const s = get().s!;
  const b = budgetId ? s.budgets.find((x) => x.id === budgetId) : null;
  const [category, setCategory] = useState(b?.category ?? "");
  const [limit, setLimit] = useState(b ? formatAmountInput(b.limit) : "");
  const [kind, setKind] = useState<"FIXED" | "VARIABLE">(b?.kind ?? "VARIABLE");
  const [month, setMonth] = useState(b?.month ?? "");
  const [inMin, setInMin] = useState(b?.inMinimum ?? false);
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title={b ? "Категория бюджета" : "Новая категория"} onSubmit={() => {
      if (!category.trim()) throw new FormError("Назови категорию");
      const row = { category: category.trim(), limit_amount: money(limit, { allowZero: true }).toString(), kind, month: month || null, in_minimum: inMin };
      return mutate<unknown>(() => (b ? api.update("cfo_personal_budgets", b.id, act.versionOf("budgets", b.id), row) : api.insert("cfo_personal_budgets", { id: key, space_id: spaceId, ...row })), "Бюджет сохранён");
    }}>
      <p class="fine">Переменные траты распределяются по оставшимся дням месяца и участвуют в прогнозе. Обязательные платежи (аренда, кредит) заведи регулярными планами — лимит здесь не создаёт второй платёж.</p>
      <Field label="Категория"><input value={category} onInput={inp(setCategory)} placeholder="Еда, транспорт, аренда…" /></Field>
      <div class="two">
        <Field label="Лимит в месяц"><MoneyInput value={limit} onInput={setLimit} /></Field>
        <Field label="Тип"><Select value={kind} onChange={(v) => setKind((v || "VARIABLE") as any)} options={[["VARIABLE", "Переменные траты"], ["FIXED", "Обязательный платёж"]]} /></Field>
      </div>
      <Field label="Месяц" hint="Пусто — шаблон для всех месяцев"><input type="month" value={month} onInput={inp(setMonth)} /></Field>
      <label class="check"><input type="checkbox" checked={inMin} onChange={(e) => setInMin((e.target as HTMLInputElement).checked)} /> Входит в обязательный месячный минимум</label>
    </SheetFrame>
  );
}

/* ---------- Партнёры ---------- */
export function ClaimSheet({ counterpartyId }: { counterpartyId?: UUID }) {
  const app = get();
  const biz = app.businessId!;
  const partners = app.s!.counterparties.filter((c) => c.spaceId === biz && (c.types.includes("PARTNER") || c.isSelf)).map((c) => [c.id, c.name] as [string, string]);
  const [cp, setCp] = useState(counterpartyId ?? partners[0]?.[0] ?? "");
  const [dir, setDir] = useState<"COMPANY_OWES" | "PARTNER_OWES">("COMPANY_OWES");
  const [basis, setBasis] = useState<"FEE" | "REIMBURSEMENT" | "LOAN">("FEE");
  const [amount, setAmount] = useState("");
  const [approved, setApproved] = useState(false);
  const [note, setNote] = useState("");
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title="Основание расчёта с партнёром" onSubmit={() => {
      if (!cp) throw new FormError("Выбери партнёра");
      if (!note.trim()) throw new FormError("Опиши основание — за что эта сумма");
      return mutate(() => api.insert("cfo_partner_claims", { id: key, space_id: biz, counterparty_id: cp, direction: dir, basis, amount: money(amount).toString(), approved, note: note.trim() }), "Основание сохранено");
    }}>
      <p class="fine">Распределение прибыли оформляется отдельно — через утверждённый пул. Возмещение расходов возникает автоматически, когда партнёр платит за компанию.</p>
      <Field label="Партнёр"><Select value={cp} onChange={setCp} options={partners} /></Field>
      <Seg value={dir} onChange={setDir} options={[["COMPANY_OWES", "Компания должна партнёру"], ["PARTNER_OWES", "Партнёр должен компании"]]} />
      <Field label="Основание"><Select value={basis} onChange={(v) => setBasis((v || "FEE") as any)} options={[["FEE", BASIS_TEXT.FEE], ["REIMBURSEMENT", BASIS_TEXT.REIMBURSEMENT], ["LOAN", BASIS_TEXT.LOAN]]} /></Field>
      <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
      <Field label="За что"><input value={note} onInput={inp(setNote)} placeholder="Режиссура сезона 1, договор от 01.09" /></Field>
      <label class="check"><input type="checkbox" checked={approved} onChange={(e) => setApproved((e.target as HTMLInputElement).checked)} /> Согласовано к выплате</label>
    </SheetFrame>
  );
}

export function SchedulePayoutSheet({ claimId }: { claimId: UUID }) {
  const s = get().s!;
  const c = s.claims.find((x) => x.id === claimId)!;
  const cp = s.counterparties.find((x) => x.id === c.counterpartyId)!;
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(addDays(today(), 7));
  const [key] = useState(api.newKey);
  const [key2] = useState(api.newKey);
  const effect = c.basis === "FEE" ? "OVERHEAD_COST" : c.basis === "REIMBURSEMENT" ? "REIMBURSEMENT" : c.basis === "LOAN" ? "FINANCING" : "PROFIT_DISTRIBUTION";
  return (
    <SheetFrame title={`Запланировать выплату: ${cp.name}`} onSubmit={async () => {
      const amt = money(amount);
      const d = dateOk(date);
      const dir = c.direction === "COMPANY_OWES" ? "OUT" : "IN";
      await mutate(async () => {
        const bizPlan = await act.createPlan({ spaceId: c.spaceId, direction: dir, amount: amt, dueDate: d, certainty: "CONTRACTED", effect, title: `${BASIS_TEXT[c.basis]}: ${cp.name}`, basis: c.note, counterpartyId: cp.id, partnerClaimId: c.id }, key);
        // Выплата себе — зеркальное ожидаемое поступление в личных деньгах, переносится согласованно
        if (cp.isSelf && dir === "OUT" && get().personalId) {
          const pid = await act.createPlan({ spaceId: get().personalId!, direction: "IN", amount: amt, dueDate: d, certainty: "CONTRACTED", effect: c.basis === "REIMBURSEMENT" ? "REIMBURSEMENT" : "PERSONAL_INCOME", title: `Из продакшна: ${BASIS_TEXT[c.basis].toLowerCase()}` }, key2);
          await api.update("cfo_payment_plans", pid, null, { linked_plan_id: bizPlan });
          await api.update("cfo_payment_plans", bizPlan, null, { linked_plan_id: pid });
        }
      }, "Выплата запланирована");
    }}>
      <p class="fine">Выплата не может превысить неоплаченный остаток основания. Если прогноз продакшна показывает нехватку до этой даты, ожидаемое поступление в личных деньгах будет помечено как проблемное.</p>
      <div class="two">
        <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
        <Field label="Дата"><input type="date" value={date} onInput={inp(setDate)} /></Field>
      </div>
    </SheetFrame>
  );
}

export function DistributionSheet() {
  const app = get();
  const biz = app.businessId!;
  const partners = app.s!.counterparties.filter((c) => c.spaceId === biz && (c.types.includes("PARTNER") || c.isSelf)).sort((a, b) => a.sortOrder - b.sortOrder);
  const [period, setPeriod] = useState("");
  const [amount, setAmount] = useState("");
  const [project, setProject] = useState("");
  const [mode, setMode] = useState<"SHARE" | "FIXED">("SHARE");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [date, setDate] = useState(today());
  const [key] = useState(api.newKey);
  let previewRows: { counterpartyId: string; amount: bigint }[] | null = null;
  let previewErr = "";
  try {
    const pool = amount.trim() ? money(amount, { allowZero: true }) : null;
    if (pool !== null) {
      const recipients = partners.filter((p) => (vals[p.id] ?? "").trim()).map((p, i) => ({
        counterpartyId: p.id, order: i,
        shareBp: mode === "SHARE" ? BigInt(Math.round(Number((vals[p.id] || "0").replace(",", ".")) * 100)) : null,
        fixed: mode === "FIXED" ? money(vals[p.id], { allowZero: true }) : null,
      }));
      if (recipients.length) previewRows = computeDistribution({ amount: pool, recipients });
    }
  } catch (e: any) { previewErr = e.message; }
  return (
    <SheetFrame title="Утверждённое распределение прибыли" wide onSubmit={() => {
      if (!previewRows) throw new FormError(previewErr || "Укажи сумму пула и доли получателей");
      const pool = money(amount, { allowZero: true });
      const recipients = partners.filter((p) => (vals[p.id] ?? "").trim()).map((p) => mode === "SHARE"
        ? { counterparty_id: p.id, share_bp: Math.round(Number(vals[p.id].replace(",", ".")) * 100) }
        : { counterparty_id: p.id, fixed: money(vals[p.id], { allowZero: true }).toString() });
      return mutate(() => api.rpc("cfo_create_distribution", { space_id: biz, period, project_id: project || null, amount: pool.toString(), approved_on: dateOk(date), recipients }, key), "Распределение утверждено");
    }}>
      <p class="fine">Вводи только согласованную с партнёрами сумму и доли — равные доли не подставляются. Доли округляются методом наибольших остатков: сумма начислений точно равна пулу. Сама по себе запись не двигает деньги — выплаты планируются отдельно.</p>
      <div class="two">
        <Field label="Период / результат"><input value={period} onInput={inp(setPeriod)} placeholder="III квартал 2026" /></Field>
        <Field label="Проект (необязательно)"><Select value={project} onChange={setProject} options={projectsOf(biz)} empty="Вся компания" /></Field>
      </div>
      <div class="two">
        <Field label="Утверждённая сумма пула"><MoneyInput value={amount} onInput={setAmount} /></Field>
        <Field label="Дата утверждения"><input type="date" value={date} onInput={inp(setDate)} /></Field>
      </div>
      <Seg value={mode} onChange={setMode} options={[["SHARE", "Доли, %"], ["FIXED", "Фиксированные суммы"]]} />
      <table class="tbl">
        <thead><tr><th>Получатель</th><th>{mode === "SHARE" ? "Доля, %" : "Сумма"}</th><th>Начислится</th></tr></thead>
        <tbody>
          {partners.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td><input inputMode="decimal" value={vals[p.id] ?? ""} onInput={(e) => setVals({ ...vals, [p.id]: (e.target as HTMLInputElement).value })} placeholder={mode === "SHARE" ? "33,33" : "0"} /></td>
              <td>{previewRows?.find((r) => r.counterpartyId === p.id) ? <Money v={previewRows.find((r) => r.counterpartyId === p.id)!.amount} /> : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {previewErr && <p class="f-e">{previewErr}</p>}
      {mode === "SHARE" && <p class="fine">Сумма долей: {formatBp(BigInt(partners.reduce((a, p) => a + Math.round(Number((vals[p.id] || "0").replace(",", ".")) * 100), 0)))} из {formatBp(BP_100)}</p>}
    </SheetFrame>
  );
}

export function LoanSheet() {
  const biz = get().businessId!;
  const [lender, setLender] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title="Заём или кредит компании" onSubmit={() => {
      if (!lender.trim()) throw new FormError("Укажи кредитора");
      return mutate(() => api.insert("cfo_loans", { id: key, space_id: biz, lender_name: lender.trim(), contract_amount: money(amount).toString(), note }), "Заём добавлен");
    }}>
      <p class="fine">Основной долг считается из операций: «Получен заём» увеличивает его, «Погашение основного долга» уменьшает. Это финансирование — маржа проектов не меняется. Проценты — отдельные расходы.</p>
      <Field label="Кредитор"><input value={lender} onInput={inp(setLender)} placeholder="Банк, инвестор" /></Field>
      <Field label="Сумма по договору"><MoneyInput value={amount} onInput={setAmount} /></Field>
      <Field label="Условия"><input value={note} onInput={inp(setNote)} placeholder="Ставка, срок, график" /></Field>
    </SheetFrame>
  );
}

/* ---------- Между личными деньгами и продакшном ---------- */
export function PaidForCompanySheet(props: { amount?: string; description?: string; projectId?: UUID }) {
  const app = get();
  const [amount, setAmount] = useState(props.amount ?? "");
  const [account, setAccount] = useState(accountsOf(app.personalId!)[0]?.[0] ?? "");
  const [desc, setDesc] = useState(props.description ?? "");
  const [project, setProject] = useState(props.projectId ?? "");
  const [date, setDate] = useState(today());
  const [reimburse, setReimburse] = useState(addDays(today(), 14));
  const [noDate, setNoDate] = useState(false);
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title="Оплатил за компанию личными" submitText="Провести" onSubmit={() => {
      if (!desc.trim()) throw new FormError("Что оплачено?");
      if (!account) throw new FormError("Выбери личный счёт");
      return mutate(() => api.rpc("cfo_paid_for_company", {
        personal_space_id: app.personalId, business_space_id: app.businessId, personal_account_id: account, amount: money(amount).toString(),
        occurred_on: dateOk(date), description: desc.trim(), project_id: project || null, reimburse_on: noDate ? null : dateOk(reimburse),
      }, key), "Проведено: затрата проекта и долг компании тебе");
    }}>
      <p class="fine">Личные деньги уменьшатся, но это не личная трата: в проекте признается затрата (один раз), а у компании появится долг тебе — возмещение. При возврате долг закроется, затрата не повторится.</p>
      <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
      <Field label="Что оплачено"><input value={desc} onInput={inp(setDesc)} placeholder="Локация на съёмочный день" /></Field>
      <div class="two">
        <Field label="С личного счёта"><Select value={account} onChange={setAccount} options={accountsOf(app.personalId!)} /></Field>
        <Field label="Проект"><Select value={project} onChange={setProject} options={projectsOf(app.businessId!)} empty="Общие расходы" /></Field>
      </div>
      <div class="two">
        <Field label="Дата оплаты"><input type="date" value={date} onInput={inp(setDate)} /></Field>
        <Field label="Когда компания вернёт"><input type="date" value={reimburse} disabled={noDate} onInput={inp(setReimburse)} /></Field>
      </div>
      <label class="check"><input type="checkbox" checked={noDate} onChange={(e) => setNoDate((e.target as HTMLInputElement).checked)} /> Дата возврата пока неизвестна</label>
    </SheetFrame>
  );
}

export function ContributionSheet() {
  const app = get();
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(accountsOf(app.personalId!)[0]?.[0] ?? "");
  const [to, setTo] = useState(accountsOf(app.businessId!)[0]?.[0] ?? "");
  const [as, setAs] = useState<"LOAN" | "INVESTMENT" | "NONE">("LOAN");
  const [project, setProject] = useState("");
  const [desc, setDesc] = useState("");
  const [date, setDate] = useState(today());
  const [key] = useState(api.newKey);
  return (
    <SheetFrame title="Личные деньги в компанию" submitText="Провести" onSubmit={() => {
      if (as === "INVESTMENT" && !project) throw new FormError("Выбери проект для вложения");
      return mutate(() => api.rpc("cfo_owner_contribution", {
        personal_space_id: app.personalId, business_space_id: app.businessId, personal_account_id: from, business_account_id: to,
        amount: money(amount).toString(), occurred_on: dateOk(date), as, project_id: project || null, description: desc,
      }, key), "Проведено в обоих пространствах");
    }}>
      <p class="fine">Новое денежное движение: личные деньги уменьшаются, у компании появляется финансирование. Выделение уже имеющихся денег компании фильму оформляй в карточке проекта — это не поступление.</p>
      <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
      <div class="two">
        <Field label="С личного счёта"><Select value={from} onChange={setFrom} options={accountsOf(app.personalId!)} /></Field>
        <Field label="На счёт компании"><Select value={to} onChange={setTo} options={accountsOf(app.businessId!)} /></Field>
      </div>
      <Seg value={as} onChange={setAs} options={[["LOAN", "Заём компании"], ["INVESTMENT", "Вложение в проект"], ["NONE", "Без основания"]]} />
      {as === "INVESTMENT" && <Field label="Проект"><Select value={project} onChange={setProject} options={projectsOf(app.businessId!)} empty="—" /></Field>}
      <div class="two">
        <Field label="Описание"><input value={desc} onInput={inp(setDesc)} /></Field>
        <Field label="Дата"><input type="date" value={date} onInput={inp(setDate)} /></Field>
      </div>
    </SheetFrame>
  );
}
