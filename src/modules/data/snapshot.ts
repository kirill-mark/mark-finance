// Разбор снимка из базы (snake_case, суммы — строки копеек) в модель расчётного модуля.
import { fromMinorString as m } from "../../shared/money";
import type { ISODate } from "../../shared/dates";
import type { Snapshot } from "../../shared/types";

type Row = Record<string, any>;

const mn = (v: unknown) => (v === null || v === undefined ? null : m(v as string));
const d = (v: unknown): ISODate | null => (v ? String(v).slice(0, 10) : null);

export interface DbSnapshot {
  spaces: Row[]; accounts: Row[]; counterparties: Row[]; directions: Row[]; projects: Row[]; revenue_agreements: Row[];
  funding_sources: Row[]; budget_lines: Row[]; plans: Row[]; recurrences: Row[]; transactions: Row[]; entries: Row[];
  settlements: Row[]; cost_records: Row[]; reserves: Row[]; reserve_events: Row[]; reserve_schedules: Row[]; goals: Row[];
  budgets: Row[]; claims: Row[]; loans: Row[]; pools: Row[]; overheads: Row[]; import_conflicts: Row[];
  recommendation_states?: Row[]; reconciliations?: Row[]; forecast_history?: Row[];
}

export function parseTemplate(t: Row) {
  return {
    direction: t.direction, amount: m(t.amount), mgmtAmount: mn(t.mgmt_amount), expectedTime: t.expected_time ?? null,
    counterpartyId: t.counterparty_id ?? null, certainty: t.certainty ?? "CONTRACTED", effect: t.effect ?? "NONE", title: t.title ?? "",
    basis: t.basis ?? "", projectId: t.project_id ?? null, budgetLineId: t.budget_line_id ?? null, fundingSourceId: null,
    partnerClaimId: null, loanId: null, category: t.category ?? null, inForecast: t.in_forecast ?? true,
  };
}

