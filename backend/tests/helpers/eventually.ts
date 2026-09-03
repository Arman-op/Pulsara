/**
 * Retries an assertion until it holds, or the budget runs out.
 *
 * Needed for exactly one thing: the audit trail is written off the request
 * path on purpose, so that an audit insert hitting a constraint cannot fail a
 * legitimate administrative action. That design choice means the row is not
 * guaranteed to exist the instant the response returns, and asserting on it
 * immediately would be a flaky test rather than a correct one.
 *
 * It is not a general-purpose sleep. Everything else in the suite is
 * deterministic and asserted directly.
 */
export async function eventually(
  assertion: () => Promise<void> | void,
  { timeoutMs = 2_000, intervalMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
