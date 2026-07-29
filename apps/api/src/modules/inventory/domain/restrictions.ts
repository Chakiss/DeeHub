import { errors, type IsoDate, type RestrictionKind } from '@deehub/shared';
import { availableUnits, type InventoryDay } from './inventory-day';

/**
 * Sellability rules for a stay (domain-model.md §3.3).
 *
 * Pure functions over already-loaded inventory: no database, no clock, no DI.
 * Everything here is a rule a hotelier would recognise, and every rule is
 * unit-tested rather than discovered in production.
 */

export interface StayRequest {
  readonly roomTypeId: string;
  /** Nights the stay occupies: [checkIn, checkOut). */
  readonly nights: readonly IsoDate[];
  /** The departure date. Not a night, but CTD applies to it. */
  readonly checkOut: IsoDate;
  readonly units: number;
}

export interface RestrictionViolation {
  readonly restriction: RestrictionKind;
  readonly date: IsoDate;
  readonly detail?: Record<string, unknown>;
}

export interface UnavailabilityReport {
  /** Nights with no inventory row at all — the date was never opened for sale. */
  readonly missingDates: IsoDate[];
  /** Nights that exist but lack free units. */
  readonly soldOutDates: IsoDate[];
  readonly violations: RestrictionViolation[];
}

export function isSellable(report: UnavailabilityReport): boolean {
  return (
    report.missingDates.length === 0 &&
    report.soldOutDates.length === 0 &&
    report.violations.length === 0
  );
}

/**
 * Evaluate a stay against loaded inventory.
 *
 * `daysByDate` must cover every night AND the departure date, because
 * closed-to-departure is a property of the day the guest leaves — a night
 * DeeHub never holds inventory for.
 */
export function evaluateStay(
  request: StayRequest,
  daysByDate: ReadonlyMap<string, InventoryDay>,
): UnavailabilityReport {
  const missingDates: IsoDate[] = [];
  const soldOutDates: IsoDate[] = [];
  const violations: RestrictionViolation[] = [];

  const lengthOfStay = request.nights.length;
  const arrivalNight = request.nights[0];

  for (const night of request.nights) {
    const day = daysByDate.get(night);

    // A missing row means "not opened for sale", never "unlimited".
    if (!day) {
      missingDates.push(night);
      continue;
    }

    if (day.stopSell) {
      violations.push({ restriction: 'STOP_SELL', date: night });
    }

    if (availableUnits(day) < request.units) {
      soldOutDates.push(night);
    }
  }

  // Length-of-stay and arrival rules are evaluated on the ARRIVAL night. This
  // is the industry convention: a 3-night minimum on 31 December restricts
  // stays that START on the 31st, not every stay that touches it.
  if (arrivalNight) {
    const arrival = daysByDate.get(arrivalNight);
    if (arrival) {
      if (arrival.closedToArrival) {
        violations.push({ restriction: 'CLOSED_TO_ARRIVAL', date: arrivalNight });
      }
      if (lengthOfStay < arrival.minStay) {
        violations.push({
          restriction: 'MIN_STAY',
          date: arrivalNight,
          detail: { required: arrival.minStay, requested: lengthOfStay },
        });
      }
      if (arrival.maxStay !== null && lengthOfStay > arrival.maxStay) {
        violations.push({
          restriction: 'MAX_STAY',
          date: arrivalNight,
          detail: { allowed: arrival.maxStay, requested: lengthOfStay },
        });
      }
    }
  }

  // Closed-to-departure applies to the checkout date. Its inventory row may
  // legitimately not exist (beyond the open horizon), which is not an error —
  // the guest is leaving, not occupying it.
  const departure = daysByDate.get(request.checkOut);
  if (departure?.closedToDeparture) {
    violations.push({ restriction: 'CLOSED_TO_DEPARTURE', date: request.checkOut });
  }

  return { missingDates, soldOutDates, violations };
}

/** Turn a report into the typed error the API contract specifies. */
export function toDomainError(request: StayRequest, report: UnavailabilityReport): Error {
  const firstViolation = report.violations[0];
  if (firstViolation) {
    return errors.restrictionViolated(
      firstViolation.restriction,
      describeViolation(firstViolation),
      { date: firstViolation.date, ...firstViolation.detail },
    );
  }

  return errors.inventoryUnavailable(request.roomTypeId, [
    ...report.soldOutDates,
    ...report.missingDates,
  ]);
}

function describeViolation(violation: RestrictionViolation): string {
  switch (violation.restriction) {
    case 'STOP_SELL':
      return `Sales are closed on ${violation.date}.`;
    case 'CLOSED_TO_ARRIVAL':
      return `Arrivals are not permitted on ${violation.date}.`;
    case 'CLOSED_TO_DEPARTURE':
      return `Departures are not permitted on ${violation.date}.`;
    case 'MIN_STAY':
      return `Minimum stay is ${String(violation.detail?.['required'])} nights.`;
    case 'MAX_STAY':
      return `Maximum stay is ${String(violation.detail?.['allowed'])} nights.`;
  }
}
