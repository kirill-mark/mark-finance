// Нормализованный снимок данных — вход расчётного модуля.
// Суммы — bigint копеек; даты — "ГГГГ-ММ-ДД" в часовом поясе пространства.
import type { Minor } from "./money";
import type { ISODate } from "./dates";

export type UUID = string;
export type SpaceType = "PERSONAL" | "BUSINESS";
export type TaxStatus = "NOT_SET" | "PENDING" | "ENTERED";

export interface Space {
  id: UUID;
  type: SpaceType;
  name: string;
  timezone: string;
  /** Минимальный неснижаемый остаток B; null — не задан (неполнота данных). */
  minBalance: Minor | null;
  taxStatus: TaxStatus;
  /** До какой даты внесены налоговые суммы (или явный ноль с основанием). */
  taxHorizonUntil: ISODate | null;
  taxNote: string;
  stressDelayDays: number;
  reconcileStaleDays: number;
  /** Личный обязательный месячный минимум — для подушки в месяцах (F10). */
  monthlyMinimum: Minor | null;
  dataVersion: number;
}

export type AccountType = "BANK" | "CARD" | "CASH" | "SAVINGS" | "OTHER";
export interface Account {
  id: UUID;
  spaceId: UUID;
  name: string;
  type: AccountType;
  openingBalance: Minor;
  /** Точка открытия: движения раньше этой даты в остаток не входят (F02). */
  openingDate: ISODate;
  reconciledAt: ISODate | null;
  archived: boolean;
}

export type CounterpartyType = "CLIENT" | "CONTRACTOR" | "PARTNER" | "OTHER";
export interface Counterparty {
  id: UUID;
  spaceId: UUID;
  name: string;
  types: CounterpartyType[];
  /** Сам пользователь как партнёр компании (Кирилл). */
  isSelf: boolean;
  sortOrder: number;
}

export interface Direction {
  id: UUID;
  spaceId: UUID;
  name: string;
  kind: "FILM" | "VERTICAL" | "AI" | "OTHER";
}

export type ProjectModel = "SERVICE" | "OWN_IP" | "EXPERIMENT";
export type ProjectStage = "IDEA" | "DEVELOPMENT" | "PREPRODUCTION" | "SHOOTING" | "POSTPRODUCTION" | "RELEASE" | "DONE" | "CANCELLED";
export interface Project {
  id: UUID;
  spaceId: UUID;
  name: string;
  directionId: UUID | null;
  model: ProjectModel;
  stage: ProjectStage;
  clientId: UUID | null;
  startDate: ISODate | null;
  endDate: ISODate | null;
  /** Утверждённый план: выплаты проекта участвуют в прогнозе. Черновые идеи — нет. */
  inForecast: boolean;
  /** Поля направления: серии, смены, принятые минуты и т.п. */
  metrics: {
    episodes?: number;
    plannedShifts?: number;
    actualShifts?: number;
    revisionRounds?: number;
    acceptedMinutes?: number;
    acceptedVideos?: number;
    aiKind?: "COMMERCIAL" | "EXPERIMENT" | "TRAINING";
  };
  notes: string;
}

export interface RevenueAgreement {
  id: UUID;
  projectId: UUID;
  clientId: UUID | null;
  amount: Minor;
  mgmtAmount: Minor;
  status: "DRAFT" | "SIGNED" | "CANCELLED";
  reference: string;
  isExtraWork: boolean;
}

export type FundingKind = "OWN_FUNDS" | "INVESTOR" | "LOAN" | "PRESALE" | "GRANT" | "OTHER";
export interface FundingSource {
  id: UUID;
  projectId: UUID;
  kind: FundingKind;
  name: string;
  declared: Minor;
  confirmed: Minor;
  status: "DECLARED" | "CONFIRMED" | "CANCELLED";
  terms: string;
  /** Выделение уже имеющихся денег компании: меняет назначение, не создаёт поступления (T33). */
  isReallocation: boolean;
}

export type CostStage = "PREPRODUCTION" | "SHOOTING" | "POSTPRODUCTION" | "SERVICES" | "TEAM" | "OTHER";
export interface BudgetLine {
  id: UUID;
  spaceId: UUID;
  /** null — общие расходы компании. */
  projectId: UUID | null;
  category: string;
  stage: CostStage;
  originalAmount: Minor;
  originalMgmt: Minor;
  note: string;
}

