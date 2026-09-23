// Общие компоненты интерфейса.
import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import { formatDate, todayIn, type ISODate } from "../../shared/dates";
import { formatRub, parseRub, type Minor } from "../../shared/money";
import type { QualityStatus } from "../../modules/forecasting/forecast";
import { QUALITY_TEXT } from "../../modules/recommendations/summary";
import { closeSheet, get } from "../store";

export const today = () => get().s?.asOf ?? todayIn();

export function Money({ v, sign, className, unknownText }: { v: Minor | null | undefined; sign?: boolean; className?: string; unknownText?: string }) {
  if (v === null || v === undefined) return <span class={`money unknown ${className ?? ""}`}>{unknownText ?? "нет данных"}</span>;
  const cls = v < 0n ? "neg" : sign && v > 0n ? "pos" : "";
  return <span class={`money ${cls} ${className ?? ""}`}>{formatRub(v, { sign })}</span>;
}

export const D = ({ d }: { d: ISODate | null | undefined }) => <span class="date">{formatDate(d, today())}</span>;

export function Quality({ status, compact }: { status: QualityStatus; compact?: boolean }) {
  const icon = status === "COMPLETE" ? "●" : status === "PRELIMINARY" ? "◐" : "○";
  return <span class={`quality q-${status}`} title={QUALITY_TEXT[status]}>{icon} {compact ? "" : QUALITY_TEXT[status]}</span>;
}

export function Badge({ kind, children }: { kind: "ok" | "warn" | "bad" | "info" | "muted"; children: ComponentChildren }) {
  const icon = { ok: "✓", warn: "!", bad: "▲", info: "i", muted: "·" }[kind];
  return <span class={`badge b-${kind}`}><i aria-hidden="true">{icon}</i>{children}</span>;
}

export function Card({ title, children, actions, className, id }: { title?: ComponentChildren; children: ComponentChildren; actions?: ComponentChildren; className?: string; id?: string }) {
  return (
    <section class={`card ${className ?? ""}`} id={id}>
      {(title || actions) && (
        <header class="card-h">
          {title && <h2>{title}</h2>}
          {actions && <div class="card-a">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ text, action }: { text: string; action?: ComponentChildren }) {
  return (
    <div class="empty">
      <p>{text}</p>
      {action}
    </div>
  );
}

export function Btn(props: JSX.HTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "ghost" | "danger" | "link"; small?: boolean; busy?: boolean; type?: "button" | "submit" }) {
  const { kind, small, busy, children, class: cls, ...rest } = props as any;
  return (
    <button type="button" {...rest} disabled={busy || rest.disabled} class={`btn ${kind ? "btn-" + kind : ""} ${small ? "btn-s" : ""} ${cls ?? ""}`}>
      {busy ? "Сохраняю…" : children}
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label?: string }) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map(([v, t]) => (
        <button type="button" aria-pressed={v === value} onClick={() => onChange(v)} key={v}>{t}</button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: string; children: ComponentChildren; error?: string | null }) {
  return (
    <label class="field">
      <span class="f-l">{label}</span>
      {children}
      {hint && !error && <span class="f-h">{hint}</span>}
      {error && <span class="f-e">{error}</span>}
    </label>
  );
}

export function MoneyInput({ value, onInput, id, placeholder, allowNegative }: { value: string; onInput: (v: string) => void; id?: string; placeholder?: string; allowNegative?: boolean }) {
  const parsed = value.trim() ? parseRub(value) : null;
  const bad = value.trim() !== "" && (parsed === null || (!allowNegative && parsed < 0n));
  return (
    <div class="money-in">
      <input id={id} inputMode="decimal" autoComplete="off" value={value} placeholder={placeholder ?? "0"} aria-invalid={bad}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)} />
      <span class="suffix">₽</span>
      {parsed !== null && !bad && value.trim() && <span class="f-h">{formatRub(parsed)}</span>}
      {bad && <span class="f-e">Введи сумму, например 45 000 или 1234,50</span>}
    </div>
  );
}

/** Строка суммы → копейки; ошибка — понятный текст. */
export function money(v: string, { allowZero = false, allowNegative = false } = {}): Minor {
  const p = parseRub(v);
  if (p === null) throw new FormError("Сумма указана неверно");
  if (!allowNegative && p < 0n) throw new FormError("Сумма не может быть отрицательной");
  if (!allowZero && p === 0n) throw new FormError("Сумма должна быть больше нуля");
  return p;
}

export class FormError extends Error {}

export function Select<T extends string>({ value, onChange, options, empty, id }: { value: T | ""; onChange: (v: T | "") => void; options: [T, string][]; empty?: string; id?: string }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value as T | "")}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map(([v, t]) => <option value={v} key={v}>{t}</option>)}
    </select>
  );
}

/** Модальная панель; на телефоне — снизу. Ошибка сохранения остаётся в форме. */
export function SheetFrame({ title, children, onSubmit, submitText, danger, wide }: {
  title: string; children: ComponentChildren; onSubmit?: () => Promise<unknown> | unknown; submitText?: string; danger?: boolean; wide?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (!onSubmit || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await onSubmit();
      if (r !== false) closeSheet();
    } catch (x: any) {
      setErr(x instanceof FormError ? x.message : x?.message ?? "Не удалось сохранить — запись не создана");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="sheet-bg" onClick={(e) => e.target === e.currentTarget && closeSheet()}>
      <form class={`sheet ${wide ? "sheet-wide" : ""}`} onSubmit={submit} role="dialog" aria-modal="true" aria-label={title}>
        <header class="sheet-h">
          <h2>{title}</h2>
          <button type="button" class="x" aria-label="Закрыть" onClick={closeSheet}>✕</button>
        </header>
        <div class="sheet-b">{children}</div>
        {err && <div class="form-err" role="alert">{err}</div>}
        {onSubmit && (
          <footer class="sheet-f">
            <Btn onClick={closeSheet}>Отмена</Btn>
            <Btn kind={danger ? "danger" : "primary"} type="submit" busy={busy} onClick={submit as any}>{submitText ?? "Сохранить"}</Btn>
          </footer>
        )}
      </form>
    </div>
  );
}

export function KV({ rows }: { rows: [ComponentChildren, ComponentChildren][] }) {
  return (
    <dl class="kv">
      {rows.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
