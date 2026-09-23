// Помощник (9): сообщение → намерение → уточнения → черновик → проверка → карточка подтверждения → сохранение → пересчёт.
// Все расчёты — тот же модуль, что и в интерфейсе. Запись — только кнопкой в карточке с точными суммами и датами.
import { useEffect, useRef, useState } from "preact/hooks";
import { addDays, formatDate, formatRelative, isISODate, type ISODate } from "../../../shared/dates";
import { formatRub } from "../../../shared/money";
import type { UUID } from "../../../shared/types";
import { INTENT_TEXT, parse, type Parsed } from "../../../modules/assistant/parser";
import { indexSnapshot, planRemaining } from "../../../modules/forecasting/ledger";
import { projectEconomics } from "../../../modules/forecasting/projects";
import { simulate, type PayoutBasis } from "../../../modules/forecasting/simulate";
import { BASIS_TEXT } from "../../../modules/forecasting/partners";
import * as api from "../../api";
import * as act from "../../actions";
import { get, mutate, navigate, openSheet, useApp } from "../../store";
import { Badge, Btn, D, Field, Money, MoneyInput, Quality, Select, money } from "../kit";
import { VerdictCard } from "../sheets/simulate";
import { accountsOf, formatAmountInput, projectsOf } from "../sheets/core";
import { spacesForMode } from "./Today";

interface Msg { id: string; role: "user" | "cfo"; text?: string; parsed?: Parsed; }
const log: Msg[] = [];

const EXAMPLES = [
  "Сколько я могу потратить?",
  "Пришло 450 тысяч, второй платёж за сериал",
  "Могу забрать себе 100 тысяч сегодня?",
  "Монтаж — 90 тысяч, 45 сейчас и 45 после сдачи 20 октября",
  "Что будет, если вложить 200 тысяч в ИИ-продакшн?",
  "Что платить на этой неделе?",
  "Почему доступно столько?",
  "Обзор недели",
];

export function Assistant({ params }: { params: URLSearchParams }) {
  const app = useApp();
  const [text, setText] = useState("");
  const [, force] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const send = (t: string) => {
    if (!t.trim()) return;
    log.push({ id: crypto.randomUUID(), role: "user", text: t.trim() });
    log.push({ id: crypto.randomUUID(), role: "cfo", parsed: parse(t.trim(), app.s!) });
    setText("");
    force((x) => x + 1);
    setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth" }), 30);
  };
  useEffect(() => {
    const q = params.get("q");
    if (q) { send(q); history.replaceState(null, "", "#assistant"); }
  }, []);
  return (
    <div class="screen chat">
      <p class="fine">Помощник понимает типовые фразы на русском, считает тем же модулем, что и экраны, и ничего не записывает без кнопки подтверждения. Языковая модель пока не подключена — формы и расчёты работают всегда.</p>
      {log.length === 0 && (
        <div class="chips wrap">{EXAMPLES.map((e) => <button type="button" class="chip-btn" key={e} onClick={() => send(e)}>{e}</button>)}</div>
      )}
      <div class="log">
        {log.map((m) => m.role === "user"
          ? <div class="msg me" key={m.id}>{m.text}</div>
          : <div class="msg cfo" key={m.id}><Answer p={m.parsed!} /></div>)}
        <div ref={end} />
      </div>
      <form class="ask sticky" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} placeholder="Например: пришло 450 тысяч от клиента" aria-label="Сообщение помощнику" />
        <Btn kind="primary" type="submit">Отправить</Btn>
      </form>
    </div>
  );
}

function spaceFor(p: Parsed): UUID {
  const app = get();
  if (p.projectIds.length || p.spaceHint === "BUSINESS") return app.businessId!;
  if (p.spaceHint === "PERSONAL") return app.personalId!;
  return app.mode === "PERSONAL" ? app.personalId! : app.businessId ?? app.personalId!;
}

