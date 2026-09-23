// «Ещё»: личные деньги, партнёры, счета и операции, резервы и цели, обзор недели.
import { useState } from "preact/hooks";
import { addDays, formatDate, monthName, type ISODate } from "../../../shared/dates";
import { formatRub, sum } from "../../../shared/money";
import type { UUID } from "../../../shared/types";
import { accountBalance, indexSnapshot, planRemaining, reserveBalanceNow, spaceCash, spaceReserved } from "../../../modules/forecasting/ledger";
import { BASIS_TEXT, claimsSummary, loansSummary } from "../../../modules/forecasting/partners";
import { goalAccumulated } from "../../../modules/forecasting/personal";
import { projectEconomics } from "../../../modules/forecasting/projects";
import { navigate, openSheet, signOutAndReset, useApp } from "../../store";
import { Badge, Btn, Card, D, Empty, KV, Money, Seg, Select } from "../kit";
import { ACCOUNT_TYPE, EFFECT, TX_KIND } from "../labels";

export function More() {
  const app = useApp();
  const items: [string, string, string][] = [
    ["personal", "Личные деньги", "Бюджет месяца, цели, подушка, выплаты из бизнеса"],
    ["partners", "Партнёры", "Кто кому должен и за что, распределения, займы"],
    ["accounts", "Счета и операции", "Остатки, журнал, переводы, сверка, исправления"],
    ["reserves", "Резервы и цели", "Защищённые деньги и будущие взносы"],
    ["weekly", "Обзор недели", "Поступления, выплаты, изменение прогноза"],
    ["directions", "Сравнение направлений", "Кино, вертикальные сериалы, ИИ-продакшн"],
    ["import", "Импорт и выгрузка", "CSV из банка, резервная копия JSON"],
    ["journal", "Журнал изменений", "Кто, что и когда менял"],
    ["settings", "Настройки", "Минимальный остаток, налоги, сценарии, партнёры"],
    ["onboarding", "Первая настройка", "Пошаговое заполнение данных"],
  ];
  return (
    <div class="screen">
      <ul class="menu">
        {items.map(([r, t, d]) => <li key={r}><button type="button" onClick={() => navigate(r)}><b>{t}</b><span>{d}</span></button></li>)}
      </ul>
      <div class="actions-row">
        {app.demo ? <Btn onClick={() => signOutAndReset()}>Выйти из демо</Btn> : <Btn onClick={() => signOutAndReset()}>Выйти из аккаунта</Btn>}
      </div>
      <p class="fine">{app.session?.user.email ?? ""} · данные обновлены {app.loadedAt ? new Date(app.loadedAt).toLocaleTimeString("ru-RU") : "—"}</p>
    </div>
  );
}

