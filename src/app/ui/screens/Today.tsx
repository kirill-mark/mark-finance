// «Сегодня» — главный экран (5.1): нужно решить → доступно → на счетах/защищено/минимум → 7 дней → прогноз.
import { useState } from "preact/hooks";
import { formatRelative } from "../../../shared/dates";
import { formatRub } from "../../../shared/money";
import type { SpaceSummary } from "../../../modules/recommendations/summary";
import { QUALITY_TEXT } from "../../../modules/recommendations/summary";
import * as api from "../../api";
import { get, mutate, navigate, openSheet, useApp } from "../../store";
import { ForecastChart } from "../ForecastChart";
import { Badge, Btn, Card, D, Empty, Money, Quality, Seg, today } from "../kit";
import { SPACE_NAME } from "../labels";

export function spacesForMode(): SpaceSummary[] {
  const { summary, mode } = get();
  if (!summary) return [];
  return summary.spaces
    .filter((x) => mode === "BOTH" || x.space.type === mode)
    .sort((a, b) => (a.space.type === "BUSINESS" ? -1 : 1) - (b.space.type === "BUSINESS" ? -1 : 1));
}

export function Today() {
  const app = useApp();
  const [ask, setAsk] = useState("");
  const list = spacesForMode();
  const states = new Map<string, string>((app.raw?.recommendation_states ?? []).map((r: any) => [r.fingerprint, r.status]));
  const recs = list.flatMap((x) => x.recommendations).filter((r) => !states.has(r.fingerprint)).sort((a, b) => a.rank - b.rank).slice(0, 3);
  const onboardingOpen = list.some((x) => x.quality.status === "INSUFFICIENT");

  return (
    <div class="screen">
      {onboardingOpen && !app.demo && (
        <div class="banner">
          <span><b>Данных пока не хватает для уверенных выводов.</b> Пройди первую настройку — каждый шаг сохраняется, можно вернуться позже.</span>
          <Btn kind="primary" small onClick={() => navigate("onboarding")}>Настройка</Btn>
        </div>
      )}

      <Card title="Нужно решить">
        {recs.length ? (
          <ul class="recs">
            {recs.map((r) => (
              <li key={r.fingerprint} class={`rec rank-${Math.floor(r.rank)}`}>
                <div class="rec-t">
                  <b>{r.title}</b>
                  <span>{r.detail}</span>
                  {app.mode === "BOTH" && <span class="muted">{SPACE_NAME(app.s!.spaces.find((s) => s.id === r.spaceId)!.type)}</span>}
                </div>
                <div class="rec-a">
                  <Btn small kind="primary" onClick={() => navigate(r.action.route)}>{r.action.label}</Btn>
                  <button type="button" class="x" title="Скрыть" aria-label="Скрыть рекомендацию"
                    onClick={() => mutate(() => api.upsert("cfo_recommendation_states", { space_id: r.spaceId, fingerprint: r.fingerprint, status: "DISMISSED" }, "space_id,fingerprint")).catch(() => {})}>✕</button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty text="Срочных действий нет. Рекомендации появятся, если прогноз покажет нехватку, просрочку или пробел в данных." />
        )}
      </Card>

      {list.map((sp) => <SpaceBlock key={sp.space.id} sp={sp} showName={app.mode === "BOTH"} />)}

      <form class="ask" onSubmit={(e) => { e.preventDefault(); if (ask.trim()) navigate("assistant?q=" + encodeURIComponent(ask.trim())); }}>
        <input value={ask} onInput={(e) => setAsk((e.target as HTMLInputElement).value)} placeholder="Спросить финансового директора: «могу забрать себе 100 тысяч?»" aria-label="Вопрос помощнику" />
        <Btn kind="primary" type="submit">Спросить</Btn>
      </form>
    </div>
  );
}

function SpaceBlock({ sp, showName }: { sp: SpaceSummary; showName: boolean }) {
  const [scenario, setScenario] = useState<"STRESS" | "BASE" | "PRELIMINARY">("STRESS");
  const f = scenario === "STRESS" ? sp.stress : scenario === "BASE" ? sp.base : sp.preliminary;
  const t = today();
  const deficit = sp.stress.minFree.amount < 0n ? sp.stress.minFree : null;
  const beyond = sp.stress.points.find((p) => p.date > sp.stress.horizonEnd && p.free < 0n);
  return (
    <>
      {showName && <h2 class="space-title">{sp.space.type === "BUSINESS" ? "Продакшн" : "Личные деньги"}</h2>}
      <Card className="hero-card">
        <div class="avail">
          <div class="avail-main">
            <span class="lbl">Доступно для новых решений · {sp.space.type === "BUSINESS" ? "продакшн" : "личные"}</span>
            <strong class="big"><Money v={sp.stress.limit} unknownText="Недостаточно данных" /></strong>
            <span class="sub">
              {sp.stress.scenario.label} · горизонт до <D d={sp.stress.decisionEnd} /> · <Quality status={sp.stress.quality.status} />
            </span>
            {deficit && (
              <span class="warn-line">▲ Дефицит {formatRub(-deficit.amount)} — <D d={deficit.date} /></span>
            )}
          </div>
          <div class="avail-side">
            <span class="lbl">Базовый сценарий</span>
            <b><Money v={sp.base.limit} /></b>
            <Btn small kind="link" onClick={() => openSheet("explain", { spaceId: sp.space.id, what: "available" })}>Из чего сложилось</Btn>
          </div>
        </div>
        {sp.stress.quality.issues.length > 0 && (
          <ul class="issues">
            {sp.stress.quality.issues.map((i) => (
              <li key={i.code}><Badge kind={i.severity === "BLOCKING" ? "bad" : "warn"}>{i.severity === "BLOCKING" ? "Не хватает" : "Уточнить"}</Badge> {i.message}{i.amount !== undefined ? ` — ${formatRub(i.amount)}` : ""}</li>
            ))}
          </ul>
        )}
        <p class="fine">Это оценка по введённым данным на {new Date().toLocaleDateString("ru-RU")}, а не гарантия. {QUALITY_TEXT[sp.stress.quality.status]}.</p>
      </Card>

      <div class="triple">
        <button type="button" class="stat" onClick={() => openSheet("explain", { spaceId: sp.space.id, what: "cash" })}>
          <span class="lbl">На счетах</span><b><Money v={sp.cash} /></b><span class="sub">Из чего сложилось →</span>
        </button>
        <button type="button" class="stat" onClick={() => openSheet("explain", { spaceId: sp.space.id, what: "reserved" })}>
          <span class="lbl">Защищено резервами</span><b><Money v={sp.reserved} /></b><span class="sub">Назначения →</span>
        </button>
        <button type="button" class="stat" onClick={() => navigate(`settings?space=${sp.space.id}`)}>
          <span class="lbl">Минимальный остаток</span><b><Money v={sp.minBalance} unknownText="не задан" /></b><span class="sub">Настроить →</span>
        </button>
      </div>

      {sp.personal && <PersonalMini sp={sp} />}

      <Card title="Ближайшие 7 дней" actions={<Btn small kind="link" onClick={() => navigate(`calendar?space=${sp.space.id}`)}>Календарь</Btn>}>
        {sp.overdueIncoming.length > 0 && (
          <ul class="rows">
            {sp.overdueIncoming.map((o) => (
              <li key={o.planId} class="row overdue" onClick={() => !o.planId.startsWith("rec:") && openSheet("plan", { planId: o.planId })}>
                <Badge kind="bad">Просрочено</Badge>
                <span class="grow">{o.title}<small>ожидалось <D d={o.dueDate} /> · не в прогнозе, уточни дату</small></span>
                <Money v={o.amount} sign />
              </li>
            ))}
          </ul>
        )}
        {sp.next7.length ? (
          <ul class="rows">
            {sp.next7.map((e) => (
              <li key={e.key} class={`row ${e.overdue ? "overdue" : ""}`} onClick={() => e.planId && openSheet("plan", { planId: e.planId })}>
                {e.overdue ? <Badge kind="bad">Просрочено</Badge> : <span class="when">{formatRelative(e.date, t)}</span>}
                <span class="grow">{e.title}{e.originalDate && <small>срок был <D d={e.originalDate} /></small>}</span>
                <Money v={e.deltaC} sign />
              </li>
            ))}
          </ul>
        ) : (
          !sp.overdueIncoming.length && <Empty text="На неделе нет запланированных поступлений и выплат." action={<Btn small onClick={() => openSheet("plan-new", { spaceId: sp.space.id })}>+ План платежа</Btn>} />
        )}
      </Card>

      <Card title="Прогноз на 13 недель" actions={
        <Seg value={scenario} onChange={setScenario} label="Сценарий" options={[["STRESS", `Задержка ${sp.space.stressDelayDays} дн.`], ["BASE", "Базовый"], ["PRELIMINARY", "+ предварительные"]]} />
      }>
        <ForecastChart f={f} />
        <p class="fine">
          Минимум свободного остатка: <b><Money v={f.minFree.amount} /></b> — <D d={f.minFree.date} />.
          {f.firstShortfall && <> Денег не хватит <D d={f.firstShortfall.date} />: <Money v={f.firstShortfall.amount} />.</>}
          {" "}Конец окна: <Money v={f.daily[f.daily.length - 1]?.cEnd ?? f.endCash} />.
        </p>
        {beyond && <p class="warn-line">▲ За окном 13 недель: <D d={beyond.date} /> свободный остаток {formatRub(beyond.free)} — эти деньги уже нужны проектам.</p>}
        {f.beyond.count > 0 && <p class="fine">За горизонтом расчёта ещё {f.beyond.count} событий: выплаты {formatRub(f.beyond.out)}, поступления {formatRub(f.beyond.in)} (с <D d={f.beyond.firstDate} />).</p>}
        <details class="assump"><summary>Допущения расчёта</summary><ul>{f.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></details>
      </Card>
    </>
  );
}

function PersonalMini({ sp }: { sp: SpaceSummary }) {
  const p = sp.personal!;
  const risky = p.payouts.filter((x) => x.atRisk);
  return (
    <Card title="Личный бюджет месяца" actions={<Btn small kind="link" onClick={() => navigate("personal")}>Подробнее</Btn>}>
      {p.configured ? (
        <div class="triple compact">
          <div><span class="lbl">Лимит переменных трат осталось</span><b><Money v={p.variableRemaining} /></b></div>
          <div><span class="lbl">До следующего поступления</span><b><Money v={p.untilNextIncome.amount} /></b>{p.untilNextIncome.nextIncomeDate && <span class="sub">до <D d={p.untilNextIncome.nextIncomeDate} /></span>}</div>
          <div><span class="lbl">Подушка</span><b>{p.cushion.tenthsOfMonths === null ? "—" : `${(Number(p.cushion.tenthsOfMonths) / 10).toLocaleString("ru-RU")} мес.`}</b></div>
        </div>
      ) : (
        <p class="fine">Бюджет не настроен — показываю только лимит по прогнозу; лимиты категорий ещё не учитываются.</p>
      )}
      {risky.map((r) => <p class="warn-line" key={r.plan.id}>▲ {r.plan.title}: {r.riskNote}</p>)}
      {p.categories.filter((c) => c.overspend > 0n).map((c) => <p class="warn-line" key={c.category}>▲ Перерасход «{c.category}»: {formatRub(c.overspend)}</p>)}
    </Card>
  );
}