function Answer({ p }: { p: Parsed }) {
  const app = useApp();
  const s = app.s!;
  const head = <div class="a-head"><Badge kind="info">{INTENT_TEXT[p.intent]}</Badge></div>;
  switch (p.intent) {
    case "get_summary":
    case "explain_metric": {
      const list = p.spaceHint ? app.summary!.spaces.filter((x) => x.space.type === p.spaceHint) : spacesForMode();
      return (
        <>
          {head}
          {list.map((sp) => (
            <div key={sp.space.id} class="a-block">
              <b>{sp.space.type === "BUSINESS" ? "Продакшн" : "Личные деньги"}</b>
              <p>Доступно для новых решений: <b><Money v={sp.stress.limit} unknownText="не рассчитываю — не хватает данных" /></b> при задержке клиентов на {sp.space.stressDelayDays} дн.; в базовом сценарии <Money v={sp.base.limit} />. <Quality status={sp.stress.quality.status} /></p>
              <p>На счетах <Money v={sp.cash} />, защищено резервами <Money v={sp.reserved} />, минимальный остаток <Money v={sp.minBalance} unknownText="не задан" />.
                {sp.stress.minFree.amount < 0n ? <> Самая низкая точка — <D d={sp.stress.minFree.date} />: <Money v={sp.stress.minFree.amount} />.</> : <> Минимум свободного остатка <Money v={sp.stress.minFree.amount} /> — <D d={sp.stress.minFree.date} />.</>}
              </p>
              {sp.stress.quality.issues.filter((i) => i.severity === "BLOCKING").map((i) => <p key={i.code} class="warn-line">Не хватает данных: {i.message}</p>)}
              {sp.recommendations.slice(0, 2).map((r) => <p key={r.fingerprint}>→ {r.title}</p>)}
              <Btn small kind="link" onClick={() => openSheet("explain", { spaceId: sp.space.id, what: "available" })}>Из чего сложилось</Btn>
            </div>
          ))}
        </>
      );
    }
    case "weekly_review":
      return <>{head}<p>Сводка за неделю — поступления, выплаты, изменение прогноза, просрочки и перерасходы.</p><Btn kind="primary" small onClick={() => navigate("weekly")}>Открыть обзор недели</Btn></>;
    case "get_payments": {
      const list = spacesForMode().flatMap((sp) => sp.base.events.filter((e) => e.kind !== "BUDGET" && e.date <= addDays(s.asOf, 7)).map((e) => ({ e, sp })));
      return (
        <>
          {head}
          {list.length ? <ul class="rows">{list.map(({ e }) => (
            <li key={e.key} class="row click" onClick={() => e.planId && openSheet("plan", { planId: e.planId })}>
              <span class="when">{e.overdue ? <Badge kind="bad">просрочено</Badge> : formatRelative(e.date, s.asOf)}</span><span class="grow">{e.title}</span><Money v={e.deltaC} sign />
            </li>))}</ul> : <p>На ближайшие 7 дней платежей нет.</p>}
        </>
      );
    }
    case "get_project_health": {
      const ix = indexSnapshot(s);
      const ids = p.projectIds.length ? p.projectIds : s.projects.filter((x) => x.stage !== "DONE" && x.stage !== "CANCELLED").map((x) => x.id);
      return (
        <>
          {head}
          {ids.slice(0, 5).map((id) => {
            const e = projectEconomics(s, ix, id);
            return (
              <div class="a-block" key={id}>
                <b>{e.project.name}</b>
                <p>Прогноз затрат <Money v={e.forecastCost} /> (смета <Money v={e.original} />{e.variance !== 0n && <>, отклонение <Money v={e.variance} sign /></>}).
                  {e.margin !== null && <> Оценка маржи по введённым суммам <Money v={e.margin} />.</>}
                  {e.project.model !== "SERVICE" && <> Не хватает финансирования <Money v={e.funding.unsecured} />.</>}
                  {!e.complete && <> Есть оценки без даты — прогноз неполный.</>}</p>
                <Btn small kind="link" onClick={() => navigate(`project/${id}`)}>Карточка проекта</Btn>
              </div>
            );
          })}
        </>
      );
    }
    case "simulate_expense":
    case "simulate_investment":
    case "simulate_owner_payout":
      return <SimAnswer p={p} />;
    case "draft_receipt":
    case "draft_expense":
      return <MoneyDraft p={p} />;
    case "draft_reschedule":
      return <RescheduleDraft p={p} />;
    case "draft_payment_plan": {
      const [total, ...rest] = p.amounts;
      const parts = rest.length ? rest.map((a, i) => ({ amount: formatAmountInput(a), date: p.dates[i] ?? p.dates[p.dates.length - 1] ?? s.asOf })) : total ? [{ amount: formatAmountInput(total), date: p.dates[0] ?? s.asOf }] : undefined;
      const title = p.text.split(/[—\-,:]/)[0].trim();
      return (
        <>
          {head}
          <p>Черновик: одна затрата <b>{total ? formatRub(total) : "сумма?"}</b>{parts && parts.length > 1 && <> и {parts.length} плановых платежа: {parts.map((x) => `${x.amount} ₽ — ${formatDate(x.date)}`).join(", ")}</>}.
            {p.projectIds.length ? "" : " Нужно выбрать проект."}</p>
          <Btn kind="primary" small onClick={() => openSheet("agree-cost", { projectId: p.projectIds[0], total: total ? formatAmountInput(total) : "", parts, title, fromAssistant: crypto.randomUUID() })}>Проверить и сохранить</Btn>
        </>
      );
    }
    case "draft_reimbursement":
      return <>{head}<p>Черновик: оплата за компанию личными — {p.amounts[0] ? formatRub(p.amounts[0]) : "сумма?"}. В проекте будет одна затрата и долг компании тебе.</p>
        <Btn kind="primary" small onClick={() => openSheet("paid-for-company", { amount: p.amounts[0] ? formatAmountInput(p.amounts[0]) : "", description: p.text, projectId: p.projectIds[0] })}>Проверить и сохранить</Btn></>;
    case "draft_transfer":
      return <>{head}<p>Перевод между своими счетами {p.amounts[0] ? formatRub(p.amounts[0]) : ""} — сумма денег не изменится.</p><Btn kind="primary" small onClick={() => openSheet("transfer", {})}>Открыть форму перевода</Btn></>;
    case "draft_reserve_allocation":
      return <>{head}<p>Защитить {p.amounts[0] ? formatRub(p.amounts[0]) : "сумму"} резервом. Сверх незарезервированных денег защитить нельзя.</p><Btn kind="primary" small onClick={() => openSheet("reserve", { spaceId: spaceFor(p) })}>Открыть форму резерва</Btn></>;
    default:
      return (
        <>
          <p>Не понял запрос. Я умею: сводка и доступная сумма, платежи недели, проверка траты, вложения или выплаты себе, запись поступления или расхода, договорённость с подрядчиком, перенос оплаты, оплата за компанию личными.</p>
          <div class="chips wrap">{EXAMPLES.slice(0, 4).map((e) => <span class="chip" key={e}>{e}</span>)}</div>
        </>
      );
  }
}

