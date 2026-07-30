import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Sentry } from '../../observability/sentry';
import { reportError } from '../../observability/error-reporting';
import {
  DateError,
  DomainError,
  ERROR_STATUS,
  MoneyError,
  isDomainError,
  type ErrorCode,
} from '@deehub/shared';

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

    // Shared-kernel guard failures (an impossible calendar date, a decimal
    // money amount) mean the caller sent bad input. Without this they would
    // surface as 500s, which is both wrong and unhelpful to the client.
    if (exception instanceof DateError || exception instanceof MoneyError) {
      response.status(ERROR_STATUS.VALIDATION_ERROR).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: exception.message,
          requestId,
        },
      } satisfies ErrorBody);
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

    // Only genuinely unexpected failures are reported. Domain errors above are
    // normal outcomes — alerting on "room sold out" would bury the real ones.
    //
    // Cloud Error Reporting first, because it works with no account configured
    // and is therefore what actually catches things today. Sentry runs too when
    // a DSN exists.
    reportError(exception, {
      requestId,
      method: request.method,
      url: request.url,
      userId: (request as { principal?: { id?: string } }).principal?.id ?? null,
    });

    Sentry.withScope((scope) => {
      scope.setTag('requestId', requestId);
      scope.setContext('request', { method: request.method, url: request.url });
      Sentry.captureException(exception);
    });

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
