// Проекты (5.3): список и карточка — обзор, смета, платежи, финансирование, участники, история.
import { useEffect, useState } from "preact/hooks";
import { formatBp, formatRub } from "../../../shared/money";
import type { UUID } from "../../../shared/types";
import { indexSnapshot, planRemaining, planStatus } from "../../../modules/forecasting/ledger";
import { directionsComparison, projectEconomics, type ProjectEconomics } from "../../../modules/forecasting/projects";
import * as api from "../../api";
import { navigate, openSheet, useApp } from "../../store";
import { Badge, Btn, Card, D, Empty, KV, Money, Seg } from "../kit";
import { CERTAINTY, CERTAINTY_OUT, COST_STAGE, EFFECT, FUNDING, MODEL, STAGE } from "../labels";
import { History } from "../sheets/core";

export function Projects() {
  const app = useApp();
  const s = app.s!;
  const biz = app.businessId;
  const [show, setShow] = useState<"active" | "all">("active");
  if (!biz) return <div class="screen"><Empty text="Проекты принадлежат продакшну — пространство ещё не создано." /></div>;
  const ix = indexSnapshot(s);
  const list = s.projects.filter((p) => p.spaceId === biz && (show === "all" || (p.stage !== "DONE" && p.stage !== "CANCELLED")));
  return (
    <div class="screen">
      <div class="toolbar">
        <Seg value={show} onChange={setShow} options={[["active", "Активные"], ["all", "Все"]]} />
        <div class="toolbar-r">
          <Btn onClick={() => navigate("directions")}>Сравнить направления</Btn>
          <Btn kind="primary" onClick={() => openSheet("project", {})}>+ Проект</Btn>
        </div>
      </div>
      {list.length ? (
        <div class="cards">
          {list.map((p) => {
            const e = projectEconomics(s, ix, p.id);
            const dir = s.directions.find((d) => d.id === p.directionId);
            return (
              <button type="button" class="pcard" key={p.id} onClick={() => navigate(`project/${p.id}`)}>
                <div class="pc-h">
                  <b>{p.name}</b>
                  <span class="muted">{[dir?.name, MODEL[p.model], STAGE[p.stage]].filter(Boolean).join(" · ")}</span>
                </div>
                <ProjectNumbers e={e} compact />
                <div class="pc-f">
                  {e.nextPayment ? <span>Следующий платёж: <D d={e.nextPayment.date} /> <Money v={e.nextPayment.direction === "IN" ? e.nextPayment.amount : -e.nextPayment.amount} sign /></span> : <span class="muted">Нет запланированных платежей</span>}
                  {!e.complete && <Badge kind="warn">есть затраты без даты</Badge>}
                  {e.variance > 0n && e.original > 0n && <Badge kind="bad">перерасход {formatRub(e.variance)}</Badge>}
                  {!p.inForecast && <Badge kind="muted">не в прогнозе</Badge>}
                </div>
              </button>
            );
          })}
        </div>
      ) : <Empty text="Добавь активные проекты с остаточными затратами — без них прогноз не видит будущих выплат." action={<Btn kind="primary" onClick={() => openSheet("project", {})}>+ Проект</Btn>} />}
    </div>
  );
}

function ProjectNumbers({ e, compact }: { e: ProjectEconomics; compact?: boolean }) {
  const p = e.project;
  if (p.model === "SERVICE") {
    return (
      <div class={`nums ${compact ? "compact" : ""}`}>
        <div><span class="lbl">Продано по договору</span><b><Money v={e.revenue} /></b></div>
        <div><span class="lbl">Получено денег</span><b><Money v={e.received} /></b></div>
        <div><span class="lbl">Ожидаемые затраты</span><b><Money v={e.forecastCost} /></b></div>
        <div><span class="lbl">Оценка маржи по введённым суммам</span><b><Money v={e.margin} /> {e.marginBp !== null && <small>{formatBp(e.marginBp)}</small>}</b></div>
        {!compact && <div><span class="lbl">Потребность во временном финансировании</span><b><Money v={e.maxFinancingNeed} /></b></div>}
      </div>
    );
  }
  return (
    <div class={`nums ${compact ? "compact" : ""}`}>
      <div><span class="lbl">Бюджет</span><b><Money v={e.forecastCost > e.original ? e.forecastCost : e.original} /></b></div>
      <div><span class="lbl">Подтверждено финансирование</span><b><Money v={e.funding.confirmed} /></b></div>
      <div><span class="lbl">Получено</span><b><Money v={e.funding.received} /></b></div>
      <div><span class="lbl">Не хватает</span><b class={e.funding.unsecured > 0n ? "neg" : ""}><Money v={e.funding.unsecured} /></b></div>
      <div><span class="lbl">Собственные вложения</span><b><Money v={e.funding.ownInvestment} /></b></div>
    </div>
  );
}