function SimAnswer({ p }: { p: Parsed }) {
  const app = useApp();
  const [basis, setBasis] = useState<PayoutBasis>(p.basis ?? "NONE");
  if (!p.amounts.length) return <p>Какую сумму проверить? Например: «могу потратить 50 тысяч в пятницу?»</p>;
  const kind = p.intent === "simulate_owner_payout" ? "OWNER_PAYOUT" : p.intent === "simulate_investment" ? "INVESTMENT" : "EXPENSE";
  const spaceId = kind === "OWNER_PAYOUT" ? app.businessId! : spaceFor(p);
  const sp = app.s!.spaces.find((x) => x.id === spaceId)!;
  const r = simulate(app.s!, {
    spaceId, kind, amount: p.amounts[0], date: p.dates[0] ?? app.s!.asOf, title: kind === "OWNER_PAYOUT" ? "Выплата себе" : kind === "INVESTMENT" ? "Вложение" : "Трата",
    basis: kind === "OWNER_PAYOUT" ? basis : undefined, category: p.category, effect: sp.type === "PERSONAL" && kind === "EXPENSE" ? "PERSONAL_CONSUMPTION" : undefined,
  });
  return (
    <>
      {kind === "OWNER_PAYOUT" && (
        <div class="a-block">
          <p>Основание выплаты: {basis === "NONE" ? "не выбрано — покажу только финансовый эффект" : BASIS_TEXT[basis as Exclude<PayoutBasis, "NONE">]}</p>
          <div class="chips wrap">
            {(["FEE", "REIMBURSEMENT", "LOAN", "DISTRIBUTION"] as const).map((b) => <button type="button" key={b} class="chip-btn" aria-pressed={basis === b} onClick={() => setBasis(b)}>{b === "LOAN" ? "Возврат займа" : BASIS_TEXT[b]}</button>)}
          </div>
        </div>
      )}
      <VerdictCard r={r} />
      <div class="actions-row">
        <Btn small onClick={() => openSheet("simulate", { kind, spaceId, amount: formatAmountInput(p.amounts[0]), date: p.dates[0], basis, category: p.category ?? undefined })}>Изменить условия</Btn>
        {kind === "OWNER_PAYOUT" && <Btn small kind="link" onClick={() => navigate("partners")}>Основания выплат</Btn>}
      </div>
    </>
  );
}

