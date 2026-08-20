# Darb Portal — take-home

A document ingestion + matching workflow for card receipts and tax invoices.
Documents arrive via email or WhatsApp webhooks, get OCR-extracted (mocked),
and are matched to card transactions with a confidence score. High-confidence
matches are auto-attached; ambiguous ones land in a review queue.

Implementation notes and design rationale live in
[`IMPLEMENTATION.md`](IMPLEMENTATION.md).

## Requirements

- Node.js **≥ 20.19.0** (developed against 24.x)
- npm (no other package manager configured)

## Setup

```bash
npm install
npm run db:generate     # regenerate Prisma client (safe to re-run)
npm run db:migrate      # create dev.db + apply versioned migrations
npm run db:seed         # 2 clients + 15 transactions
```

> The stack pins are newer than the task brief specified:
> Next.js 16 (task said 15), Prisma 7 (task said 6), Zod 4, Jest 30. `create-next-app@latest`
> pulls today's latest — I adapted (Prisma 7's required driver adapter, etc.).
> See the top of `IMPLEMENTATION.md` for the full diff.

## Run the app

```bash
npm run dev
# open http://localhost:3000/review
```

The review page lists NEEDS_REVIEW documents with ranked candidates and
confirm/reject buttons. Other statuses (MATCHED / UNMATCHED / FAILED) are
in the "Other documents" table below.

## Fire the sample webhooks

Six ready-made payloads live in [`fixtures/webhook-payloads/`](fixtures/webhook-payloads/).

**With curl** (dev server must be running):

```bash
./fixtures/webhook-payloads/fire-all.sh
```

Individual request:

```bash
curl -X POST http://localhost:3000/api/webhooks/email \
  -H 'Content-Type: application/json' \
  --data-binary @fixtures/webhook-payloads/email-alrajhi.json | jq .
```

**With an .http-client** (VS Code REST Client, JetBrains): open
[`fixtures/webhook-payloads/requests.http`](fixtures/webhook-payloads/requests.http)
and click through each request.

Expected outcomes:

| Payload | Endpoint | Expected outcome |
|---|---|---|
| `email-alrajhi.json` | `/api/webhooks/email` | AUTO_MATCHED |
| `email-zamil-orphan.json` | `/api/webhooks/email` | UNMATCHED |
| `whatsapp-alfanar.json` | `/api/webhooks/whatsapp` | NEEDS_REVIEW (twin transactions) |
| `whatsapp-marhaba.json` | `/api/webhooks/whatsapp` | NEEDS_REVIEW (tip case, borderline) |
| `whatsapp-petromin.json` | `/api/webhooks/whatsapp` | AUTO_MATCHED |
| `whatsapp-garbage.json` | `/api/webhooks/whatsapp` | FAILED |
| refire any of the above | (any) | DUPLICATE (idempotent) |

## Tests

```bash
npm test
```

Nine test files cover the required behavior, matching hardening, and database invariants:

- `matcher.test.ts` — the six edge cases in the spec + cardLast4 mismatch, currency mismatch, partial extraction, one-confirmed rule, trimming.
- `normalization.test.ts` — real-world messy merchant strings + all four signal scorers + phone normalization.
- `signature.test.ts` — HMAC verification.
- `ingestion.test.ts` — happy path, redelivery, extractor throw, garbage extraction, sender scoping (both directions), leak isolation between clients.
- `rematch.test.ts` — document arriving before its transaction gets promoted after `rematchUnmatched`.
- `review-service.test.ts` — decision transitions, replay safety, sibling rejection, and database uniqueness.
- `global-assignment.test.ts` — optimal one-to-one batch assignment.
- `matcher-evaluation.test.ts` — ranking, precision/coverage, calibration, and threshold selection.
- `zatca-qr.test.ts` — Saudi e-invoice TLV QR decoding and OCR enrichment.

Tests build a throwaway `test.db` directly from committed SQL migrations, so
they verify a clean installation and never touch developer data.

To evaluate the matcher against human-confirmed review decisions:

```bash
npm run matcher:evaluate
```

The command reports top-1 accuracy, recall@1/3/5, auto-match precision and
coverage, Brier score, expected calibration error, and a threshold candidate
for 99.5% precision. It refuses to treat auto-confirmed rows as ground truth.

## Optional: HMAC-signed webhooks

Both endpoints support HMAC-SHA256 signature verification. Off by default so
local demos work; enable by setting env vars:

```env
EMAIL_WEBHOOK_SECRET="..."
WHATSAPP_WEBHOOK_SECRET="..."
```

Header names:
- Email: `x-webhook-signature`
- WhatsApp: `x-hub-signature-256` (matches the Meta Cloud API)

Format: either `sha256=<hex>` or bare `<hex>`.

## Project layout

```
app/
  api/webhooks/email/route.ts     inbound email webhook (Zod + HMAC + ingestion)
  api/webhooks/whatsapp/route.ts  inbound WhatsApp webhook
  review/                         /review UI (server component + client buttons)
lib/
  extraction/                     DocumentExtractor interface + MockExtractor
  media/                          MediaStore interface + fixture-backed impl
  services/
    transaction-matcher.ts        pure scoring engine
    global-assignment.ts          one-to-one batch optimizer
    matcher-evaluation.ts         offline metrics + isotonic calibration
    document-ingestion.ts         webhook → document pipeline
    review-service.ts             confirm/reject transactional logic
    rematch-unmatched.ts          bonus: retry UNMATCHED docs on new tx
  webhooks/                       Zod schemas, HMAC verification, singletons
  actions/                        next-safe-action wrappers
prisma/
  schema.prisma                   models + enums
  seed.ts                         2 clients, 15 transactions
fixtures/
  documents/                      six sample document files
  webhook-payloads/               ready-to-fire JSON payloads + curl script + .http file
__tests__/                        80+ unit and integration tests
```

## Handy scripts

```bash
npm run dev          # next dev
npm run build        # production build (webpack for sandbox/CI portability)
npm run test         # jest
npm run matcher:evaluate # evaluate human-labelled matcher outcomes
npm run db:generate  # prisma generate
npm run db:migrate   # prisma migrate deploy (creates dev.db)
npm run db:push      # prototype-only schema sync; migrations are preferred
npm run db:seed      # tsx prisma/seed.ts
npm run db:studio    # prisma studio
```
