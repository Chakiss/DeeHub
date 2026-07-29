import { Injectable, type PipeTransform } from '@nestjs/common';
import { errors } from '@deehub/shared';
import type { ZodType } from 'zod';

/**
 * Validates and NARROWS request bodies with a zod schema.
 *
 * Schemas use `.strict()`, so unknown fields are rejected rather than ignored —
 * mass assignment is impossible, and a client sending `organizationId` gets a
 * clear error instead of silently having it dropped.
 *
 * Returns the PARSED value, so downstream code receives coerced, trusted types
 * rather than whatever JSON happened to arrive.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw errors.validation('Request validation failed', {
      fields: result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    });
  }
}
