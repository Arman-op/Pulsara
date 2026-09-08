import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../config/env';
import { AppError, isAppError } from '../lib/errors';
import type { ApiFailure } from '../lib/http';
import { logger } from '../lib/logger';

/**
 * Terminal error handler.
 *
 * The previous implementation serialised `err.stack` into the response body on
 * every failure, in every environment. That hands an attacker the source tree
 * layout, dependency versions and often the failing query. Here, the stack is
 * logged server-side and the client receives a stable machine-readable code
 * plus a message that is only echoed when the error was deliberately raised as
 * client-facing.
 *
 * Express 5 forwards rejected promises from async handlers automatically, so
 * routes need no `asyncHandler` wrapper for their errors to arrive here.
 */

/** Prisma error codes we can map to a meaningful HTTP status. */
const PRISMA_UNIQUE_VIOLATION = 'P2002';
const PRISMA_RECORD_NOT_FOUND = 'P2025';
const PRISMA_FOREIGN_KEY_VIOLATION = 'P2003';

function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof ZodError) {
    return new AppError(422, 'VALIDATION_FAILED', 'Request validation failed', {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case PRISMA_UNIQUE_VIOLATION:
        return new AppError(409, 'CONFLICT', 'A record with these values already exists');
      case PRISMA_RECORD_NOT_FOUND:
        return new AppError(404, 'NOT_FOUND', 'The requested record does not exist');
      case PRISMA_FOREIGN_KEY_VIOLATION:
        return new AppError(409, 'CONFLICT', 'Referenced record does not exist');
      default:
        break;
    }
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new AppError(503, 'UPSTREAM_UNAVAILABLE', 'The database is unavailable');
  }

  // Anything reaching this point is an unhandled defect, not a supported outcome.
  const internal = new AppError(500, 'INTERNAL', 'Internal server error');
  Object.defineProperty(internal, 'isOperational', { value: false });
  return internal;
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  // Express identifies an error handler by arity; the parameter must stay.
  _next: NextFunction,
): void {
  const appError = toAppError(error);
  const requestId = typeof req.id === 'string' ? req.id : undefined;

  const log = req.log ?? logger;
  if (appError.statusCode >= 500) {
    log.error({ err: error, code: appError.code }, 'Unhandled request failure');
  } else {
    log.warn({ code: appError.code, message: appError.message }, 'Request rejected');
  }

  const body: ApiFailure = {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };

  // Outside production a developer benefits from the original message; it still
  // never includes a stack trace, which stays in the server log only.
  if (!isProduction && appError.statusCode >= 500 && error instanceof Error) {
    body.error.details = { developerMessage: error.message };
  }

  res.status(appError.statusCode).json(body);
}
