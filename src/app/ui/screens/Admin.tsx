// Импорт и выгрузка (11), журнал изменений, настройки (5.7), первая настройка (5), вход.
import { useEffect, useState } from "preact/hooks";
import { parseRub } from "../../../shared/money";
import type { Space, UUID } from "../../../shared/types";
import { indexSnapshot, planRemaining } from "../../../modules/forecasting/ledger";
import { autoMapping, effectForKind, fingerprint, parseCsv, preview, TEMPLATE_COLUMNS, TEMPLATE_CSV, toCsv, type Mapping, type PreviewRow } from "../../../modules/import-export/csv";
import * as api from "../../api";
import * as act from "../../actions";
import { applyRaw, mutate, navigate, openSheet, set, useApp } from "../../store";
import { Badge, Btn, Card, D, Empty, Field, FormError, KV, Money, MoneyInput, Select, Seg, money } from "../kit";
import { TAX_STATUS, TX_KIND, EFFECT } from "../labels";
import { History, formatAmountInput } from "../sheets/core";
import { demoSnapshot } from "../../demo";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ---------- Импорт и выгрузка ---------- */
export function ImportExport() {
  const app = useApp();
  const s = app.s!;
  const [space, setSpace] = useState<UUID>(app.mode === "PERSONAL" ? app.personalId! : app.businessId ?? app.personalId!);
  const [file, setFile] = useState<{ name: string; text: string; fp: string } | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [pv, setPv] = useState<PreviewRow[] | null>(null);
  const [result, setResult] = useState<any>(null);
  const [key, setKey] = useState(api.newKey);
  const onFile = async (f: File) => {
    const text = await f.text();
    const all = parseCsv(text);
    setFile({ name: f.name, text, fp: await fingerprint(text) });
    setRows(all);
    setMapping(autoMapping(all[0] ?? []));
    setPv(null);
    setResult(null);
    setKey(api.newKey());
  };
  const conflicts = (app.raw?.import_conflicts ?? []) as any[];
  const exportOps = () => {
    const rowsOut = s.transactions.map((t) => {
      const amt = s.entries.filter((e) => e.transactionId === t.id).reduce((a, e) => a + e.amount, 0n);
      return [t.occurredOn, s.spaces.find((x) => x.id === t.spaceId)?.type === "BUSINESS" ? "Продакшн" : "Я", TX_KIND[t.kind] ?? t.kind, EFFECT[t.effect], t.description,
        s.projects.find((p) => p.id === t.projectId)?.name ?? "", t.category ?? "", (Number(amt) / 100).toFixed(2), t.status === "REVERSED" ? "исправлена" : ""];
    });
    download(`operations-${s.asOf}.csv`, toCsv(["Дата", "Пространство", "Операция", "Смысл", "Описание", "Проект", "Категория", "Сумма", "Статус"], rowsOut, [7]), "text/csv");
  };
  const exportPlans = () => {
    const ix = indexSnapshot(s);
    const rowsOut = s.plans.map((p) => [p.dueDate ?? "", p.expectedDate ?? "", p.direction === "IN" ? "Входящий" : "Исходящий", p.title, (Number(p.amount) / 100).toFixed(2),
      (Number(planRemaining(ix, p)) / 100).toFixed(2), p.certainty, EFFECT[p.effect], s.projects.find((x) => x.id === p.projectId)?.name ?? "", p.cancelledAt ? "отменён" : ""]);
    download(`plans-${s.asOf}.csv`, toCsv(["Срок", "Ожидается", "Направление", "Название", "Сумма", "Остаток", "Подтверждённость", "Смысл", "Проект", "Статус"], rowsOut, [4, 5]), "text/csv");
  };
  return (
    <div class="screen">
      <div class="crumbs"><a href="#more">Ещё</a> / Импорт и выгрузка</div>
      <Card title="Импорт CSV" actions={<Btn small kind="link" onClick={() => download("template.csv", TEMPLATE_CSV, "text/csv")}>Скачать шаблон</Btn>}>
        <p class="fine">Шаблон: {TEMPLATE_COLUMNS.join(", ")}. Обязательны дата, счёт, направление и сумма в рублях. В предпросмотре ничего не записывается. Повтор external_id на том же счёте и повтор файла не создают новых операций; похожие строки ждут твоего решения.</p>
        {app.businessId && app.personalId && <Seg value={space} onChange={(v) => { setSpace(v); setPv(null); }} options={[[app.businessId, "Продакшн"], [app.personalId, "Я"]]} />}
        <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void onFile(f); }} />
        {rows.length > 0 && !pv && (
          <>
            <h3>Сопоставление колонок</h3>
            <div class="map-grid">
              {TEMPLATE_COLUMNS.map((c) => (
                <Field key={c} label={c}>
                  <Select value={mapping[c] === undefined ? "" : String(mapping[c])} onChange={(v) => setMapping({ ...mapping, [c]: v === "" ? undefined : Number(v) })}
                    options={(rows[0] ?? []).map((h, i) => [String(i), h || `колонка ${i + 1}`] as [string, string])} empty="—" />
                </Field>
              ))}
            </div>
            <Btn kind="primary" onClick={() => setPv(preview(rows.slice(1), mapping, s, space))}>Предпросмотр</Btn>
          </>
        )}
        {pv && !result && (
          <>
            <h3>Предпросмотр: {pv.filter((r) => r.decision === "IMPORT").length} к проведению из {pv.length}</h3>
            <div class="tbl-wrap">
              <table class="tbl small">
                <thead><tr><th>#</th><th>Дата</th><th>Сумма</th><th>Описание</th><th>Проверка</th><th>Решение</th></tr></thead>
                <tbody>
                  {pv.map((r, i) => (
                    <tr key={r.rowNo} class={r.status === "ERROR" || r.status === "BLOCKED" ? "neg-row" : ""}>
                      <td>{r.rowNo}</td><td>{r.date ?? r.raw.date}</td>
                      <td>{r.amount !== null ? <Money v={r.direction === "OUT" ? -r.amount : r.amount} sign /> : r.raw.amount_rub}</td>
                      <td>{r.description}</td>
                      <td><Badge kind={r.status === "READY" ? "ok" : r.status === "SIMILAR" ? "warn" : r.status === "DUPLICATE" ? "muted" : "bad"}>{{ READY: "готово", SIMILAR: "похожая", DUPLICATE: "повтор", ERROR: "ошибка", BLOCKED: "заблокировано" }[r.status]}</Badge> <small>{r.message}</small></td>
                      <td>{r.status === "READY" || r.status === "SIMILAR" ? (
                        <Select value={r.decision} onChange={(v) => setPv(pv.map((x, j) => (j === i ? { ...x, decision: (v || "SKIP") as any } : x)))}
                          options={[["IMPORT", "Провести"], ["SKIP", "Пропустить"], ["REVIEW", "Решить позже"]]} />
                      ) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div class="actions-row">
              <Btn onClick={() => setPv(null)}>Назад к сопоставлению</Btn>
              <Btn kind="primary" onClick={() => mutate(() => api.rpc("cfo_import_commit", {
                space_id: space, fingerprint: file!.fp, file_name: file!.name,
                rows: pv.filter((r) => r.status === "READY" || r.status === "SIMILAR" || r.status === "BLOCKED").map((r) => ({
                  row_no: r.rowNo, external_id: r.externalId, date: r.date, account_id: r.accountId, to_account_id: r.toAccountId, direction: r.direction,
                  amount: r.amount?.toString(), kind: r.kind, effect: effectForKind(r.kind), counterparty_id: r.counterpartyId, project_id: r.projectId,
                  category: r.category, description: r.description, decision: r.status === "BLOCKED" ? "IMPORT" : r.decision, raw: r.raw,
                })),
              }, key), "Импорт сохранён").then(setResult).catch(() => {})}>Сохранить выбранные строки</Btn>
            </div>
          </>
        )}
        {result && (
          <div class="a-block">
            {result.duplicate_file ? <p><Badge kind="muted">Этот файл уже импортирован</Badge> Новых операций нет.</p> : <p><Badge kind="ok">Проведено: {result.imported}</Badge> {Object.entries(result.counts ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ")}</p>}
            <p class="fine">После импорта сверь остатки счетов — «Счета и операции → Сверить».</p>
            <Btn onClick={() => { setRows([]); setPv(null); setResult(null); setFile(null); }}>Ещё файл</Btn>
          </div>
        )}
      </Card>

      {conflicts.length > 0 && (
        <Card title="Строки импорта, ждущие решения" className="card-bad">
          <p class="fine">Пока они не разобраны, доступная сумма не рассчитывается: они могут изменить расчёт.</p>
          <ul class="rows">
            {conflicts.map((c) => (
              <li key={c.id} class="row">
                <span class="grow">{c.raw?.date} · {c.raw?.description} · {c.raw?.amount_rub} ₽<small>{c.message}</small></span>
                <span class="row-actions">
                  <Btn small onClick={() => {
                    const acc = s.accounts.find((a) => a.name.toLowerCase() === String(c.raw?.account ?? "").toLowerCase() && a.spaceId === c.space_id);
                    const amt = parseRub(String(c.raw?.amount_rub ?? ""));
                    if (!acc || !amt) return;
                    const out = String(c.raw?.direction).toUpperCase() === "OUT";
                    void mutate(() => api.rpc("cfo_import_resolve", { space_id: c.space_id, row_id: c.id, decision: "IMPORT", transaction: {
                      kind: out ? "EXPENSE" : "INCOME", effect: "NONE", occurred_on: c.raw.date, description: c.raw.description ?? "",
                      entries: [{ account_id: acc.id, amount: (out ? -amt : amt).toString() }] } }), "Проведено").catch(() => {});
                  }}>Провести</Btn>
                  <Btn small onClick={() => void mutate(() => api.rpc("cfo_import_resolve", { space_id: c.space_id, row_id: c.id, decision: "SKIP" }), "Пропущено").catch(() => {})}>Это повтор</Btn>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Выгрузка">
        <p class="fine">CSV — для Excel (формулы в тексте экранируются). JSON — все твои финансовые сущности для переноса и резервной копии; секретов и данных входа в выгрузке нет.</p>
        <div class="actions-row">
          <Btn onClick={exportOps}>Операции CSV</Btn>
          <Btn onClick={exportPlans}>Платежи CSV</Btn>
          <Btn kind="primary" onClick={() => download(`pocket-cfo-${s.asOf}.json`, JSON.stringify({ exported_at: new Date().toISOString(), app: "pocket-cfo", data: app.raw }, null, 2), "application/json")}>Всё в JSON</Btn>
        </div>
      </Card>
    </div>
  );
}

/* ---------- Журнал изменений ---------- */
export function Journal() {
  const app = useApp();
  const [space, setSpace] = useState<UUID>(app.mode === "PERSONAL" ? app.personalId! : app.businessId ?? app.personalId!);
  const [events, setEvents] = useState<any[] | null>(null);
  useEffect(() => { if (!app.demo) api.audit(space, null, 300).then(setEvents).catch(() => setEvents([])); else setEvents([]); }, [space, app.loadedAt]);
  return (
    <div class="screen">
      <div class="crumbs"><a href="#more">Ещё</a> / Журнал изменений</div>
      {app.businessId && app.personalId && <Seg value={space} onChange={setSpace} options={[[app.businessId, "Продакшн"], [app.personalId, "Я"]]} />}
      <Card title="Последние изменения">{events === null ? <p>Загружаю…</p> : events.length ? <History events={events} /> : <Empty text={app.demo ? "В демо журнал не ведётся." : "Изменений пока нет."} />}</Card>
      <p class="fine">История неизменяема: её нельзя отредактировать или удалить.</p>
    </div>
  );
}

/* ---------- Настройки ---------- */
export function Settings({ params }: { params: URLSearchParams }) {
  const app = useApp();
  const s = app.s!;
  const [spaceId, setSpaceId] = useState<UUID>(params.get("space") ?? app.businessId ?? app.personalId!);
  const sp = s.spaces.find((x) => x.id === spaceId)!;
  return (
    <div class="screen">
      <div class="crumbs"><a href="#more">Ещё</a> / Настройки</div>
      {app.businessId && app.personalId && <Seg value={spaceId} onChange={setSpaceId} options={[[app.businessId, "Продакшн"], [app.personalId, "Я"]]} />}
      <SpaceSettings key={sp.id + sp.dataVersion} sp={sp} />
      {sp.type === "BUSINESS" && <Directory spaceId={sp.id} />}
      <Card title="Полнота данных">
        {(() => {
          const sum = app.summary!.spaces.find((x) => x.space.id === sp.id)!;
          return sum.stress.quality.issues.length
            ? <ul class="issues">{sum.stress.quality.issues.map((i) => <li key={i.code}><Badge kind={i.severity === "BLOCKING" ? "bad" : "warn"}>{i.severity === "BLOCKING" ? "Не хватает" : "Уточнить"}</Badge> {i.message}</li>)}</ul>
            : <p><Badge kind="ok">Данных достаточно для расчёта</Badge> Это настройка полноты ввода, а не подтверждение правильности налогового режима.</p>;
        })()}
      </Card>
      <Card title="Принятые допущения">
        <KV rows={[
          ["Горизонт главного прогноза", "сегодня + 90 дней (13 недель)"], ["Стресс-сценарий", `задержка ещё не полученных клиентских платежей на ${sp.stressDelayDays} дн.`],
          ["Валюта", "RUB, суммы — целые копейки"], ["Часовой пояс", sp.timezone], ["Налоги", "только внесённые суммы; ставки не подставляются"],
          ["Доли партнёров", "задаются вручную; равные не подставляются"], ["Проведение платежей", "вне приложения; здесь — план и факт"],
        ]} />
      </Card>
    </div>
  );
}

function SpaceSettings({ sp }: { sp: Space }) {
  const [minBal, setMinBal] = useState(sp.minBalance === null ? "" : formatAmountInput(sp.minBalance));
  const [tax, setTax] = useState(sp.taxStatus);
  const [taxUntil, setTaxUntil] = useState(sp.taxHorizonUntil ?? "");
  const [taxNote, setTaxNote] = useState(sp.taxNote);
  const [stress, setStress] = useState(String(sp.stressDelayDays));
  const [stale, setStale] = useState(String(sp.reconcileStaleDays));
  const [tz, setTz] = useState(sp.timezone);
  const [minimum, setMinimum] = useState(sp.monthlyMinimum === null ? "" : formatAmountInput(sp.monthlyMinimum));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setErr("");
    try {
      const patch: Record<string, unknown> = {
        min_balance: minBal.trim() === "" ? null : money(minBal, { allowZero: true }).toString(), tax_status: tax, tax_horizon_until: taxUntil || null, tax_note: taxNote,
        stress_delay_days: Number(stress) || 0, reconcile_stale_days: Number(stale) || 7, timezone: tz,
      };
      if (sp.type === "PERSONAL") patch.monthly_minimum = minimum.trim() === "" ? null : money(minimum, { allowZero: true }).toString();
      if (tax === "ENTERED" && !taxUntil) throw new FormError("Укажи, до какой даты внесены налоговые суммы (или явный ноль с основанием)");
      setBusy(true);
      await mutate(() => api.update("cfo_spaces", sp.id, act.versionOf("spaces", sp.id), patch), "Настройки сохранены");
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Card title={sp.type === "BUSINESS" ? "Продакшн" : "Личные деньги"}>
      <div class="two">
        <Field label="Минимальный неснижаемый остаток" hint="Пусто — не задан: доступная сумма не рассчитывается. 0 — осознанно без минимума.">
          <MoneyInput value={minBal} onInput={setMinBal} />
        </Field>
        {sp.type === "PERSONAL" && <Field label="Обязательный месячный минимум" hint="Для подушки в месяцах. Если подушка защищена целью — не повторяй её в минимальном остатке."><MoneyInput value={minimum} onInput={setMinimum} /></Field>}
      </div>
      <div class="two">
        <Field label="Налоги"><Select value={tax} onChange={(v) => setTax((v || "NOT_SET") as any)} options={Object.entries(TAX_STATUS) as any} /></Field>
        <Field label="Суммы внесены до"><input type="date" value={taxUntil} onInput={(e) => setTaxUntil((e.target as HTMLInputElement).value)} /></Field>
      </div>
      <Field label="Основание / комментарий" hint="Налоговые суммы заводи платёжными планами с эффектом «Налог». Явный ноль — с основанием."><input value={taxNote} onInput={(e) => setTaxNote((e.target as HTMLInputElement).value)} /></Field>
      <div class="two">
        <Field label="Стресс: задержка клиентов, дней"><input type="number" min="0" max="365" value={stress} onInput={(e) => setStress((e.target as HTMLInputElement).value)} /></Field>
        <Field label="Сверка устаревает через, дней"><input type="number" min="1" max="365" value={stale} onInput={(e) => setStale((e.target as HTMLInputElement).value)} /></Field>
      </div>
      <Field label="Часовой пояс"><input value={tz} onInput={(e) => setTz((e.target as HTMLInputElement).value)} /></Field>
      {err && <p class="f-e">{err}</p>}
      <div class="actions-row"><Btn kind="primary" busy={busy} onClick={save}>Сохранить</Btn></div>
    </Card>
  );
}

function Directory({ spaceId }: { spaceId: UUID }) {
  const app = useApp();
  const s = app.s!;
  const [name, setName] = useState("");
  const [type, setType] = useState("CLIENT");
  const [dir, setDir] = useState("");
  const overheadLines = s.budgetLines.filter((l) => l.spaceId === spaceId && l.projectId === null);
  return (
    <>
      <Card title="Контрагенты и партнёры">
        <ul class="rows">{s.counterparties.filter((c) => c.spaceId === spaceId).map((c) => <li key={c.id} class="row"><span class="grow">{c.name}<small>{c.types.map((t) => ({ CLIENT: "клиент", CONTRACTOR: "подрядчик", PARTNER: "партнёр", OTHER: "другое" }[t])).join(", ")}{c.isSelf ? " · это ты" : ""}</small></span></li>)}</ul>
        <div class="two">
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Название / имя" aria-label="Новый контрагент" />
          <Select value={type} onChange={(v) => setType(v || "CLIENT")} options={[["CLIENT", "Клиент"], ["CONTRACTOR", "Подрядчик"], ["PARTNER", "Партнёр"], ["OTHER", "Другое"]]} />
        </div>
        <Btn small onClick={() => name.trim() && mutate(() => api.insert("cfo_counterparties", { space_id: spaceId, name: name.trim(), types: [type], sort_order: 10 }), "Добавлено").then(() => setName("")).catch(() => {})}>+ Добавить</Btn>
      </Card>
      <Card title="Направления">
        <ul class="rows">{s.directions.filter((d) => d.spaceId === spaceId).map((d) => <li key={d.id} class="row"><span class="grow">{d.name}</span></li>)}</ul>
        <div class="two">
          <input value={dir} onInput={(e) => setDir((e.target as HTMLInputElement).value)} placeholder="Новое направление" aria-label="Новое направление" />
          <Btn small onClick={() => dir.trim() && mutate(() => api.insert("cfo_directions", { space_id: spaceId, name: dir.trim(), kind: "OTHER" }), "Добавлено").then(() => setDir("")).catch(() => {})}>+ Добавить</Btn>
        </div>
      </Card>
      <Card title="Общие расходы компании" actions={<Btn small onClick={() => openSheet("budget-line", { projectId: null })}>+ Статья</Btn>}>
        {overheadLines.length ? <ul class="rows">{overheadLines.map((l) => (
          <li key={l.id} class="row"><span class="grow">{l.category}</span><Money v={l.originalMgmt} /><Btn small kind="link" onClick={() => openSheet("overhead", { lineId: l.id })}>Распределить</Btn></li>
        ))}</ul> : <p class="fine">Статей нет. Постоянные расходы (аренда, сервисы, бухгалтер) заведи регулярными платежами — тогда они попадут в прогноз.</p>}
      </Card>
    </>
  );
}

/* ---------- Первая настройка ---------- */
const STEPS = [
  ["spaces", "Пространства и допущения"],
  ["accounts", "Счета и сверенные остатки"],
  ["fixed", "Личный минимум и постоянные расходы"],
  ["projects", "Активные проекты и остаточные затраты"],
  ["expected", "Ожидаемые поступления, долги, налоги"],
  ["protect", "Защищённые суммы"],
  ["done", "Первая сводка"],
] as const;

export function Onboarding() {
  const app = useApp();
  const s = app.s!;
  const biz = s.spaces.find((x) => x.type === "BUSINESS");
  const me = s.spaces.find((x) => x.type === "PERSONAL");
  const saved = (biz?.id && (app.raw?.spaces.find((x: any) => x.id === biz.id)?.onboarding?.step as number)) || 0;
  const [step, setStep] = useState<number>(saved);
  const go = (n: number) => {
    setStep(n);
    if (biz && !app.demo) void api.update("cfo_spaces", biz.id, null, { onboarding: { step: n } }).catch(() => {});
    window.scrollTo({ top: 0 });
  };
  const ix = indexSnapshot(s);
  const done: boolean[] = [
    true,
    s.accounts.some((a) => a.spaceId === biz?.id) && s.accounts.some((a) => a.spaceId === me?.id),
    (me?.monthlyMinimum ?? null) !== null && s.recurrences.some((r) => r.spaceId === biz?.id),
    s.projects.some((p) => p.spaceId === biz?.id),
    biz?.taxStatus === "ENTERED" && me?.taxStatus === "ENTERED" && s.plans.some((p) => p.direction === "IN" && planRemaining(ix, p) > 0n),
    (biz?.minBalance ?? null) !== null && (me?.minBalance ?? null) !== null,
    true,
  ];
  const progress = done.slice(1, 6).filter(Boolean).length;
  return (
    <div class="screen">
      <div class="crumbs"><a href="#more">Ещё</a> / Первая настройка</div>
      <div class="steps">
        {STEPS.map(([k, t], i) => (
          <button type="button" key={k} class={`step ${i === step ? "cur" : ""} ${done[i] && i > 0 && i < 6 ? "ok" : ""}`} onClick={() => go(i)}>
            <span>{done[i] && i > 0 && i < 6 ? "✓" : i + 1}</span>{t}
          </button>
        ))}
      </div>
      <p class="fine">Заполнено {progress} из 5 разделов. Каждый шаг сохраняется; пропущенные данные остаются неизвестными — это не ноль. Демо-значения в рабочие данные не подставляются.</p>

      {step === 0 && (
        <Card title="Пространства и допущения">
          <p>Созданы два раздельных пространства: <b>«Я»</b> — личные деньги и <b>«Продакшн»</b> — KINOMARK. Доступные деньги бизнеса никогда не показываются как личный бюджет. Партнёры Никита и Сергей и направления (кино и сериалы, вертикальные сериалы, ИИ-продакшн) уже добавлены — без долей и сумм.</p>
          <KV rows={[
            ["Формат", "веб-приложение, основной экран — телефон"], ["Язык и валюта", "русский, рубли"], ["Часовой пояс", "Europe/Moscow — меняется в настройках"],
            ["Горизонт прогноза", "сегодня + 90 дней, 13 недель"], ["Стресс-сценарий", "задержка клиентских оплат на 14 дней — меняется"],
            ["Налоги", "только внесённые суммы и сроки; ставки не подставляются"], ["Доли партнёров", "только согласованные тобой"],
            ["Источники данных", "ручной ввод, помощник, CSV"], ["Платежи", "проводятся в банке; здесь — план и факт"],
          ]} />
          <Btn kind="primary" onClick={() => go(1)}>Дальше: счета</Btn>
        </Card>
      )}
      {step === 1 && (
        <Card title="Счета и сверенные остатки">
          <p class="fine">Добавь все счета, карты и наличные в обоих пространствах с остатком на сегодня, сверенным с банком.</p>
          {[biz, me].filter(Boolean).map((sp) => (
            <div key={sp!.id} class="a-block">
              <b>{sp!.type === "BUSINESS" ? "Продакшн" : "Я"}</b>
              <ul class="rows">{s.accounts.filter((a) => a.spaceId === sp!.id).map((a) => <li key={a.id} class="row"><span class="grow">{a.name}<small>на <D d={a.openingDate} /></small></span><Money v={a.openingBalance} /></li>)}</ul>
              <Btn small onClick={() => openSheet("account", { spaceId: sp!.id })}>+ Счёт</Btn>
            </div>
          ))}
          <Nav go={go} step={step} />
        </Card>
      )}
      {step === 2 && (
        <Card title="Личный минимум и постоянные расходы компании">
          <p class="fine">Личный обязательный месячный минимум нужен для подушки в месяцах; сам минимум задаётся в настройках. Постоянные расходы компании (аренда, сервисы, бухгалтер, зарплаты) — регулярными платежами: каждое вхождение попадёт в прогноз.</p>
          <div class="actions-row">
            <Btn onClick={() => navigate(`settings?space=${me?.id}`)}>Личный минимум</Btn>
            <Btn onClick={() => openSheet("budget", { spaceId: me!.id })}>Личный бюджет</Btn>
            <Btn kind="primary" onClick={() => openSheet("plan-new", { spaceId: biz!.id, direction: "OUT" })}>+ Постоянный расход компании</Btn>
            <Btn onClick={() => openSheet("plan-new", { spaceId: me!.id, direction: "OUT" })}>+ Обязательный личный платёж</Btn>
          </div>
          <ul class="rows">{s.recurrences.map((r) => <li key={r.id} class="row"><span class="grow">{r.template.title}<small>{s.spaces.find((x) => x.id === r.spaceId)?.type === "BUSINESS" ? "продакшн" : "личное"} · с <D d={r.startDate} /></small></span><Money v={-r.template.amount} /></li>)}</ul>
          <Nav go={go} step={step} />
        </Card>
      )}
      {step === 3 && (
        <Card title="Активные проекты и остаточные затраты">
          <p class="fine">Для каждого проекта: модель (заказной / собственный), стадия и окончание, смета и даты неоплаченных затрат. У затрат без даты прогноз будет неполным.</p>
          <ul class="rows">{s.projects.map((p) => <li key={p.id} class="row click" onClick={() => navigate(`project/${p.id}?tab=budget`)}><span class="grow">{p.name}<small>{p.endDate ? <>до <D d={p.endDate} /></> : "без даты окончания"}</small></span></li>)}</ul>
          <Btn kind="primary" onClick={() => openSheet("project", {})}>+ Проект</Btn>
          <Nav go={go} step={step} />
        </Card>
      )}
      {step === 4 && (
        <Card title="Ожидаемые поступления, долги и налоги">
          <p class="fine">Поступления по договорам — «По договору»; неподписанные — «Предварительно». Налоги — платёжными планами с эффектом «Налог», затем отметь в настройках, до какой даты они внесены. Отсутствие налогового плана ≠ 0 ₽.</p>
          <div class="actions-row">
            <Btn kind="primary" onClick={() => openSheet("plan-new", { spaceId: biz!.id, direction: "IN" })}>+ Ожидаемое поступление</Btn>
            <Btn onClick={() => openSheet("plan-new", { spaceId: biz!.id, direction: "OUT" })}>+ Налог или долг</Btn>
            <Btn onClick={() => openSheet("loan", {})}>+ Заём</Btn>
            <Btn onClick={() => navigate("settings")}>Статус налогов</Btn>
          </div>
          <Nav go={go} step={step} />
        </Card>
      )}
      {step === 5 && (
        <Card title="Защищённые суммы">
          <p class="fine">Минимальный неснижаемый остаток — порог в каждом пространстве (0 — осознанно без него). Резервы — под налоги, команду, подушку. Одна сумма защищается одним способом: если подушка — цель с резервом, не повторяй её в минимуме. Сейчас R + B:</p>
          {[biz, me].filter(Boolean).map((sp) => {
            const sm = app.summary!.spaces.find((x) => x.space.id === sp!.id)!;
            return <p key={sp!.id}><b>{sp!.type === "BUSINESS" ? "Продакшн" : "Я"}:</b> резервы <Money v={sm.reserved} /> + минимум <Money v={sm.minBalance} unknownText="не задан" /> {sm.minBalance !== null && <>= <Money v={sm.reserved + sm.minBalance} /></>}</p>;
          })}
          <div class="actions-row">
            <Btn onClick={() => navigate(`settings?space=${biz?.id}`)}>Минимум продакшна</Btn>
            <Btn onClick={() => navigate(`settings?space=${me?.id}`)}>Мой минимум</Btn>
            <Btn kind="primary" onClick={() => openSheet("reserve", {})}>+ Резерв</Btn>
          </div>
          <Nav go={go} step={step} />
        </Card>
      )}
      {step === 6 && (
        <Card title="Первая сводка">
          {app.summary!.spaces.map((sp) => (
            <p key={sp.space.id}><b>{sp.space.type === "BUSINESS" ? "Продакшн" : "Я"}:</b> доступно <Money v={sp.stress.limit} unknownText="недостаточно данных" /> · {sp.stress.quality.issues.length ? sp.stress.quality.issues.map((i) => i.message).join("; ") : "данных достаточно"}</p>
          ))}
          <Btn kind="primary" onClick={() => navigate("today")}>Открыть «Сегодня»</Btn>
        </Card>
      )}
    </div>
  );
}

function Nav({ go, step }: { go: (n: number) => void; step: number }) {
  return (
    <div class="actions-row">
      <Btn onClick={() => go(step - 1)}>Назад</Btn>
      <Btn kind="link" onClick={() => go(step + 1)}>Пропустить — заполню позже</Btn>
      <Btn kind="primary" onClick={() => go(step + 1)}>Дальше</Btn>
    </div>
  );
}

/* ---------- Вход ---------- */
export function SignIn({ notAllowed }: { notAllowed?: boolean }) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div class="signin">
      <form class="sheet" onSubmit={async (e) => {
        e.preventDefault();
        setErr("");
        setBusy(true);
        try { await api.signIn(email.trim(), pass); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
      }}>
        <div class="brand"><div class="logo">M</div><div><h1>Mark Finance</h1><p>Карманный финансовый директор</p></div></div>
        {notAllowed ? (
          <p class="warn-line">Этот аккаунт не подключён к финансовому директору. Доступ выдаётся настройкой развёртывания (таблица cfo_allowed_users).</p>
        ) : <p class="fine">Вход тем же аккаунтом, что и в планировщике MARK. Регистрации здесь нет — приложение закрыто.</p>}
        <Field label="Почта"><input type="email" autoComplete="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} /></Field>
        <Field label="Пароль"><input type="password" autoComplete="current-password" value={pass} onInput={(e) => setPass((e.target as HTMLInputElement).value)} /></Field>
        {err && <p class="f-e">{err}</p>}
        <Btn kind="primary" type="submit" busy={busy}>Войти</Btn>
        <Btn kind="link" onClick={() => { set({ demo: true }); applyRaw(demoSnapshot()); }}>Посмотреть демо (вымышленные данные, без сохранения)</Btn>
      </form>
    </div>
  );
}

