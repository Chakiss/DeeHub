import type { Executor } from '../../../database/executor';

export const MEAL_PLANS = [
  'ROOM_ONLY',
  'BREAKFAST',
  'HALF_BOARD',
  'FULL_BOARD',
  'ALL_INCLUSIVE',
] as const;

export type MealPlan = (typeof MEAL_PLANS)[number];

export interface RatePlanRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly code: string;
  readonly name: string;
  readonly mealPlan: string;
  readonly isRefundable: boolean;
  readonly isActive: boolean;
}

export interface CreateRatePlanRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly code: string;
  readonly name: string;
  readonly mealPlan: MealPlan;
  readonly isRefundable: boolean;
}

export type UpdateRatePlanFields = Partial<
  Pick<RatePlanRecord, 'name' | 'mealPlan' | 'isRefundable' | 'isActive'>
>;

/**
 * Rate plan persistence.
 *
 * Organization-scoped from the ambient tenant context (ADR-0001), and no
 * delete: rate_days and every reservation priced from a plan reference it, so
 * removing one would detach past bookings from what they were sold at.
 *
 * Derived plans (parentRatePlanId / derivationType) are deliberately not
 * creatable here. The columns and their CHECK constraints exist, but NOTHING in
 * the system computes a derived price — so a derived plan would be stored, look
 * configured, and have no prices at all.
 */
export interface RatePlanRepository {
  list(tx: Executor, propertyId: string): Promise<readonly RatePlanRecord[]>;
  findById(tx: Executor, propertyId: string, ratePlanId: string): Promise<RatePlanRecord | null>;
  insert(tx: Executor, record: CreateRatePlanRecord): Promise<void>;
  update(
    tx: Executor,
    propertyId: string,
    ratePlanId: string,
    fields: UpdateRatePlanFields,
  ): Promise<void>;
}

export const RATE_PLAN_REPOSITORY = Symbol('RATE_PLAN_REPOSITORY');