export type Direction2 = "IN" | "OUT";
export type Certainty = "CONTRACTED" | "ESTIMATE" | "PIPELINE";
export type EconomicEffect =
  | "PROJECT_COST" | "OVERHEAD_COST" | "SALES" | "FINANCING" | "REIMBURSEMENT"
  | "PROFIT_DISTRIBUTION" | "PERSONAL_CONSUMPTION" | "PERSONAL_INCOME" | "TAX" | "INTERNAL_TRANSFER" | "NONE";

export interface PaymentPlan {
  id: UUID;
  spaceId: UUID;
  direction: Direction2;
  amount: Minor;
  mgmtAmount: Minor | null;
  /** Исходный (договорный) срок; null допустим только для оценки затрат без даты. */
  dueDate: ISODate | null;
  /** Текущая ожидаемая дата; не скрывает просрочку по исходному сроку. */
  expectedDate: ISODate | null;
  /** "ЧЧ:ММ" — порядок внутри дня; без времени выплаты раньше поступлений. */
  expectedTime: string | null;
  counterpartyId: UUID | null;
  certainty: Certainty;
  effect: EconomicEffect;
  title: string;
  basis: string;
  projectId: UUID | null;
  budgetLineId: UUID | null;
  fundingSourceId: UUID | null;
  partnerClaimId: UUID | null;
  loanId: UUID | null;
  /** Личная категория (для бюджета) — только личное пространство. */
  category: string | null;
  inForecast: boolean;
  cancelledAt: ISODate | null;
  cancelReason: string;
  recurrenceRuleId: UUID | null;
  occurrenceDate: ISODate | null;
  /** Зеркальный план в другом пространстве (выплата себе ↔ личное поступление). */
  linkedPlanId: UUID | null;
  createdAt: string;
}

export type RecurrenceFreq = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";
export interface RecurrenceRule {
  id: UUID;
  spaceId: UUID;
  freq: RecurrenceFreq;
  /** День месяца (1–31) для месячных; для недельных — день недели 0–6. */
  day: number;
  startDate: ISODate;
  endDate: ISODate | null;
  template: Omit<PaymentPlan, "id" | "spaceId" | "dueDate" | "expectedDate" | "recurrenceRuleId" | "occurrenceDate" | "cancelledAt" | "cancelReason" | "linkedPlanId" | "createdAt">;
  active: boolean;
}

export type TxKind =
  | "CLIENT_RECEIPT" | "INCOME" | "EXPENSE" | "TRANSFER" | "LOAN_IN" | "LOAN_REPAYMENT" | "INTEREST"
  | "PARTNER_PAYOUT" | "REIMBURSEMENT" | "OWNER_CONTRIBUTION" | "TAX" | "ADJUSTMENT" | "CROSS_SPACE";

export interface Transaction {
  id: UUID;
  spaceId: UUID;
  kind: TxKind;
  description: string;
  status: "POSTED" | "REVERSED";
  source: "MANUAL" | "IMPORT" | "ASSISTANT";
  occurredOn: ISODate;
  counterpartyId: UUID | null;
  projectId: UUID | null;
  category: string | null;
  effect: EconomicEffect;
  correctionOf: UUID | null;
  loanId: UUID | null;
  createdAt: string;
}

export interface AccountEntry {
  id: UUID;
  transactionId: UUID;
  accountId: UUID;
  amount: Minor; // знак: + поступление на счёт, − списание
  effectiveOn: ISODate;
}

export interface Settlement {
  id: UUID;
  transactionId: UUID;
  planId: UUID;
  amount: Minor;
  mgmtAmount: Minor;
  status: "ACTIVE" | "VOID";
}

export interface CostRecord {
  id: UUID;
  spaceId: UUID;
  budgetLineId: UUID | null;
  projectId: UUID | null;
  amount: Minor;
  mgmtAmount: Minor;
  /** null — оплатила компания; иначе контрагент-партнёр, оплативший за компанию. */
  paidByCounterpartyId: UUID | null;
  transactionId: UUID | null;
  planId: UUID | null;
  occurredOn: ISODate;
  status: "ACTIVE" | "VOID";
}

