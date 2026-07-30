import { errors } from '@deehub/shared';

export interface OccupancyShape {
  readonly standardOccupancy: number;
  readonly maxOccupancy: number;
  readonly maxAdults: number;
  readonly maxChildren: number;
}

/**
 * Occupancy has to hold together as a set, not field by field.
 *
 * The database enforces most of this with CHECK constraints, and that stays the
 * real guarantee. These exist so the API answers "max adults cannot exceed max
 * occupancy" instead of surfacing a constraint name, and so a PATCH that
 * changes one field is validated against the values it will actually sit
 * beside rather than the ones that were sent.
 */
export function assertOccupancy(shape: OccupancyShape): void {
  if (shape.standardOccupancy < 1) {
    throw errors.validation('Standard occupancy must be at least 1');
  }
  if (shape.maxOccupancy < shape.standardOccupancy) {
    throw errors.validation('Max occupancy cannot be lower than standard occupancy', {
      standardOccupancy: shape.standardOccupancy,
      maxOccupancy: shape.maxOccupancy,
    });
  }
  if (shape.maxAdults < 1) {
    throw errors.validation('Max adults must be at least 1');
  }
  // Not enforced by a CHECK constraint, and the one people actually get wrong:
  // a room that sleeps 2 cannot take 3 adults, whatever the field says.
  if (shape.maxAdults > shape.maxOccupancy) {
    throw errors.validation('Max adults cannot exceed max occupancy', {
      maxAdults: shape.maxAdults,
      maxOccupancy: shape.maxOccupancy,
    });
  }
  if (shape.maxChildren < 0) {
    throw errors.validation('Max children cannot be negative');
  }
  if (shape.maxChildren > shape.maxOccupancy) {
    throw errors.validation('Max children cannot exceed max occupancy', {
      maxChildren: shape.maxChildren,
      maxOccupancy: shape.maxOccupancy,
    });
  }
}

/**
 * Codes are typed by staff, sent to OTAs and used in mappings, so they are
 * normalised once here rather than defensively everywhere downstream.
 */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
