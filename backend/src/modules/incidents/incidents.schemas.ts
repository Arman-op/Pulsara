import { IncidentStatus, Severity } from '@prisma/client';
import { z } from 'zod';
import { paginationSchema } from '../../lib/validation';

/** Wire contracts for the incident surface. */

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5_000;
const MAX_COMMENT_LENGTH = 1_000;

export const listIncidentsQuerySchema = paginationSchema.extend({
  status: z.nativeEnum(IncidentStatus).optional(),
  severity: z.nativeEnum(Severity).optional(),
  serviceId: z.string().uuid().optional(),
  /**
   * Defaults to unset rather than to `true`. An on-call engineer wants open
   * incidents, but a postmortem wants the closed ones, and silently filtering
   * history out of a feed labelled "incidents" would be misleading.
   */
  isOpen: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

export const createIncidentSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
  severity: z.nativeEnum(Severity),
  serviceId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
});

export const updateIncidentSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
    description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
    severity: z.nativeEnum(Severity).optional(),
    status: z.nativeEnum(IncidentStatus).optional(),
    /** Explicit null unassigns; omitted leaves the assignee unchanged. */
    assigneeId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'at least one field must be provided',
  });

export const addCommentSchema = z.object({
  message: z.string().trim().min(1).max(MAX_COMMENT_LENGTH),
});

export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;
