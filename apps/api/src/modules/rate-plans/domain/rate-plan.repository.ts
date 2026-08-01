import type { Executor } from '../../../database/executor';
import type { DerivationType } from './derivation';

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
  /** Null for a plan that holds its own prices. */
  readonly parentRatePlanId: string | null;
  readonly derivationType: DerivationType | null;
  /** Signed: basis points for PERCENTAGE, minor units for AMOUNT. */
  readonly derivationValue: number | null;
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
  /** All three together or none: a database CHECK enforces the pairing. */
  readonly parentRatePlanId?: string | null;
  readonly derivationType?: DerivationType | null;
  readonly derivationValue?: number | null;
}

/**
 * Deliberately excludes the derivation, as it already excludes `code` and
 * `roomTypeId`.
 *
 * Turning a plan with stored prices into a derived one would strand those rows:
 * they stay in `rate_days`, the view stops reading them, and the plan silently
 * reprices every future night. Turning a derived plan into a base one leaves it
 * with no prices at all. Either could be built with a migration of the rows
 * behind it; neither is a PATCH.
 *
 * The offset VALUE is a different question — changing "−10%" to "−15%" is
 * exactly what a derived plan is for — and is allowed.
 */
export type UpdateRatePlanFields = Partial<
  Pick<RatePlanRecord, 'name' | 'mealPlan' | 'isRefundable' | 'isActive' | 'derivationValue'>
>;

/**
 * Rate plan persistence.
 *
 * Organization-scoped from the ambient tenant context (ADR-0001), and no
 * delete: rate_days and every reservation priced from a plan reference it, so
 * removing one would detach past bookings from what they were sold at.
 *
 * A derived plan carries a parent and an offset instead of prices of its own;
 * `effective_rate_days` resolves them, so every reader sees a price without
 * knowing which kind of plan it came from. Whether a plan is derived is fixed
 * at creation — see `UpdateRatePlanFields`.
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
