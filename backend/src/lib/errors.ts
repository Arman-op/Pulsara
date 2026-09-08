/**
 * Typed application errors.
 *
 * Controllers throw these instead of hand-writing `res.status(...).json(...)`
 * at every failure point, which keeps the wire format for errors in exactly one
 * place (`errorHandler`) and makes it impossible for a route to invent its own.
 *
 * `isOperational` distinguishes an expected, client-visible condition (bad
 * input, missing row, wrong password) from a genuine bug. Only the former has
 * its message forwarded to the caller; anything else is reported as a generic
 * internal error so that stack traces and driver messages never reach a client.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly isOperational = true;
  readonly details?: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Malformed request', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: unknown) {
    super(422, 'VALIDATION_FAILED', message, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHENTICATED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions for this action') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(409, 'CONFLICT', message);
  }
}

export class UpstreamUnavailableError extends AppError {
  constructor(message = 'An upstream dependency is unavailable') {
    super(503, 'UPSTREAM_UNAVAILABLE', message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