/** Черновик поступления/расхода: подтверждение с точными суммами, проверка версии данных перед сохранением. */
function MoneyDraft({ p }: { p: Parsed }) {
  const app = useApp();
  const s = app.s!;
  const isIn = p.intent === "draft_receipt";
  const [draftId] = useState(() => crypto.randomUUID());
  const [spaceId, setSpaceId] = useState<UUID>(spaceFor(p));
  const [amount, setAmount] = useState(p.amounts[0] ? formatAmountInput(p.amounts[0]) : "");
  const [date, setDate] = useState<ISODate>(p.dates[0] ?? s.asOf);
  const [account, setAccount] = useState(p.accountIds.find((a) => s.accounts.find((x) => x.id === a)?.spaceId === spaceId) ?? accountsOf(spaceId)[0]?.[0] ?? "");
  const [project, setProject] = useState(p.projectIds[0] ?? "");
  const ix = indexSnapshot(s);
  const candidates = s.plans.filter((x) => x.spaceId === spaceId && x.direction === (isIn ? "IN" : "OUT") && !x.cancelledAt && planRemaining(ix, x) > 0n && (!project || x.projectId === project))
    .sort((a, b) => ((a.expectedDate ?? a.dueDate ?? "9") < (b.expectedDate ?? b.dueDate ?? "9") ? -1 : 1));
  const amt = (() => { try { return money(amount); } catch { return null; } })();
  const exact = amt ? candidates.find((x) => planRemaining(ix, x) === amt) : undefined;
  const [plan, setPlan] = useState<string>(exact?.id ?? candidates[0]?.id ?? "");
  const [version, setVersion] = useState(s.spaces.find((x) => x.id === spaceId)?.dataVersion ?? 0);
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const missing = [!amt && "сумма", !account && "счёт", !isISODate(date) && "дата"].filter(Boolean) as string[];
  const ambiguous = p.projectIds.length > 1;

  useEffect(() => {
    if (app.demo || !app.s) return;
    api.insert("cfo_assistant_drafts", { id: draftId, space_id: spaceId, intent: p.intent, message: p.text, fields: { amount: amount, date, account, project, plan }, missing, data_version: version }).catch(() => {});
  }, []);

  if (done) return <div class="a-block"><Badge kind="ok">Сохранено</Badge> <span>{done}</span><AfterReceipt spaceId={spaceId} projectId={project || null} /></div>;
  const confirm = async () => {
    setErr("");
    const cur = get().s!.spaces.find((x) => x.id === spaceId)?.dataVersion ?? 0;
    if (cur !== version && !stale) {
      // данные изменились после создания черновика — показать карточку заново, не применять молча
      setStale(true);
      setVersion(cur);
      return;
    }
    if (!amt || missing.length) return setErr("Заполни: " + missing.join(", "));
    const planRow = plan ? s.plans.find((x) => x.id === plan) : null;
    const settle = planRow ? (amt > planRemaining(ix, planRow) ? planRemaining(ix, planRow) : amt) : 0n;
    setBusy(true);
    try {
      await mutate(async () => {
        if (planRow && settle === amt) await act.payPlan({ planId: planRow.id, accountId: account, amount: amt, date, key: draftId });
        else await act.postOperation({
          spaceId, kind: isIn ? (s.spaces.find((x) => x.id === spaceId)!.type === "BUSINESS" ? "CLIENT_RECEIPT" : "INCOME") : "EXPENSE",
          effect: isIn ? (s.spaces.find((x) => x.id === spaceId)!.type === "BUSINESS" ? "SALES" : "PERSONAL_INCOME") : s.spaces.find((x) => x.id === spaceId)!.type === "BUSINESS" ? (project ? "PROJECT_COST" : "OVERHEAD_COST") : "PERSONAL_CONSUMPTION",
          date, accountId: account, amount: amt, direction: isIn ? "IN" : "OUT", description: p.text, projectId: project || null, category: p.category,
          settlements: planRow && settle > 0n ? [{ planId: planRow.id, amount: settle }] : [], source: "ASSISTANT", key: draftId,
        });
        await api.update("cfo_assistant_drafts", draftId, null, { status: "CONFIRMED", result: { amount: amt.toString(), plan } }).catch(() => {});
      });
      setDone(`${isIn ? "Поступление" : "Расход"} ${formatRub(amt)} — ${formatDate(date)}${planRow ? `, погашен план «${planRow.title}»` : ""}.`);
    } catch (e: any) {
      setErr(e.message);
    } finally { setBusy(false); }
  };
  return (
    <div class="draft">
      <div class="a-head"><Badge kind="info">{INTENT_TEXT[p.intent]}</Badge> <span class="muted">черновик — ничего не сохранено</span></div>
      {stale && <p class="warn-line">Данные изменились после создания черновика — проверь суммы и связи ещё раз и подтверди.</p>}
      {ambiguous && <p class="warn-line">Подходит несколько проектов — выбери нужный.</p>}
      {app.businessId && app.personalId && <Field label="Пространство"><Select value={spaceId} onChange={(v) => { setSpaceId(v as UUID); setAccount(accountsOf(v as UUID)[0]?.[0] ?? ""); setPlan(""); }} options={[[app.businessId, "Продакшн"], [app.personalId, "Я"]]} /></Field>}
      <div class="two">
        <Field label="Сумма"><MoneyInput value={amount} onInput={setAmount} /></Field>
        <Field label="Дата"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} /></Field>
      </div>
      <Field label="Счёт"><Select value={account} onChange={setAccount} options={accountsOf(spaceId)} empty="—" /></Field>
      {spaceId === app.businessId && <Field label="Проект"><Select value={project} onChange={(v) => { setProject(v); setPlan(""); }} options={projectsOf(spaceId)} empty="—" /></Field>}
      <Field label={isIn ? "Связать с ожидаемым поступлением" : "Связать с плановой выплатой"} hint="Иначе полученный платёж остался бы в будущих поступлениях">
        <Select value={plan} onChange={setPlan} options={candidates.map((x) => [x.id, `${x.title} · ${formatRub(planRemaining(ix, x))} · ${formatDate(x.expectedDate ?? x.dueDate)}`] as [string, string])} empty="Не связывать" />
      </Field>
      {err && <p class="f-e">{err}</p>}
      <div class="actions-row">
        <Btn kind="primary" busy={busy} onClick={confirm}>{stale ? "Подтвердить заново" : `Сохранить ${amt ? formatRub(amt) : ""}`}</Btn>
      </div>
    </div>
  );
}

