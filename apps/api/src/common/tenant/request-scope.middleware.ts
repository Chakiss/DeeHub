import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestScope } from './tenant-context';

/**
 * Opens an AsyncLocalStorage scope for every request.
 *
 * Must run before guards. It deliberately creates an EMPTY scope: the auth
 * guard fills in the organization once the token is verified, so any repository
 * reached before authentication still throws instead of reading data.
 */
@Injectable()
export class RequestScopeMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const existing = req.headers['x-request-id'];
    const requestId = typeof existing === 'string' && existing ? existing : randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-Id', requestId);

    runWithRequestScope(requestId, () => {
      next();
    });
  }
}
