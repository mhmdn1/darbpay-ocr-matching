# Darb Portal — take-home

A document ingestion + matching workflow for card receipts and tax invoices.
Documents arrive via email or WhatsApp webhooks, get OCR-extracted (mocked),
and are matched to card transactions with a confidence score. High-confidence
matches are auto-attached; ambiguous ones land in a review queue.

Implementation notes and design rationale live in
[`IMPLEMENTATION.md`](IMPLEMENTATION.md).

## Reviewer quick start

No API key, Docker container, database server, or private `.env` file is
required. The default configuration uses a local SQLite database and the
fixture-backed extractor.

```bash
git clone https://github.com/mhmdn1/darbpay-ocr-matching.git
cd darbpay-ocr-matching
npm install
npm run demo
```

Then open [http://localhost:3000](http://localhost:3000). The home page
redirects to the populated review queue.

`npm run demo` applies all committed migrations, resets only the local demo
database, runs the fixture documents through the real ingestion pipeline, and
starts Next.js. Use `Ctrl+C` to stop the server.

To verify the complete submission in one command:

```bash
npm run verify
```

This runs all tests, ESLint, strict TypeScript, and a production build—the same
verification executed by GitHub Actions.

## Requirements

- Node.js **≥ 20.19.0** (developed against 24.x)
- npm (no other package manager configured)

## Setup

The quick start above is the recommended reviewer path. For manual control:

```bash
npm install
npm run db:generate     # optional after install; postinstall already runs it
npm run db:migrate      # create the SQLite file + apply versioned migrations
npm run demo:seed       # reset dev data and load the review-page demo
```

The application defaults to `file:./dev.db`. Copy `.env.example` to `.env`
only when you want to override the database path, enable signed webhooks, or
use OpenAI for on-demand explanations:

```bash
cp .env.example .env
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

Each candidate also has a small **Explain match** button. Explanations are
strictly on demand: page loads, ingestion, and matching never call an LLM.
The first click generates and stores a short explanation; refreshes and repeat
requests reuse the cached text while the underlying evidence is unchanged.

The demo works without external services by using a deterministic local
explainer. To use OpenAI's Responses API instead, set:

```env
OPENAI_API_KEY="..."
OPENAI_EXPLANATION_MODEL="gpt-5.4" # optional override
```

Only matcher scores, evidence coverage, contradictions, and review triggers
are sent. Raw OCR text, sender identity, card digits, merchant names, and
transaction IDs are excluded. If the API is unavailable, the action falls
back to the local explanation and records which provider produced the text.

`npm run demo:seed` creates 2 clients, 17 transactions, and 10 documents by
running fixture receipts through the real ingestion pipeline. The review queue
includes an exact tie, missing-date fallback, duplicate-receipt safeguard, and
close branch/city choice. Processing history includes exact, tip-adjusted,
strong-VAT, unmatched, currency-conflict, and failed-extraction outcomes.

The demo command resets only the configured development database. Jest keeps
using its separate throwaway `test.db`.

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

Eleven test files cover the required behavior, matching hardening, and database invariants:

- `matcher.test.ts` — the six edge cases in the spec + cardLast4 mismatch, currency mismatch, partial extraction, one-confirmed rule, trimming.
- `normalization.test.ts` — real-world messy merchant strings + all four signal scorers + phone normalization.
- `signature.test.ts` — HMAC verification.
- `ingestion.test.ts` — happy path, redelivery, extractor throw, garbage extraction, sender scoping (both directions), leak isolation between clients.
- `rematch.test.ts` — document arriving before its transaction gets promoted after `rematchUnmatched`.
- `review-service.test.ts` — decision transitions, replay safety, sibling rejection, and database uniqueness.
- `match-explanation.test.ts` — click-time explanation reasons, cached reuse, and invalidation when evidence changes.
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
  seed.ts                         repeatable review-page demo
fixtures/
  documents/                      sample and demo document files
  webhook-payloads/               ready-to-fire JSON payloads + curl script + .http file
__tests__/                        149 unit and integration tests
```

## Handy scripts

```bash
npm run dev          # next dev
npm run build        # production build (webpack for sandbox/CI portability)
npm run test         # jest
npm run test:edge    # focused 51-case matcher edge matrix
npm run test:matcher # all matcher and normalization tests
npm run test:explanations # focused on-demand explanation tests
npm run test:all     # complete suite in serial mode
npm run check        # lint + TypeScript
npm run verify       # tests + lint + TypeScript + production build
npm run matcher:evaluate # evaluate human-labelled matcher outcomes
npm run db:generate  # prisma generate
npm run db:init      # ensure the configured SQLite file exists
npm run db:migrate   # initialize SQLite + apply committed migrations
npm run db:push      # prototype-only schema sync; migrations are preferred
npm run db:seed      # tsx prisma/seed.ts
npm run demo:seed    # reset and populate the visible review-page demo
npm run demo:setup   # generate client + migrate + seed
npm run demo         # complete demo setup, then start the app
npm run db:studio    # prisma studio
```
