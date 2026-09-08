import type { Response } from 'express';

/**
 * The single response envelope for every endpoint.
 *
 * Clients can branch on `success` alone and never have to guess whether a given
 * route returns a bare object, an array, or an ad-hoc `{ error }` shape. The
 * discriminated union means the generated client types stay honest.
 */
export type ApiSuccess<T> = {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
};

export type ApiFailure = {
  success: false;
  error: {
    code: string;
    message: string;
    /** Field-level detail, present only for validation failures. */
    details?: unknown;
    /** Correlates the client-visible failure with the server log entry. */
    requestId?: string;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function sendSuccess<T>(
  res: Response,
  data: T,
  meta?: Record<string, unknown>,
  statusCode = 200,
): void {
  const body: ApiSuccess<T> = meta ? { success: true, data, meta } : { success: true, data };
  res.status(statusCode).json(body);
}

/** Cursor/offset pagination metadata shared by every list endpoint. */
export type PageMeta = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export function pageMeta(total: number, limit: number, offset: number): PageMeta {
  return { total, limit, offset, hasMore: offset + limit < total };
}