/** S01: после поступления — обязательства, резервы, нехватка в базовом и стресс-сценарии, доступный остаток. */
function AfterReceipt({ spaceId, projectId }: { spaceId: UUID; projectId: UUID | null }) {
  const app = useApp();
  const sp = app.summary!.spaces.find((x) => x.space.id === spaceId);
  if (!sp) return null;
  const s = app.s!;
  const ix = indexSnapshot(s);
  const upcoming = sp.base.events.filter((e) => e.deltaC < 0n && e.kind !== "BUDGET").slice(0, 5);
  const projectOut = projectId ? s.plans.filter((p) => p.projectId === projectId && p.direction === "OUT" && !p.cancelledAt && planRemaining(ix, p) > 0n) : [];
  const toSecure = upcoming.filter((e) => !e.reserveIds.length).reduce((a, e) => a - e.deltaC, 0n);
  return (
    <div class="a-block">
      <p>Пересчитал. Доступно для новых решений: <b><Money v={sp.stress.limit} unknownText="нет данных" /></b> (стресс), <Money v={sp.base.limit} /> (базовый).</p>
      <p>Защищено резервами <Money v={sp.reserved} />; ближайшие выплаты без резерва — <Money v={toSecure} />.</p>
      {sp.base.firstShortfall ? <p class="warn-line">Базовый сценарий: не хватит {formatRub(-sp.base.firstShortfall.amount)} — {formatDate(sp.base.firstShortfall.date)}</p> : <p>Базовый сценарий: нехватки нет.</p>}
      {sp.stress.firstShortfall ? <p class="warn-line">При задержке клиентов: не хватит {formatRub(-sp.stress.firstShortfall.amount)} — {formatDate(sp.stress.firstShortfall.date)}</p> : <p>Стресс-сценарий: нехватки нет.</p>}
      {projectOut.length > 0 && <p>По проекту предстоит: {projectOut.map((x) => `${x.title} ${formatRub(planRemaining(ix, x))}`).join("; ")}</p>}
      {upcoming.length > 0 && <p>Все обязательства {sp.space.type === "BUSINESS" ? "компании" : ""}: {upcoming.map((e) => `${formatDate(e.date)} ${e.title} ${formatRub(-e.deltaC)}`).join("; ")}</p>}
    </div>
  );
}

