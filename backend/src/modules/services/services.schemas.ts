import { ProbeType, ServiceState } from '@prisma/client';
import { z } from 'zod';

/**
 * Wire contracts for managing the service catalogue.
 *
 * The probe target deserves particular care: it is an operator-supplied address
 * that this server will connect to on a timer, which makes a careless
 * validator a server-side request forgery primitive. The schema restricts HTTP
 * targets to http/https URLs and TCP targets to `host:port`, so a target can
 * never be `file://`, `gopher://` or a credential-bearing URL.
 */

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TARGET_LENGTH = 2048;

const MIN_PROBE_INTERVAL_SECONDS = 5;
const MAX_PROBE_INTERVAL_SECONDS = 3600;
const MIN_PROBE_TIMEOUT_MS = 100;
const MAX_PROBE_TIMEOUT_MS = 60_000;

const HTTP_SCHEMES = new Set(['http:', 'https:']);

/** `host:port`, where host is a hostname or IP literal. */
const TCP_TARGET_PATTERN = /^[A-Za-z0-9._-]+:\d{1,5}$/;

const httpTarget = z
  .string()
  .max(MAX_TARGET_LENGTH)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an absolute URL' });
      return;
    }
    if (!HTTP_SCHEMES.has(url.protocol)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must use http or https' });
    }
    if (url.username || url.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must not embed credentials; they would be written to probe logs',
      });
    }
  });

const tcpTarget = z
  .string()
  .max(MAX_TARGET_LENGTH)
  .regex(TCP_TARGET_PATTERN, 'must be host:port')
  .refine(
    (value) => {
      const port = Number(value.slice(value.lastIndexOf(':') + 1));
      return Number.isInteger(port) && port >= 1 && port <= 65535;
    },
    { message: 'port must be between 1 and 65535' },
  );

const probeFields = {
  probeIntervalSeconds: z.coerce
    .number()
    .int()
    .min(MIN_PROBE_INTERVAL_SECONDS)
    .max(MAX_PROBE_INTERVAL_SECONDS)
    .default(30),
  probeTimeoutMs: z.coerce
    .number()
    .int()
    .min(MIN_PROBE_TIMEOUT_MS)
    .max(MAX_PROBE_TIMEOUT_MS)
    .default(5_000),
  expectedStatusMin: z.coerce.number().int().min(100).max(599).default(200),
  expectedStatusMax: z.coerce.number().int().min(100).max(599).default(399),
  isMonitored: z.boolean().default(true),
};

const baseService = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
  probeType: z.nativeEnum(ProbeType),
  probeTarget: z.string().min(1).max(MAX_TARGET_LENGTH),
  ...probeFields,
});

/**
 * The subset of fields the cross-field rules inspect.
 *
 * Declared as a supertype of both concrete schemas' outputs so the refinement
 * can be shared without a generic wrapper — wrapping `z.ZodTypeAny` would erase
 * the inferred output type and hand every caller an `any`.
 */
type TargetShape = {
  probeType?: ProbeType | undefined;
  probeTarget?: string | undefined;
  expectedStatusMin?: number | undefined;
  expectedStatusMax?: number | undefined;
};

/**
 * Validates the target against the probe type it was submitted with, which no
 * per-field rule can express.
 */
function refineTarget(value: TargetShape, ctx: z.RefinementCtx): void {
  const { probeType, probeTarget, expectedStatusMin, expectedStatusMax } = value;

  if (probeTarget !== undefined && probeType !== undefined) {
    const validator = probeType === ProbeType.HTTP ? httpTarget : tcpTarget;
    const result = validator.safeParse(probeTarget);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['probeTarget'],
          message: issue.message,
        });
      }
    }
  }

  // A partial update may supply only one bound; changing just one must still be
  // checked against the other, which the controller merges from the stored row.
  if (
    expectedStatusMin !== undefined &&
    expectedStatusMax !== undefined &&
    expectedStatusMin > expectedStatusMax
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectedStatusMax'],
      message: 'must be greater than or equal to expectedStatusMin',
    });
  }
}

export const createServiceSchema = baseService.superRefine(refineTarget);

/**
 * Updates are partial, plus an operator-settable status.
 *
 * Only MAINTENANCE and a return to ONLINE are meaningful to set by hand:
 * MAINTENANCE tells the scheduler to stop changing the status, which is how a
 * planned window is declared without silencing the probes themselves.
 */
export const updateServiceSchema = baseService
  .partial()
  .extend({
    status: z.enum([ServiceState.MAINTENANCE, ServiceState.ONLINE]).optional(),
  })
  .superRefine(refineTarget);

export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