export function fromDb(db: DbSnapshot, asOf: ISODate): Snapshot {
  return {
    asOf,
    spaces: db.spaces.map((r) => ({
      id: r.id, type: r.type, name: r.name, timezone: r.timezone, minBalance: mn(r.min_balance), taxStatus: r.tax_status,
      taxHorizonUntil: d(r.tax_horizon_until), taxNote: r.tax_note ?? "", stressDelayDays: r.stress_delay_days,
      reconcileStaleDays: r.reconcile_stale_days, monthlyMinimum: mn(r.monthly_minimum), dataVersion: Number(r.data_version ?? 0),
    })),
    accounts: db.accounts.map((r) => ({
      id: r.id, spaceId: r.space_id, name: r.name, type: r.type, openingBalance: m(r.opening_balance), openingDate: d(r.opening_date)!,
      reconciledAt: d(r.reconciled_at), archived: !!r.archived,
    })),
    counterparties: db.counterparties.map((r) => ({ id: r.id, spaceId: r.space_id, name: r.name, types: r.types ?? [], isSelf: !!r.is_self, sortOrder: r.sort_order ?? 0 })),
    directions: db.directions.map((r) => ({ id: r.id, spaceId: r.space_id, name: r.name, kind: r.kind })),
    projects: db.projects.map((r) => ({
      id: r.id, spaceId: r.space_id, name: r.name, directionId: r.direction_id, model: r.model, stage: r.stage, clientId: r.client_id,
      startDate: d(r.start_date), endDate: d(r.end_date), inForecast: !!r.in_forecast, metrics: r.metrics ?? {}, notes: r.notes ?? "",
    })),
    revenueAgreements: db.revenue_agreements.map((r) => ({
      id: r.id, projectId: r.project_id, clientId: r.client_id, amount: m(r.amount), mgmtAmount: m(r.mgmt_amount), status: r.status,
      reference: r.reference ?? "", isExtraWork: !!r.is_extra_work,
    })),
    fundingSources: db.funding_sources.map((r) => ({
      id: r.id, projectId: r.project_id, kind: r.kind, name: r.name ?? "", declared: m(r.declared), confirmed: m(r.confirmed), status: r.status,
      terms: r.terms ?? "", isReallocation: !!r.is_reallocation,
    })),
    budgetLines: db.budget_lines.map((r) => ({
      id: r.id, spaceId: r.space_id, projectId: r.project_id, category: r.category, stage: r.stage, originalAmount: m(r.original_amount),
      originalMgmt: m(r.original_mgmt), note: r.note ?? "",
    })),
    plans: db.plans.map((r) => ({
      id: r.id, spaceId: r.space_id, direction: r.direction, amount: m(r.amount), mgmtAmount: mn(r.mgmt_amount), dueDate: d(r.due_date),
      expectedDate: d(r.expected_date), expectedTime: r.expected_time ?? null, counterpartyId: r.counterparty_id, certainty: r.certainty,
      effect: r.effect, title: r.title ?? "", basis: r.basis ?? "", projectId: r.project_id, budgetLineId: r.budget_line_id,
      fundingSourceId: r.funding_source_id, partnerClaimId: r.partner_claim_id, loanId: r.loan_id, category: r.category ?? null,
      inForecast: !!r.in_forecast, cancelledAt: d(r.cancelled_at), cancelReason: r.cancel_reason ?? "", recurrenceRuleId: r.recurrence_rule_id,
      occurrenceDate: d(r.occurrence_date), linkedPlanId: r.linked_plan_id, createdAt: r.created_at,
    })),
    recurrences: db.recurrences.map((r) => ({
      id: r.id, spaceId: r.space_id, freq: r.freq, day: r.day, startDate: d(r.start_date)!, endDate: d(r.end_date), active: !!r.active,
      template: parseTemplate(r.template ?? {}),
    })),
    transactions: db.transactions.map((r) => ({
      id: r.id, spaceId: r.space_id, kind: r.kind, description: r.description ?? "", status: r.status, source: r.source,
      occurredOn: d(r.occurred_on)!, counterpartyId: r.counterparty_id, projectId: r.project_id, category: r.category ?? null,
      effect: r.effect, correctionOf: r.correction_of, loanId: r.loan_id, createdAt: r.created_at,
    })),
    entries: db.entries.map((r) => ({ id: r.id, transactionId: r.transaction_id, accountId: r.account_id, amount: m(r.amount), effectiveOn: d(r.effective_on)! })),
    settlements: db.settlements.map((r) => ({ id: r.id, transactionId: r.transaction_id, planId: r.plan_id, amount: m(r.amount), mgmtAmount: m(r.mgmt_amount), status: r.status })),
    costRecords: db.cost_records.map((r) => ({
      id: r.id, spaceId: r.space_id, budgetLineId: r.budget_line_id, projectId: r.project_id, amount: m(r.amount), mgmtAmount: m(r.mgmt_amount),
      paidByCounterpartyId: r.paid_by_counterparty_id, transactionId: r.transaction_id, planId: r.plan_id, occurredOn: d(r.occurred_on)!, status: r.status,
    })),
    reserves: db.reserves.map((r) => ({ id: r.id, spaceId: r.space_id, purpose: r.purpose, kind: r.kind, planId: r.plan_id, goalId: r.goal_id, createdAt: r.created_at, closed: !!r.closed })),
    reserveEvents: db.reserve_events.map((r) => ({ id: r.id, reserveId: r.reserve_id, kind: r.kind, amount: m(r.amount), date: d(r.date)! })),
    reserveSchedules: db.reserve_schedules.map((r) => ({ id: r.id, reserveId: r.reserve_id, date: d(r.date)!, amount: m(r.amount), status: r.status })),
    goals: db.goals.map((r) => ({ id: r.id, spaceId: r.space_id, name: r.name, target: m(r.target), dueDate: d(r.due_date), priority: r.priority ?? 0, kind: r.kind })),
    budgets: db.budgets.map((r) => ({ id: r.id, spaceId: r.space_id, month: r.month, category: r.category, limit: m(r.limit_amount), kind: r.kind, inMinimum: !!r.in_minimum })),
    claims: db.claims.map((r) => ({
      id: r.id, spaceId: r.space_id, counterpartyId: r.counterparty_id, direction: r.direction, basis: r.basis, amount: m(r.amount),
      approved: !!r.approved, note: r.note ?? "", costRecordId: r.cost_record_id, poolId: r.pool_id, createdAt: r.created_at, cancelled: !!r.cancelled,
    })),
    loans: db.loans.map((r) => ({ id: r.id, spaceId: r.space_id, lenderCounterpartyId: r.lender_counterparty_id, lenderName: r.lender_name ?? "", contractAmount: m(r.contract_amount), note: r.note ?? "" })),
    pools: db.pools.map((r) => ({
      id: r.id, spaceId: r.space_id, period: r.period ?? "", projectId: r.project_id, amount: m(r.amount), approvedOn: d(r.approved_on)!,
      recipients: (r.recipients ?? []).map((x: Row, i: number) => ({
        counterpartyId: x.counterparty_id, shareBp: x.share_bp === undefined || x.share_bp === null ? null : BigInt(x.share_bp),
        fixed: x.fixed === undefined || x.fixed === null ? null : m(x.fixed), order: i,
      })),
    })),
    overheads: db.overheads.map((r) => ({ id: r.id, budgetLineId: r.budget_line_id, projectId: r.project_id, amount: mn(r.amount), shareBp: r.share_bp === null || r.share_bp === undefined ? null : BigInt(r.share_bp) })),
    importConflicts: db.import_conflicts.map((r) => ({ id: r.id, spaceId: r.space_id, status: "OPEN" as const })),
  };
}
