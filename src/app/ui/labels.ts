// Подписи перечислений — финансовый смысл операции словами пользователя.
import type { EconomicEffect, TxKind } from "../../shared/types";

export const TX_KIND: Record<TxKind | "PAID_BY_PARTNER", string> = {
  CLIENT_RECEIPT: "Клиентская оплата", INCOME: "Поступление", EXPENSE: "Расход", TRANSFER: "Перевод между счетами",
  LOAN_IN: "Получен заём", LOAN_REPAYMENT: "Возврат займа", INTEREST: "Проценты", PARTNER_PAYOUT: "Выплата партнёру",
  REIMBURSEMENT: "Возмещение", OWNER_CONTRIBUTION: "Деньги от владельца", TAX: "Налог", ADJUSTMENT: "Корректировка остатка",
  CROSS_SPACE: "Между пространствами", PAID_BY_PARTNER: "Оплачено партнёром за компанию",
};

export const EFFECT: Record<EconomicEffect, string> = {
  PROJECT_COST: "Затрата проекта", OVERHEAD_COST: "Общие расходы", SALES: "Выручка", FINANCING: "Финансирование",
  REIMBURSEMENT: "Возмещение", PROFIT_DISTRIBUTION: "Распределение прибыли", PERSONAL_CONSUMPTION: "Личные траты",
  PERSONAL_INCOME: "Личный доход", TAX: "Налог", INTERNAL_TRANSFER: "Перевод", NONE: "Без экономического эффекта",
};

export const CERTAINTY: Record<string, string> = { CONTRACTED: "По договору", ESTIMATE: "Предварительно", PIPELINE: "Возможная сделка" };
export const CERTAINTY_OUT: Record<string, string> = { CONTRACTED: "Согласовано", ESTIMATE: "Оценка", PIPELINE: "Идея" };

export const MODEL: Record<string, string> = { SERVICE: "Заказной", OWN_IP: "Собственный", EXPERIMENT: "Эксперимент" };
export const STAGE: Record<string, string> = {
  IDEA: "Черновая идея", DEVELOPMENT: "Разработка", PREPRODUCTION: "Препродакшн", SHOOTING: "Съёмки", POSTPRODUCTION: "Постпродакшн",
  RELEASE: "Выпуск", DONE: "Завершён", CANCELLED: "Отменён",
};
export const COST_STAGE: Record<string, string> = {
  PREPRODUCTION: "Препродакшн", SHOOTING: "Съёмки", POSTPRODUCTION: "Постпродакшн", SERVICES: "Сервисы и генерации", TEAM: "Команда", OTHER: "Прочее",
};
export const FUNDING: Record<string, string> = { OWN_FUNDS: "Собственные средства", INVESTOR: "Инвестор", LOAN: "Заём", PRESALE: "Предпродажа", GRANT: "Грант", OTHER: "Другое" };
export const ACCOUNT_TYPE: Record<string, string> = { BANK: "Банковский счёт", CARD: "Карта", CASH: "Наличные", SAVINGS: "Накопительный", OTHER: "Другое" };
export const TAX_STATUS: Record<string, string> = { NOT_SET: "Не настроено", PENDING: "Расчёт ожидается", ENTERED: "Суммы внесены" };
export const FREQ: Record<string, string> = { WEEKLY: "Каждую неделю", MONTHLY: "Каждый месяц", QUARTERLY: "Каждый квартал", YEARLY: "Каждый год" };
export const SPACE_NAME = (type: string) => (type === "BUSINESS" ? "Продакшн" : "Я");
