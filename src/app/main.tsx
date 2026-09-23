// Точка входа: вход → первичная настройка пространств → снимок → расчёты → экраны.
import { render } from "preact";
import * as api from "./api";
import { get, navigate, reload, set, setMode, useApp, type Mode } from "./store";
import { Btn } from "./ui/kit";
import { Today } from "./ui/screens/Today";
import { Calendar } from "./ui/screens/Calendar";
import { Directions, ProjectCard, Projects } from "./ui/screens/Projects";
import { Assistant } from "./ui/screens/Assistant";
import { Accounts, More, Partners, Personal, Reserves, Weekly } from "./ui/screens/More";
import { ImportExport, Journal, Onboarding, Settings, SignIn } from "./ui/screens/Admin";
import {
  AddMenuSheet, CancelPlanSheet, CorrectSheet, ExplainSheet, HistorySheet, OperationSheet, PaySheet, PlanEditSheet, PlanNewSheet, PlanSheet,
  RescheduleSheet, TransferSheet, TxSheet,
} from "./ui/sheets/core";
import {
  AccountSheet, BudgetSheet, ClaimSheet, ContributionSheet, DistributionSheet, GoalSheet, LoanSheet, OpeningSheet, PaidForCompanySheet,
  ReconcileSheet, ReserveSheet, ScheduleSheet, SchedulePayoutSheet,
} from "./ui/sheets/money";
import { AgreeCostSheet, BudgetLineSheet, FundingSheet, OverheadSheet, ProjectSheet, RevenueSheet } from "./ui/sheets/projects";
import { SimulateSheet } from "./ui/sheets/simulate";
import "./styles.css";

const SHEETS: Record<string, (p: any) => any> = {
  explain: ExplainSheet, plan: PlanSheet, pay: PaySheet, reschedule: RescheduleSheet, "cancel-plan": CancelPlanSheet, "plan-new": PlanNewSheet,
  "plan-edit": PlanEditSheet, operation: OperationSheet, transfer: TransferSheet, tx: TxSheet, correct: CorrectSheet, add: AddMenuSheet, history: HistorySheet,
  account: AccountSheet, reconcile: ReconcileSheet, opening: OpeningSheet, reserve: ReserveSheet, goal: GoalSheet, schedule: ScheduleSheet, budget: BudgetSheet,
  claim: ClaimSheet, "schedule-payout": SchedulePayoutSheet, distribution: DistributionSheet, loan: LoanSheet, "paid-for-company": PaidForCompanySheet,
  contribution: ContributionSheet, project: ProjectSheet, "budget-line": BudgetLineSheet, "agree-cost": AgreeCostSheet, revenue: RevenueSheet,
  funding: FundingSheet, overhead: OverheadSheet, simulate: SimulateSheet,
};

const NAV: [string, string, string][] = [
  ["today", "Сегодня", "M3 12l9-8 9 8v8a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"],
  ["calendar", "Календарь", "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"],
  ["projects", "Проекты", "M3 7h7l2 2h9v10H3z"],
  ["assistant", "Помощник", "M4 5h16v11H9l-5 4z"],
  ["more", "Ещё", "M5 12h.01M12 12h.01M19 12h.01"],
];

function Screen({ route }: { route: string }) {
  const [path, query = ""] = route.split("?");
  const params = new URLSearchParams(query);
  const [head, arg] = path.split("/");
  switch (head) {
    case "today": return <Today />;
    case "calendar": return <Calendar params={params} />;
    case "projects": return <Projects />;
    case "project": return <ProjectCard id={arg} params={params} />;
    case "directions": return <Directions />;
    case "assistant": return <Assistant params={params} />;
    case "more": return <More />;
    case "personal": return <Personal />;
    case "partners": return <Partners />;
    case "accounts": return <Accounts params={params} />;
    case "reserves": return <Reserves params={params} />;
    case "weekly": return <Weekly />;
    case "import": return <ImportExport />;
    case "journal": return <Journal />;
    case "settings": return <Settings params={params} />;
    case "onboarding": return <Onboarding />;
    case "plan": return <Redirect to="calendar" sheet={["plan", { planId: arg }]} />;
    default: return <Today />;
  }
}