/* ---------- Личные деньги (5.4, F10) ---------- */
export function Personal() {
  const app = useApp();
  const sp = app.summary!.spaces.find((x) => x.space.type === "PERSONAL");
  if (!sp) return <div class="screen"><Empty text="Личное пространство ещё не создано." /></div>;
  const p = sp.personal!;
  const m0 = Number(p.month.slice(5, 7)) - 1;
  return (
    <div class="screen">
      <div class="crumbs"><a href="#more">Ещё</a> / Личные деньги</div>
      <div class="triple">
        <div class="stat"><span class="lbl">Можно потратить сверх плана</span><b><Money v={sp.stress.limit} unknownText="нет данных" /></b><span class="sub"><Badge kind="muted">{sp.stress.quality.status === "COMPLETE" ? "полный расчёт" : "предварительно"}</Badge></span></div>
        <div class="stat"><span class="lbl">Переменный бюджет осталось</span><b><Money v={p.configured ? p.variableRemaining : null} unknownText="не настроен" /></b><span class="sub">из <Money v={p.variableLimit} /></span></div>
        <div class="stat"><span class="lbl">До следующего поступления</span><b><Money v={p.untilNextIncome.amount} /></b><span class="sub">{p.untilNextIncome.nextIncomeDate ? <>до <D d={p.untilNextIncome.nextIncomeDate} /></> : "поступлений в горизонте нет"}</span></div>
      </div>

      <Card title={`Бюджет · ${monthName(m0)}`} actions={<Btn small kind="primary" onClick={() => openSheet("budget", { spaceId: sp.space.id })}>+ Категория</Btn>}>
        {p.configured ? (
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr><th>Категория</th><th>Лимит</th><th>Факт</th><th>Запланировано</th><th>Остаток</th></tr></thead>
              <tbody>
                {p.categories.map((c) => {
                  const b = app.s!.budgets.find((x) => x.spaceId === sp.space.id && x.category === c.category && (x.month === p.month || x.month === null));
                  return (
                    <tr key={c.category} class="click" onClick={() => b && openSheet("budget", { spaceId: sp.space.id, budgetId: b.id })}>
                      <td>{c.category}<small> {c.kind === "FIXED" ? "обязательный" : "переменный"}{c.inMinimum ? " · в минимуме" : ""}</small></td>
                      <td><Money v={c.limit} /></td><td><Money v={c.actual} /></td><td><Money v={c.planned} /></td>
                      <td>{c.overspend > 0n ? <Badge kind="bad">перерасход {formatRub(c.overspend)}</Badge> : <Money v={c.remaining} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Empty text="Бюджет не настроен — показываю только лимит по прогнозу; лимиты категорий ещё не учитываются." action={<Btn onClick={() => openSheet("budget", { spaceId: sp.space.id })}>Задать бюджет</Btn>} />}
        <p class="fine">Остаток категории = лимит − факт − уже запланированные траты. Переменный остаток распределён по дням месяца и уже учтён в прогнозе. Обязательные платежи заводи регулярными планами.</p>
      </Card>

      <Card title="Подушка и цели" actions={<Btn small onClick={() => openSheet("goal", { spaceId: sp.space.id })}>+ Цель</Btn>}>
        <KV rows={[
          ["Защищённая подушка", <Money v={p.cushion.protected} />],
          ["Обязательный месячный минимум", <Money v={p.cushion.monthlyMinimum} unknownText="не задан" />],
          ["Подушка в месяцах", p.cushion.tenthsOfMonths === null ? "не рассчитывается — задай минимум в настройках" : `${(Number(p.cushion.tenthsOfMonths) / 10).toLocaleString("ru-RU")} мес.`],
        ]} />
        {p.goals.length ? (
          <ul class="rows">
            {p.goals.map((g) => (
              <li key={g.goal.id} class="row click" onClick={() => openSheet("goal", { spaceId: sp.space.id, goalId: g.goal.id })}>
                <span class="grow">{g.goal.name}{g.goal.kind === "EMERGENCY" && <Badge kind="info">подушка</Badge>}<small>{g.goal.dueDate ? <>к <D d={g.goal.dueDate} /></> : "без срока"}</small>
                  <span class="bar"><i style={{ width: `${Math.min(100, Number(g.progressBp ?? 0n) / 100)}%` }} /></span></span>
                <span class="amt"><Money v={g.accumulated} /><small>из {formatRub(g.goal.target)}</small></span>
              </li>
            ))}
          </ul>
        ) : <Empty text="Целей нет. Цель не блокирует деньги сама по себе — защищай её резервом." />}
        <Btn small kind="link" onClick={() => navigate(`reserves?space=${sp.space.id}`)}>Резервы</Btn>
      </Card>

      <Card title="Ожидаемые выплаты из продакшна">
        {p.payouts.length ? (
          <ul class="rows">
            {p.payouts.map((x) => (
              <li key={x.plan.id} class="row click" onClick={() => openSheet("plan", { planId: x.plan.id })}>
                <span class="grow">{x.plan.title}<small><D d={x.plan.expectedDate ?? x.plan.dueDate} />{x.atRisk && ` · ${x.riskNote}`}</small></span>
                {x.atRisk && <Badge kind="bad">под угрозой</Badge>}
                <Money v={x.remaining} sign />
              </li>
            ))}
          </ul>
        ) : <p class="fine">Нет утверждённых выплат. Предполагаемая доля будущей прибыли не превращается в личное поступление без утверждённого графика.</p>}
      </Card>
    </div>
  );
}

/* ---------- Партнёры (5.5, F11) ---------- */
export function Partners() {
  const app = useApp();
  const s = app.s!;
  const biz = app.businessId;
  if (!biz) return <div class="screen"><Empty text="Расчёты с партнёрами ведутся в пространстве продакшна." /></div>;
  const ix = indexSnapshot(s);
  const people = claimsSummary(s, ix, biz);
  const loans = loansSummary(s, biz);
  return (
    <div class="screen">
      <div class="crumbs"><a href="#more">Ещё</a> / Партнёры</div>
      <div class="toolbar">
        <div class="toolbar-r">
          <Btn onClick={() => openSheet("paid-for-company", {})}>Оплатил за компанию личными</Btn>
          <Btn onClick={() => openSheet("contribution", {})}>Личные деньги в компанию</Btn>
          <Btn onClick={() => openSheet("distribution", {})}>Распределение прибыли</Btn>
          <Btn kind="primary" onClick={() => openSheet("claim", {})}>+ Основание</Btn>
        </div>
      </div>
      {people.map((p) => (
        <Card key={p.counterpartyId} title={p.name} actions={<><span class="muted">компания должна <b>{formatRub(p.companyOwesTotal)}</b> · должен компании <b>{formatRub(p.partnerOwesTotal)}</b></span></>}>
          {p.companyOwes.length + p.partnerOwes.length === 0 ? <p class="fine">Расчётов нет. Доли и суммы не подставляются — только введённые основания.</p> : (
            <div class="tbl-wrap">
              <table class="tbl">
                <thead><tr><th>Основание</th><th>Кто кому</th><th>Сумма</th><th>Оплачено</th><th>Запланировано</th><th>Остаток</th><th /></tr></thead>
                <tbody>
                  {[...p.companyOwes.map((c) => ({ c, dir: "Компания → " + p.name })), ...p.partnerOwes.map((c) => ({ c, dir: p.name + " → компании" }))].map(({ c, dir }) => (
                    <tr key={c.claimId}>
                      <td>{BASIS_TEXT[c.basis]}<small> {c.note}</small>{c.approved ? <Badge kind="ok">согласовано</Badge> : <Badge kind="warn">не согласовано</Badge>}</td>
                      <td>{dir}</td><td><Money v={c.amount} /></td><td><Money v={c.paid} /></td><td><Money v={c.scheduled} /></td><td><b><Money v={c.remaining} /></b></td>
                      <td>{c.approved && c.unscheduled > 0n && <Btn small onClick={() => openSheet("schedule-payout", { claimId: c.claimId })}>Запланировать</Btn>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {p.companyOwes.length > 0 && p.partnerOwes.length > 0 && <p class="fine">Встречные обязательства показаны отдельно; взаимозачёт — только отдельной подтверждённой операцией.</p>}
        </Card>
      ))}
      <Card title="Займы и кредиты компании" actions={<Btn small onClick={() => openSheet("loan", {})}>+ Заём</Btn>}>
        {loans.length ? (
          <table class="tbl">
            <thead><tr><th>Кредитор</th><th>По договору</th><th>Получено</th><th>Погашено</th><th>Основной долг</th></tr></thead>
            <tbody>{loans.map((l) => <tr key={l.loanId}><td>{l.lender}</td><td><Money v={l.contract} /></td><td><Money v={l.received} /></td><td><Money v={l.repaid} /></td><td><b><Money v={l.outstanding} /></b></td></tr>)}</tbody>
          </table>
        ) : <p class="fine">Займов нет. Заём — финансирование: деньги растут, маржа проектов не меняется.</p>}
      </Card>
    </div>
  );
}

/* ---------- Счета и операции (5.6) ---------- */
export function Accounts({ params }: { params: URLSearchParams }) {
  const app = useApp();
  const s = app.s!;
  const ix = indexSnapshot(s);
  const [space, setSpace] = useState<UUID>(params.get("space") ?? (app.mode === "PERSONAL" ? app.personalId! : app.businessId ?? app.personalId!));
  const [account, setAccount] = useState("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(50);
  const sp = s.spaces.find((x) => x.id === space)!;
  const accs = s.accounts.filter((a) => a.spaceId === space);
  const txs = s.transactions.filter((t) => t.spaceId === space && (!account || s.entries.some((e) => e.transactionId === t.id && e.accountId === account)) &&
    (!q || (t.description + " " + (TX_KIND[t.kind] ?? "")).toLowerCase().includes(q.toLowerCase()))).sort((a, b) => (a.occurredOn > b.occurredOn ? -1 : a.occurredOn < b.occurredOn ? 1 : a.createdAt > b.createdAt ? -1 : 1));
  return (
    <div class="screen">
      <div class="crumbs"><a href="#more">Ещё</a> / Счета и операции</div>
      <div class="toolbar">
        {app.businessId && app.personalId ? <Seg value={space} onChange={(v) => { setSpace(v); setAccount(""); }} options={[[app.businessId, "Продакшн"], [app.personalId, "Я"]]} /> : <span />}
        <div class="toolbar-r">
          <Btn onClick={() => openSheet("transfer", { spaceId: space })}>Перевод</Btn>
          <Btn onClick={() => openSheet("operation", { spaceId: space, direction: "IN" })}>+ Поступление</Btn>
          <Btn kind="primary" onClick={() => openSheet("operation", { spaceId: space, direction: "OUT" })}>+ Расход</Btn>
        </div>
      </div>
      <Card title="Счета" actions={<Btn small onClick={() => openSheet("account", { spaceId: space })}>+ Счёт</Btn>}>
        {accs.length ? (
          <ul class="rows">
            {accs.map((a) => {
              const stale = !a.reconciledAt || (s.asOf > addDays(a.reconciledAt, sp.reconcileStaleDays));
              return (
                <li key={a.id} class={`row ${a.archived ? "muted" : ""}`}>
                  <span class="grow">{a.name}<small>{ACCOUNT_TYPE[a.type]} · открыт <D d={a.openingDate} /> · {a.reconciledAt ? <>сверен <D d={a.reconciledAt} /></> : "не сверен"}</small></span>
                  {stale && !a.archived && <Badge kind="warn">сверка устарела</Badge>}
                  <span class="amt"><Money v={accountBalance(ix, a)} /></span>
                  <span class="row-actions">
                    <Btn small onClick={() => openSheet("reconcile", { accountId: a.id })}>Сверить</Btn>
                    <Btn small kind="link" onClick={() => openSheet("opening", { accountId: a.id })}>Точка открытия</Btn>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : <Empty text="Счетов нет. Добавь счета со сверенными остатками — это основа всех расчётов." action={<Btn kind="primary" onClick={() => openSheet("account", { spaceId: space })}>+ Счёт</Btn>} />}
        <KV rows={[["Всего денег", <Money v={spaceCash(ix, space)} />], ["Защищено резервами", <Money v={spaceReserved(ix, space)} />]]} />
      </Card>
      <Card title="Журнал операций">
        <div class="filters">
          <Select value={account} onChange={setAccount} options={accs.map((a) => [a.id, a.name] as [string, string])} empty="Все счета" />
          <input value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="Поиск" aria-label="Поиск по журналу" />
        </div>
        {txs.length ? (
          <ul class="rows">
            {txs.slice(0, limit).map((t) => {
              const net = sum(s.entries.filter((e) => e.transactionId === t.id && (!account || e.accountId === account)).map((e) => e.amount));
              return (
                <li key={t.id} class={`row click ${t.status === "REVERSED" ? "muted strike" : ""}`} onClick={() => openSheet("tx", { txId: t.id })}>
                  <span class="when"><D d={t.occurredOn} /></span>
                  <span class="grow">{t.description || TX_KIND[t.kind]}<small>{TX_KIND[t.kind]} · {EFFECT[t.effect]}{t.source === "IMPORT" ? " · импорт" : t.source === "ASSISTANT" ? " · помощник" : ""}</small></span>
                  {t.status === "REVERSED" && <Badge kind="muted">исправлена</Badge>}
                  <Money v={net} sign />
                </li>
              );
            })}
          </ul>
        ) : <Empty text="Операций пока нет." />}
        {txs.length > limit && <Btn kind="link" onClick={() => setLimit(limit + 100)}>Показать ещё</Btn>}
      </Card>
    </div>
  );
}

/* ---------- Резервы и цели (F06) ---------- */
export function Reserves({ params }: { params: URLSearchParams }) {
  const app = useApp();
  const s = app.s!;
  const ix = indexSnapshot(s);
  const [space, setSpace] = useState<UUID>(params.get("space") ?? (app.mode === "PERSONAL" ? app.personalId! : app.businessId ?? app.personalId!));
  const sp = s.spaces.find((x) => x.id === space)!;
  const reserves = s.reserves.filter((r) => r.spaceId === space);
  const cash = spaceCash(ix, space), reserved = spaceReserved(ix, space);
  return (
    <div class="screen">
      <div class="crumbs"><a href="#more">Ещё</a> / Резервы и цели</div>
      <div class="toolbar">
        {app.businessId && app.personalId ? <Seg value={space} onChange={setSpace} options={[[app.businessId, "Продакшн"], [app.personalId, "Я"]]} /> : <span />}
        <Btn kind="primary" onClick={() => openSheet("reserve", { spaceId: space })}>+ Резерв</Btn>
      </div>
      <div class="triple">
        <div class="stat"><span class="lbl">Деньги C</span><b><Money v={cash} /></b></div>
        <div class="stat"><span class="lbl">Защищено R</span><b><Money v={reserved} /></b></div>
        <div class="stat"><span class="lbl">Минимальный остаток B</span><b><Money v={sp.minBalance} unknownText="не задан" /></b><span class="sub">всего защищено R + B: {sp.minBalance === null ? "—" : formatRub(reserved + sp.minBalance)}</span></div>
      </div>
      {cash - reserved < 0n && <p class="warn-line">▲ Дефицит покрытия: резервов больше, чем денег, на {formatRub(reserved - cash)}. Фактические операции сохранены — пересмотри резервы.</p>}
      <Card title="Резервы">
        {reserves.length ? (
          <ul class="rows">
            {reserves.map((r) => {
              const plan = s.plans.find((p) => p.id === r.planId);
              const goal = s.goals.find((g) => g.id === r.goalId);
              const sch = s.reserveSchedules.filter((x) => x.reserveId === r.id && x.status === "PLANNED");
              return (
                <li key={r.id} class="row">
                  <span class="grow">{r.purpose}<small>{r.kind === "PAYMENT_LINKED" ? <>под платёж «{plan?.title}» {plan && <D d={plan.expectedDate ?? plan.dueDate} />}</> : goal ? `цель «${goal.name}»` : "фонд"}
                    {sch.length > 0 && <> · взносы: {sch.map((x) => `${formatDate(x.date)} ${formatRub(x.amount)}`).join(", ")}</>}</small></span>
                  <span class="amt"><Money v={reserveBalanceNow(ix, r.id)} /></span>
                  <span class="row-actions">
                    <Btn small onClick={() => openSheet("reserve", { reserveId: r.id, action: "ALLOCATE" })}>+</Btn>
                    <Btn small onClick={() => openSheet("reserve", { reserveId: r.id, action: "RELEASE" })}>−</Btn>
                    <Btn small kind="link" onClick={() => openSheet("schedule", { reserveId: r.id })}>Взнос</Btn>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : <Empty text="Резервов нет. Защити деньги под налоги, зарплату команды или подушку." />}
      </Card>
      <Card title="Цели" actions={<Btn small onClick={() => openSheet("goal", { spaceId: space })}>+ Цель</Btn>}>
        {s.goals.filter((g) => g.spaceId === space).length ? (
          <ul class="rows">{s.goals.filter((g) => g.spaceId === space).map((g) => (
            <li key={g.id} class="row click" onClick={() => openSheet("goal", { spaceId: space, goalId: g.id })}>
              <span class="grow">{g.name}{g.kind === "EMERGENCY" && <Badge kind="info">подушка</Badge>}<small>{g.dueDate ? <>к <D d={g.dueDate} /></> : "без срока"}</small></span>
              <span class="amt"><Money v={goalAccumulated(s, ix, g.id)} /><small>из {formatRub(g.target)}</small></span>
            </li>))}</ul>
        ) : <p class="fine">Целей нет.</p>}
      </Card>
    </div>
  );
}

/* ---------- Обзор недели (S08) ---------- */
export function Weekly() {
  const app = useApp();
  const s = app.s!;
  const ix = indexSnapshot(s);
  const from: ISODate = addDays(s.asOf, -7);
  const hist = (app.raw?.forecast_history ?? []) as any[];
  return (
    <div class="screen">
      <div class="crumbs"><a href="#more">Ещё</a> / Обзор недели</div>
      <p class="fine">С {formatDate(from)} по {formatDate(s.asOf)}. Каждый пункт открывает соответствующий экран. Внешняя рассылка не выполняется.</p>
      {app.summary!.spaces.map((sp) => {
        const txs = s.transactions.filter((t) => t.spaceId === sp.space.id && t.occurredOn > from && t.occurredOn <= s.asOf && t.effect !== "INTERNAL_TRANSFER");
        const flows = txs.flatMap((t) => s.entries.filter((e) => e.transactionId === t.id).map((e) => e.amount));
        const inn = sum(flows.filter((x) => x > 0n)), out = sum(flows.filter((x) => x < 0n));
        const past = hist.filter((h) => h.space_id === sp.space.id && h.scenario === "STRESS" && h.date <= from).pop();
        const prevLimit = past && past.limit_amount !== null ? BigInt(past.limit_amount) : null;
        const overdue = s.plans.filter((p) => p.spaceId === sp.space.id && !p.cancelledAt && p.dueDate && p.dueDate < s.asOf && planRemaining(ix, p) > 0n);
        const overruns = sp.space.type === "BUSINESS" ? s.projects.filter((p) => p.spaceId === sp.space.id && p.stage !== "CANCELLED").map((p) => projectEconomics(s, ix, p.id)).filter((e) => e.original > 0n && e.variance > 0n) : [];
        const next = sp.base.events.filter((e) => e.deltaC < 0n && e.kind !== "BUDGET" && e.date <= addDays(s.asOf, 7));
        return (
          <Card key={sp.space.id} title={sp.space.type === "BUSINESS" ? "Продакшн" : "Личные деньги"}>
            <KV rows={[
              ["Поступило за неделю", <Money v={inn} sign />],
              ["Выплачено за неделю", <Money v={out} />],
              ["Доступно сейчас (стресс)", <Money v={sp.stress.limit} />],
              ["Неделю назад", prevLimit === null ? "нет сохранённого прогноза" : <><Money v={prevLimit} /> → изменение <Money v={sp.stress.limit === null ? null : sp.stress.limit - prevLimit} sign /></>],
            ]} />
            {overdue.length > 0 && <><h3>Просрочки</h3><ul class="rows">{overdue.map((p) => <li key={p.id} class="row click overdue" onClick={() => openSheet("plan", { planId: p.id })}><span class="grow">{p.title}<small>срок <D d={p.dueDate} /></small></span><Money v={p.direction === "IN" ? planRemaining(ix, p) : -planRemaining(ix, p)} sign /></li>)}</ul></>}
            {overruns.length > 0 && <><h3>Перерасходы проектов</h3><ul class="rows">{overruns.map((e) => <li key={e.project.id} class="row click" onClick={() => navigate(`project/${e.project.id}?tab=budget`)}><span class="grow">{e.project.name}</span><Money v={e.variance} sign /></li>)}</ul></>}
            <h3>Решения на ближайшую неделю</h3>
            {next.length ? <ul class="rows">{next.map((e) => <li key={e.key} class="row click" onClick={() => e.planId && openSheet("plan", { planId: e.planId })}><span class="when"><D d={e.date} /></span><span class="grow">{e.title}</span><Money v={e.deltaC} sign /></li>)}</ul> : <p class="fine">Выплат нет.</p>}
            {sp.recommendations.slice(0, 3).map((r) => <p key={r.fingerprint}><a href={`#${r.action.route}`}>→ {r.title}</a></p>)}
          </Card>
        );
      })}
    </div>
  );
}

