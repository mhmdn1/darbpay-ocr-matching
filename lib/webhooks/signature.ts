import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifySignatureInput {
  /** Raw request body (as a string — do not JSON.parse then stringify — order matters). */
  rawBody: string;
  /** Value of the signature header, e.g. "sha256=abc123..." or "abc123...". */
  headerValue: string | null;
  /** Shared secret. When undefined/empty, verification is treated as disabled. */
  secret: string | undefined;
}

export type VerifyResult =
  | { ok: true; enforced: boolean }
  | { ok: false; reason: string };

/**
 * HMAC-SHA256 verification for webhook payloads. If no secret is configured,
 * verification is skipped (developer convenience — local demos work without
 * key management). If a secret IS configured, the header must be present
 * and match; missing/mismatched headers fail closed.
 */
export function verifySignature(input: VerifySignatureInput): VerifyResult {
  if (!input.secret) return { ok: true, enforced: false };

  if (!input.headerValue) {
    return { ok: false, reason: 'signature header missing' };
  }

  const provided = input.headerValue.startsWith('sha256=')
    ? input.headerValue.slice('sha256='.length)
    : input.headerValue;

  const expected = createHmac('sha256', input.secret).update(input.rawBody, 'utf8').digest('hex');

  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'signature length mismatch' };
  return timingSafeEqual(a, b)
    ? { ok: true, enforced: true }
    : { ok: false, reason: 'signature mismatch' };
}
