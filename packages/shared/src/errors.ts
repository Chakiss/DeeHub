/**
 * Domain error taxonomy — the contract in api-spec.md §4.
 *
 * Errors are typed so clients can react programmatically. The admin
 * dashboard must be able to tell "this room is sold out" from "your session
 * expired" without parsing prose.
 */

export const ERROR_STATUS = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  /** Also returned for cross-tenant access: a 403 would confirm the resource exists. */
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_MISMATCH: 409,
  INVENTORY_UNAVAILABLE: 409,
  RESTRICTION_VIOLATED: 422,
  /** A night in the requested stay has no price configured for that occupancy. */
  RATE_MISSING: 422,
  INVALID_STATE_TRANSITION: 409,
  ALLOTMENT_BELOW_BOOKED: 409,
  MAPPING_MISSING: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type ErrorDetails = Record<string, unknown>;

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = ERROR_STATUS[code];
    if (details !== undefined) this.details = details;
    Error.captureStackTrace?.(this, DomainError);
  }

  toJSON(): { code: ErrorCode; message: string; details?: ErrorDetails } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** Restrictions that can block a stay (domain-model.md §3.3). */
export type RestrictionKind =
  'STOP_SELL' | 'MIN_STAY' | 'MAX_STAY' | 'CLOSED_TO_ARRIVAL' | 'CLOSED_TO_DEPARTURE';

export const errors = {
  notFound(entity: string, id?: string): DomainError {
    return new DomainError('NOT_FOUND', `${entity} not found`, id ? { id } : undefined);
  },

  validation(message: string, details?: ErrorDetails): DomainError {
    return new DomainError('VALIDATION_ERROR', message, details);
  },

  forbidden(capability: string): DomainError {
    return new DomainError('FORBIDDEN', `Missing capability: ${capability}`, { capability });
  },

  conflict(message: string, details?: ErrorDetails): DomainError {
    return new DomainError('CONFLICT', message, details);
  },

  versionMismatch(expected: number, actual: number): DomainError {
    return new DomainError(
      'VERSION_MISMATCH',
      'This record was changed by someone else. Reload and try again.',
      { expected, actual },
    );
  },

  inventoryUnavailable(roomTypeId: string, unavailableDates: readonly string[]): DomainError {
    return new DomainError(
      'INVENTORY_UNAVAILABLE',
      `No availability on ${unavailableDates.join(', ')}`,
      { roomTypeId, unavailableDates },
    );
  },

  restrictionViolated(
    restriction: RestrictionKind,
    message: string,
    details?: ErrorDetails,
  ): DomainError {
    return new DomainError('RESTRICTION_VIOLATED', message, { restriction, ...details });
  },

  rateMissing(ratePlanId: string, occupancy: number, missingDates: readonly string[]): DomainError {
    return new DomainError(
      'RATE_MISSING',
      `No price configured for ${String(occupancy)} guest(s) on ${missingDates.join(', ')}`,
      { ratePlanId, occupancy, missingDates },
    );
  },

  invalidTransition(from: string, to: string): DomainError {
    return new DomainError(
      'INVALID_STATE_TRANSITION',
      `Cannot change status from ${from} to ${to}`,
      { from, to },
    );
  },

  allotmentBelowBooked(roomTypeId: string, conflicts: readonly unknown[]): DomainError {
    return new DomainError(
      'ALLOTMENT_BELOW_BOOKED',
      'Allotment cannot be lower than the number of rooms already sold',
      { roomTypeId, conflicts },
    );
  },

  mappingMissing(channelId: string, entity: string, entityId: string): DomainError {
    return new DomainError('MAPPING_MISSING', `No channel mapping for ${entity}`, {
      channelId,
      entity,
      entityId,
    });
  },
} as const;