function RescheduleDraft({ p }: { p: Parsed }) {
  const app = useApp();
  const s = app.s!;
  const ix = indexSnapshot(s);
  const candidates = s.plans.filter((x) => !x.cancelledAt && planRemaining(ix, x) > 0n && (p.planIds.includes(x.id) || (p.projectIds.length ? p.projectIds.includes(x.projectId ?? "") : false) || (p.counterpartyIds.includes(x.counterpartyId ?? ""))));
  const pool = candidates.length ? candidates : s.plans.filter((x) => !x.cancelledAt && x.direction === "IN" && planRemaining(ix, x) > 0n);
  const [plan, setPlan] = useState(pool[0]?.id ?? "");
  const [date, setDate] = useState(p.dates[0] ?? addDays(s.asOf, 14));
  const [done, setDone] = useState(false);
  if (done) return <p><Badge kind="ok">Дата обновлена</Badge> Исходный срок сохранён — просрочка по нему остаётся видна.</p>;
  const pl = s.plans.find((x) => x.id === plan);
  return (
    <div class="draft">
      <div class="a-head"><Badge kind="info">Перенос платежа</Badge> <span class="muted">черновик</span></div>
      <Field label="Какой платёж"><Select value={plan} onChange={setPlan} options={pool.map((x) => [x.id, `${x.title} · ${formatRub(planRemaining(ix, x))} · срок ${formatDate(x.dueDate)}`] as [string, string])} empty="—" /></Field>
      <Field label="Новая ожидаемая дата"><input type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} /></Field>
      {pl && <p class="fine">Переписка с клиентом и договорные сроки автоматически не меняются. Исходный срок — {formatDate(pl.dueDate)}.</p>}
      <div class="actions-row">
        <Btn kind="primary" onClick={() => pl && isISODate(date) && mutate(() => act.reschedule(pl, date), "Дата обновлена").then(() => setDone(true)).catch(() => {})}>Перенести на {formatDate(date)}</Btn>
        {pl && <Btn onClick={() => openSheet("simulate", { kind: "EXPENSE", spaceId: pl.spaceId })}>Что будет с прогнозом</Btn>}
      </div>
    </div>
  );
}