export interface Reserve {
  id: UUID;
  spaceId: UUID;
  purpose: string;
  kind: "PAYMENT_LINKED" | "GOAL";
  planId: UUID | null;
  goalId: UUID | null;
  createdAt: string;
  closed: boolean;
}

export interface ReserveEvent {
  id: UUID;
  reserveId: UUID;
  kind: "ALLOCATE" | "RELEASE" | "CONSUME";
  amount: Minor; // всегда положительная
  date: ISODate;
}

export interface ReserveSchedule {
  id: UUID;
  reserveId: UUID;
  date: ISODate;
  amount: Minor;
  status: "PLANNED" | "DONE" | "CANCELLED";
}

export interface Goal {
  id: UUID;
  spaceId: UUID;
  name: string;
  target: Minor;
  dueDate: ISODate | null;
  priority: number;
  kind: "EMERGENCY" | "OTHER";
}

export interface PersonalBudget {
  id: UUID;
  spaceId: UUID;
  /** "ГГГГ-ММ" или null — шаблон для всех месяцев. */
  month: string | null;
  category: string;
  limit: Minor;
  kind: "FIXED" | "VARIABLE";
  inMinimum: boolean;
}

export type ClaimBasis = "FEE" | "REIMBURSEMENT" | "LOAN" | "DISTRIBUTION";
export interface PartnerClaim {
  id: UUID;
  spaceId: UUID;
  counterpartyId: UUID;
  /** COMPANY_OWES — компания должна партнёру; PARTNER_OWES — партнёр компании. */
  direction: "COMPANY_OWES" | "PARTNER_OWES";
  basis: ClaimBasis;
  amount: Minor;
  approved: boolean;
  note: string;
  costRecordId: UUID | null;
  poolId: UUID | null;
  createdAt: string;
  cancelled: boolean;
}

export interface Loan {
  id: UUID;
  spaceId: UUID;
  lenderCounterpartyId: UUID | null;
  lenderName: string;
  contractAmount: Minor;
  note: string;
}

export interface DistributionPool {
  id: UUID;
  spaceId: UUID;
  period: string;
  projectId: UUID | null;
  amount: Minor;
  approvedOn: ISODate;
  recipients: { counterpartyId: UUID; shareBp: bigint | null; fixed: Minor | null; order: number }[];
}

export interface OverheadAllocation {
  id: UUID;
  budgetLineId: UUID;
  projectId: UUID;
  amount: Minor | null;
  shareBp: bigint | null;
}

export interface ImportConflict {
  id: UUID;
  spaceId: UUID;
  status: "OPEN" | "RESOLVED";
}

export interface Snapshot {
  asOf: ISODate;
  spaces: Space[];
  accounts: Account[];
  counterparties: Counterparty[];
  directions: Direction[];
  projects: Project[];
  revenueAgreements: RevenueAgreement[];
  fundingSources: FundingSource[];
  budgetLines: BudgetLine[];
  plans: PaymentPlan[];
  recurrences: RecurrenceRule[];
  transactions: Transaction[];
  entries: AccountEntry[];
  settlements: Settlement[];
  costRecords: CostRecord[];
  reserves: Reserve[];
  reserveEvents: ReserveEvent[];
  reserveSchedules: ReserveSchedule[];
  goals: Goal[];
  budgets: PersonalBudget[];
  claims: PartnerClaim[];
  loans: Loan[];
  pools: DistributionPool[];
  overheads: OverheadAllocation[];
  importConflicts: ImportConflict[];
}

export const emptySnapshot = (asOf: ISODate): Snapshot => ({
  asOf, spaces: [], accounts: [], counterparties: [], directions: [], projects: [], revenueAgreements: [],
  fundingSources: [], budgetLines: [], plans: [], recurrences: [], transactions: [], entries: [], settlements: [],
  costRecords: [], reserves: [], reserveEvents: [], reserveSchedules: [], goals: [], budgets: [], claims: [],
  loans: [], pools: [], overheads: [], importConflicts: [],
});