export function ProjectCard({ id, params }: { id: UUID; params: URLSearchParams }) {
  const app = useApp();
  const s = app.s!;
  const [tab, setTab] = useState<string>(params.get("tab") ?? "overview");
  const [hist, setHist] = useState<any[] | null>(null);
  const p = s.projects.find((x) => x.id === id);
  useEffect(() => { if (tab === "history" && p && !app.demo) api.audit(p.spaceId, p.id, 100).then(setHist).catch(() => setHist([])); }, [tab, id]);
  if (!p) return <div class="screen"><Empty text="Проект не найден или нет доступа." action={<Btn onClick={() => navigate("projects")}>К проектам</Btn>} /></div>;
  const ix = indexSnapshot(s);
  const e = projectEconomics(s, ix, p.id);
  const dir = s.directions.find((d) => d.id === p.directionId);
  const plans = s.plans.filter((x) => x.projectId === p.id).sort((a, b) => ((a.expectedDate ?? a.dueDate ?? "9") < (b.expectedDate ?? b.dueDate ?? "9") ? -1 : 1));
  const records = s.costRecords.filter((c) => c.projectId === p.id);
  return (
    <div class="screen">
      <div class="crumbs"><a href="#projects">Проекты</a> / {p.name}</div>
      <div class="toolbar">
        <div><h1 class="h1">{p.name}</h1><span class="muted">{[dir?.name, MODEL[p.model], STAGE[p.stage], p.endDate ? `до ${new Date(p.endDate).toLocaleDateString("ru-RU")}` : "окончание не указано"].filter(Boolean).join(" · ")}</span></div>
        <Btn onClick={() => openSheet("project", { projectId: p.id })}>Изменить</Btn>
      </div>
      <Seg value={tab} onChange={setTab} options={[["overview", "Обзор"], ["budget", "Смета"], ["payments", "Платежи"], ["funding", "Финансирование"], ["people", "Участники"], ["history", "История"]]} />

      {tab === "overview" && (
        <>
          <Card><ProjectNumbers e={e} /></Card>
          {e.metrics.length > 0 && (
            <Card title="Показатели направления">
              <KV rows={e.metrics.map((m) => [m.label, m.value === null ? `нет данных (нужно количество: ${m.unit})` : <>{formatRub(m.value)} <small>= {formatRub(m.numerator)} / {m.denominator.toLocaleString("ru-RU")} {m.note ?? ""}</small></>])} />
            </Card>
          )}
          <Card title="Затраты">
            <KV rows={[
              ["Исходная смета", <Money v={e.original} />], ["Оплачено", <Money v={e.paid} />], ["Согласовано к оплате", <Money v={e.agreed} />],
              ["Оставшаяся оценка", <Money v={e.estimate} />], ["Прогноз затрат", <b><Money v={e.forecastCost} /></b>],
              ["Отклонение от сметы", <Money v={e.variance} sign />],
              ...(e.undated > 0n ? [["Оценка без даты (прогноз неполный)", <Money v={e.undated} />] as [string, any]] : []),
              ...(e.overheadAllocated > 0n ? [["Выделенные общие расходы", <Money v={e.overheadAllocated} />], ["Результат после общих расходов", <Money v={e.marginAfterOverhead} />]] as [string, any][] : []),
              ...(e.extraWorkRevenue > 0n ? [["В т.ч. допработы", <Money v={e.extraWorkRevenue} />] as [string, any]] : []),
            ]} />
          </Card>
          {p.model === "OWN_IP" && <p class="fine">Собственный проект без продаж не считается убыточным заказом: показан бюджет и обеспеченность финансированием. Необеспеченный бюджет — не кассовый разрыв: подтверждённые деньги могут ещё не поступить. ROI до появления данных не считается.</p>}
          {p.model === "EXPERIMENT" && <p class="fine">Эксперименты и обучение показываются отдельно от коммерческой маржи.</p>}
        </>
      )}

      {tab === "budget" && (
        <Card title="Смета и прогноз затрат" actions={<><Btn small onClick={() => openSheet("budget-line", { projectId: p.id })}>+ Статья</Btn><Btn small kind="primary" onClick={() => openSheet("agree-cost", { projectId: p.id })}>+ Договорённость</Btn></>}>
          {e.lines.length ? (
            <div class="tbl-wrap">
              <table class="tbl">
                <thead><tr><th>Статья</th><th>Смета</th><th>Оплачено</th><th>Согласовано</th><th>Оценка</th><th>Прогноз</th><th>Отклонение</th></tr></thead>
                <tbody>
                  {e.lines.map((l) => (
                    <tr key={l.lineId ?? "none"} class="click" onClick={() => l.lineId && openSheet("agree-cost", { projectId: p.id, lineId: l.lineId, title: l.category })}>
                      <td>{l.category}<small> {COST_STAGE[l.stage]}</small>{l.undatedEstimate > 0n && <Badge kind="warn">без даты</Badge>}</td>
                      <td><Money v={l.original} /></td><td><Money v={l.paid} /></td><td><Money v={l.agreed} /></td><td><Money v={l.estimate} /></td>
                      <td><b><Money v={l.forecast} /></b></td><td class={l.variance > 0n ? "neg" : ""}><Money v={l.variance} sign /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td>Итого</td><td><Money v={e.original} /></td><td><Money v={e.paid} /></td><td><Money v={e.agreed} /></td><td><Money v={e.estimate} /></td><td><b><Money v={e.forecastCost} /></b></td><td><Money v={e.variance} sign /></td></tr></tfoot>
              </table>
            </div>
          ) : <Empty text="Смета пуста. Добавь статьи исходной сметы — они сохраняются отдельно от текущего прогноза." />}
          <p class="fine">Прогноз затрат = оплачено + согласовано к оплате + оставшаяся оценка. Нажми на статью, чтобы заменить оценку договорённостью.</p>
        </Card>
      )}

      {tab === "payments" && (
        <Card title="Платежи проекта" actions={<><Btn small onClick={() => openSheet("plan-new", { spaceId: p.spaceId, projectId: p.id, direction: "IN" })}>+ Поступление</Btn><Btn small kind="primary" onClick={() => openSheet("plan-new", { spaceId: p.spaceId, projectId: p.id, direction: "OUT" })}>+ Выплата</Btn></>}>
          {plans.length ? (
            <ul class="rows">
              {plans.map((x) => {
                const st = planStatus(ix, x);
                return (
                  <li key={x.id} class={`row click ${st === "CANCELLED" ? "muted" : ""}`} onClick={() => openSheet("plan", { planId: x.id })}>
                    <span class={`dir ${x.direction === "IN" ? "in" : "out"}`}>{x.direction === "IN" ? "↓" : "↑"}</span>
                    <span class="grow">{x.title}<small><D d={x.expectedDate ?? x.dueDate} /> · {(x.direction === "IN" ? CERTAINTY : CERTAINTY_OUT)[x.certainty]} · {EFFECT[x.effect]}</small></span>
                    {st === "PAID" && <Badge kind="ok">оплачено</Badge>}{st === "PARTIALLY_PAID" && <Badge kind="warn">частично</Badge>}{st === "CANCELLED" && <Badge kind="muted">отменён</Badge>}
                    <Money v={x.direction === "IN" ? planRemaining(ix, x) : -planRemaining(ix, x)} sign />
                  </li>
                );
              })}
            </ul>
          ) : <Empty text="Нет плановых платежей. У всех неоплаченных затрат должны быть даты." />}
        </Card>
      )}

      {tab === "funding" && (
        <>
          {p.model === "SERVICE" && (
            <Card title="Договоры выручки" actions={<Btn small kind="primary" onClick={() => openSheet("revenue", { projectId: p.id })}>+ Договор</Btn>}>
              {s.revenueAgreements.filter((r) => r.projectId === p.id).length ? (
                <ul class="rows">{s.revenueAgreements.filter((r) => r.projectId === p.id).map((r) => (
                  <li key={r.id} class="row"><span class="grow">{r.reference || "Договор"}{r.isExtraWork && <small>допработы</small>}</span>{r.status !== "SIGNED" && <Badge kind="muted">{r.status === "DRAFT" ? "черновик" : "отменён"}</Badge>}<Money v={r.mgmtAmount} /></li>
                ))}</ul>
              ) : <Empty text="Нет договора — маржа не рассчитывается." />}
            </Card>
          )}
          <Card title="Источники финансирования" actions={<Btn small kind="primary" onClick={() => openSheet("funding", { projectId: p.id })}>+ Источник</Btn>}>
            {s.fundingSources.filter((f) => f.projectId === p.id).length ? (
              <table class="tbl">
                <thead><tr><th>Источник</th><th>Заявлено</th><th>Подтверждено</th><th>Статус</th></tr></thead>
                <tbody>{s.fundingSources.filter((f) => f.projectId === p.id).map((f) => (
                  <tr key={f.id}><td>{f.name || FUNDING[f.kind]}{f.isReallocation && <small> выделение имеющихся денег</small>}{f.terms && <small> {f.terms}</small>}</td><td><Money v={f.declared} /></td><td><Money v={f.confirmed} /></td><td>{{ DECLARED: "Заявлено", CONFIRMED: "Подтверждено", CANCELLED: "Отменено" }[f.status]}</td></tr>
                ))}</tbody>
              </table>
            ) : <Empty text="Источников нет." />}
            <KV rows={[["Подтверждено", <Money v={e.funding.confirmed} />], ["Получено", <Money v={e.funding.received} />], ["Осталось получить", <Money v={e.funding.toReceive} />], ["Необеспеченный бюджет", <Money v={e.funding.unsecured} />]]} />
          </Card>
        </>
      )}

      {tab === "people" && (
        <Card title="Затраты, оплаченные участниками">
          {records.filter((r) => r.paidByCounterpartyId).length ? (
            <ul class="rows">{records.filter((r) => r.paidByCounterpartyId).map((r) => (
              <li key={r.id} class="row"><span class="grow">{s.counterparties.find((c) => c.id === r.paidByCounterpartyId)?.name}<small><D d={r.occurredOn} /></small></span><Money v={r.amount} /></li>
            ))}</ul>
          ) : <Empty text="Никто из партнёров не платил за проект из своего кармана." />}
          <Btn kind="link" onClick={() => navigate("partners")}>Все расчёты с партнёрами</Btn>
        </Card>
      )}

      {tab === "history" && <Card title="История проекта">{hist === null ? <p>Загружаю…</p> : hist.length ? <History events={hist} /> : <p class="fine">Нет записей.</p>}</Card>}
    </div>
  );
}

export function Directions() {
  const app = useApp();
  const s = app.s!;
  if (!app.businessId) return null;
  const rows = directionsComparison(s, indexSnapshot(s), app.businessId);
  return (
    <div class="screen">
      <div class="crumbs"><a href="#projects">Проекты</a> / Сравнение направлений</div>
      <Card title="Экономика направлений">
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Направление</th><th>Получено денег</th><th>Оценка маржи заказов</th><th>Прямые расходы</th><th>Общие расходы</th><th>Собственные вложения</th><th>Макс. временное финансирование</th><th>Завершено</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.directionId ?? "none"}>
                <td>{r.name}<small> {r.projects} пр.</small>{r.training > 0n && <small> обучение/эксперименты: {formatRub(r.training)}</small>}</td>
                <td><Money v={r.received} /></td><td><Money v={r.serviceMargin} /></td><td><Money v={r.directCosts} /></td><td><Money v={r.overhead} /></td>
                <td><Money v={r.ownInvestment} /></td><td><Money v={r.maxFinancingNeed} /></td><td>{r.completed}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p class="fine">Маржа — только по заказным проектам и по введённым суммам. Собственное кино без продаж не считается убыточным: см. бюджет и обеспеченность в карточке. ROI собственных проектов не рассчитывается до появления данных.</p>
      </Card>
    </div>
  );
}
