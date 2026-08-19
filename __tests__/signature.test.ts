import { createHmac } from 'node:crypto';
import { verifySignature } from '@/lib/webhooks/signature';

const rawBody = JSON.stringify({ hello: 'world' });
const secret = 'super-secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifySignature', () => {
  test('no secret configured → pass through, not enforced', () => {
    expect(verifySignature({ rawBody, headerValue: null, secret: undefined })).toEqual({ ok: true, enforced: false });
  });

  test('valid signature (sha256= prefix) → ok, enforced', () => {
    const r = verifySignature({ rawBody, headerValue: sign(rawBody), secret });
    expect(r).toEqual({ ok: true, enforced: true });
  });

  test('valid signature (no prefix) → ok, enforced', () => {
    const bare = createHmac('sha256', secret).update(rawBody).digest('hex');
    const r = verifySignature({ rawBody, headerValue: bare, secret });
    expect(r).toEqual({ ok: true, enforced: true });
  });

  test('missing header when secret configured → fail closed', () => {
    const r = verifySignature({ rawBody, headerValue: null, secret });
    expect(r.ok).toBe(false);
  });

  test('mismatched signature → fail', () => {
    const r = verifySignature({ rawBody, headerValue: sign('different body'), secret });
    expect(r.ok).toBe(false);
  });

  test('malformed header → fail', () => {
    const r = verifySignature({ rawBody, headerValue: 'garbage', secret });
    expect(r.ok).toBe(false);
  });
});
