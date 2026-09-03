import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The request a piece of work belongs to, available without passing it down.
 *
 * A correlation id that only appears on the two lines pino-http writes is not
 * correlation. The lines worth finding during an incident are the ones the
 * application emits in between — "Probe execution failed", "Opened incident
 * from an observed condition", "Cache read failed" — and threading a request
 * object through every service, engine and helper to reach them would be a
 * worse cure than the disease.
 *
 * `AsyncLocalStorage` carries it across every `await` in the request instead, so
 * the logger can stamp it on automatically.
 *
 * The deliberate limit: work that outlives the request that started it — a
 * scheduled probe, a background sync — has no request to belong to, and its
 * logs carry no id. That is correct rather than unfortunate. Inventing one
 * would imply a caller that does not exist.
 */
export type RequestContext = { requestId: string };

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
