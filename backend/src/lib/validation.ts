import type { Request } from 'express';
import { z } from 'zod';
import { ValidationError } from './errors';

/**
 * Request parsing.
 *
 * These helpers return parsed, typed values rather than mutating the request.
 * Express 5 exposes `req.query` as a getter, so the widespread middleware
 * pattern of assigning the validated object back onto the request throws at
 * runtime; returning the value also keeps the parsed type visible at the call
 * site instead of hiding it behind a module augmentation.
 *
 * A failure raises `ValidationError`, which the terminal error handler renders
 * as a 422 carrying the offending field paths.
 */

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown, source: string): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid request ${source}`, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data as z.infer<S>;
}

export const parseBody = <S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> =>
  parse(schema, req.body, 'body');

export const parseQuery = <S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> =>
  parse(schema, req.query, 'query parameters');

export const parseParams = <S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> =>
  parse(schema, req.params, 'path parameters');

/** Largest page a client may request, to bound memory and query cost. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/** Shared offset pagination accepted by every list endpoint. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

export const uuidParamSchema = z.object({
  id: z.string().uuid('must be a UUID'),
});
