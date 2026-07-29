import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError, isDomainError, type ErrorCode } from '@deehub/shared';

interface ErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

/**
 * Single translation point from thrown errors to the wire format in
 * api-spec.md §4.
 *
 * Unknown errors are deliberately flattened to INTERNAL_ERROR with no detail:
 * a stack trace or driver message in a response body is an information leak.
 * The requestId is the thread back to the full error in the logs.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = this.resolveRequestId(request);

    if (isDomainError(exception)) {
      const body: ErrorBody = {
        error: { ...exception.toJSON(), requestId },
      };
      response.status(exception.httpStatus).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      response.status(status).json({
        error: {
          code: this.codeForStatus(status),
          message: Array.isArray(message) ? message.join('; ') : message,
          requestId,
        },
      } satisfies ErrorBody);
      return;
    }

    this.logger.error(
      `Unhandled error on ${request.method} ${request.url} [${requestId}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    response.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        requestId,
      },
    } satisfies ErrorBody);
  }

  private resolveRequestId(request: Request): string {
    const header = request.headers['x-request-id'];
    if (typeof header === 'string' && header.length > 0) return header;
    if (Array.isArray(header) && header[0]) return header[0];
    return 'unknown';
  }

  private codeForStatus(status: number): ErrorCode | string {
    switch (status) {
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'VALIDATION_ERROR';
      case 429:
        return 'RATE_LIMITED';
      default:
        return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR';
    }
  }
}

export { DomainError };
