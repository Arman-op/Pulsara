import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UnauthenticatedError } from '../../src/lib/errors';
import { verifySignature } from '../../src/modules/github/github.webhook';
import { TEST_WEBHOOK_SECRET } from '../test-env';

/**
 * The signature check is the only thing between GitHub's payloads and forged
 * deployment records, because the endpoint is reachable by anyone.
 */

const body = Buffer.from(JSON.stringify({ action: 'completed', workflow_run: { id: 1 } }), 'utf8');

function sign(payload: Buffer, secret = TEST_WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    expect(() => verifySignature(body, sign(body))).not.toThrow();
  });

  it('rejects a body signed with a different secret', () => {
    expect(() => verifySignature(body, sign(body, 'a_different_secret_entirely'))).toThrow(
      UnauthenticatedError,
    );
  });

  it('rejects a modified body carrying the original signature', () => {
    // The realistic attack: replay a genuine delivery with the payload edited.
    const tampered = Buffer.from(
      JSON.stringify({ action: 'completed', workflow_run: { id: 999 } }),
      'utf8',
    );
    expect(() => verifySignature(tampered, sign(body))).toThrow(UnauthenticatedError);
  });

  it('rejects a signature that differs only in the last byte', () => {
    const valid = sign(body);
    const flipped = valid.slice(0, -1) + (valid.endsWith('0') ? '1' : '0');
    expect(() => verifySignature(body, flipped)).toThrow(UnauthenticatedError);
  });

  it('rejects a missing signature', () => {
    expect(() => verifySignature(body, undefined)).toThrow(UnauthenticatedError);
  });

  it('rejects a signature without the algorithm prefix', () => {
    const bare = sign(body).slice('sha256='.length);
    expect(() => verifySignature(body, bare)).toThrow(UnauthenticatedError);
  });

  it('rejects a truncated signature instead of crashing on a length mismatch', () => {
    // timingSafeEqual throws on differing lengths, which would surface as a 500
    // and, worse, be a side channel of its own.
    expect(() => verifySignature(body, sign(body).slice(0, 20))).toThrow(UnauthenticatedError);
  });

  it('verifies the exact bytes, not a re-serialised object', () => {
    // Same JSON value, different bytes: key order and whitespace differ. A
    // parse-then-restringify implementation would accept this; it must not,
    // because that implementation also accepts payloads it should reject.
    const reordered = Buffer.from('{"workflow_run":{"id":1},"action":"completed"}', 'utf8');
    expect(() => verifySignature(reordered, sign(body))).toThrow(UnauthenticatedError);
    expect(() => verifySignature(reordered, sign(reordered))).not.toThrow();
  });
});
