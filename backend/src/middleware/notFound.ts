import type { Request, Response, NextFunction } from 'express';
import { NotFoundError } from '../lib/errors';

/**
 * Converts an unmatched route into the standard error envelope, so a typo in a
 * client URL returns the same JSON shape as any other failure rather than
 * Express's default HTML error page.
 */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
}