function Redirect({ to, sheet }: { to: string; sheet: [string, any] }) {
  setTimeout(() => { navigate(to); set((s) => ({ sheets: [...s.sheets, { kind: sheet[0], props: sheet[1] }] })); }, 0);
  return null;
}

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>;
}

function App() {
  const app = useApp();
  if (app.phase === "loading") return <div class="boot"><div class="logo">M</div><p>Загружаю…</p></div>;
  if (app.phase === "signin" || app.phase === "not_allowed") return <SignIn notAllowed={app.phase === "not_allowed"} />;
  if (app.phase === "error") return <div class="boot"><p class="f-e">{app.error}</p><Btn onClick={() => location.reload()}>Обновить</Btn></div>;
  const head = app.route.split(/[/?]/)[0];
  const active = ["project", "directions"].includes(head) ? "projects" : ["personal", "partners", "accounts", "reserves", "weekly", "import", "journal", "settings", "onboarding"].includes(head) ? "more" : head;
  const titles: Record<string, string> = { today: "Сегодня", calendar: "Календарь платежей", projects: "Проекты", assistant: "Помощник", more: "Ещё" };
  const Sheet = app.sheets.length ? SHEETS[app.sheets[app.sheets.length - 1].kind] : null;
  return (
    <div class="shell">
      <nav class="side" aria-label="Разделы">
        <div class="brand"><div class="logo">M</div><div><b>Mark Finance</b><span>финансовый директор</span></div></div>
        {NAV.map(([r, t, d]) => <a key={r} href={`#${r}`} class={active === r ? "on" : ""} aria-current={active === r ? "page" : undefined}><Icon d={d} />{t}</a>)}
      </nav>
      <div class="main">
        {app.demo && <div class="demo-bar">ДЕМО · вымышленные данные, ничего не сохраняется</div>}
        <header class="top">
          <h1>{titles[active] ?? "Mark Finance"}</h1>
          <div class="top-r">
            <div class="seg mode" role="group" aria-label="Пространство">
              {([["PERSONAL", "Я"], ["BUSINESS", "Продакшн"], ["BOTH", "Оба"]] as [Mode, string][]).map(([m, t]) => (
                <button type="button" key={m} aria-pressed={app.mode === m} onClick={() => setMode(m)}>{t}</button>
              ))}
            </div>
            <Btn kind="primary" onClick={() => set((s) => ({ sheets: [...s.sheets, { kind: "add" }] }))}>+ Добавить</Btn>
            {app.syncing && <span class="sync" aria-label="Синхронизация">⟳</span>}
          </div>
        </header>
        <main><Screen route={app.route} /></main>
      </div>
      <nav class="bottom" aria-label="Разделы">
        {NAV.map(([r, t, d]) => <a key={r} href={`#${r}`} class={active === r ? "on" : ""} aria-current={active === r ? "page" : undefined}><Icon d={d} /><span>{t}</span></a>)}
      </nav>
      {Sheet && <Sheet {...(app.sheets[app.sheets.length - 1].props ?? {})} key={app.sheets.length} />}
      {app.toast && <div class={`toast ${app.toast.kind}`} role="status">{app.toast.text}</div>}
    </div>
  );
}

let unsub: (() => void) | null = null;
async function onSession(session: Awaited<ReturnType<typeof api.getSession>>) {
  if (get().demo) return;
  if (!session) {
    unsub?.();
    unsub = null;
    set({ phase: "signin", session: null });
    return;
  }
  if (get().session?.user.id === session.user.id && get().phase === "ready") return;
  set({ session, phase: "loading" });
  try {
    await api.bootstrap();
  } catch (e: any) {
    if (e.code === "NOT_ALLOWED") return set({ phase: "not_allowed" });
    return set({ phase: "error", error: e.message });
  }
  await reload();
  if (get().phase !== "ready") return set({ phase: "error", error: "Не удалось загрузить данные" });
  const ids = get().s!.spaces.map((x) => x.id);
  unsub?.();
  let t: any;
  unsub = api.subscribeVersions(ids, () => { clearTimeout(t); t = setTimeout(() => void reload(), 400); });
}

api.onAuth((s) => void onSession(s));
api.getSession().then((s) => void onSession(s)).catch(() => set({ phase: "signin" }));
window.addEventListener("online", () => void reload());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && get().phase === "ready") void reload(); });

render(<App />, document.getElementById("app")!);
