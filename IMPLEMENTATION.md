# Implementation notes

## Table of contents
1. [Architecture at a glance](#architecture-at-a-glance)
2. [Matching engine](#matching-engine)
3. [Data model](#data-model)
4. [Pipeline / ingestion](#pipeline--ingestion)
5. [Review actions](#review-actions)
6. [Assumptions](#assumptions)
7. [Trade-offs](#trade-offs)
8. [Bonus features implemented](#bonus-features-implemented)
9. [Design sketch: multi-transaction invoice](#design-sketch-multi-transaction-invoice)
10. [What I would improve with more time](#what-i-would-improve-with-more-time)

## Architecture at a glance

```
webhook (email / whatsapp)         lib/services/document-ingestion.ts
        │                                     │
        ▼                                     ▼
Zod schema validation ─┐   ┌──── dedupe by (externalId, contentHash)
                       │   │
                       ▼   ▼
              lib/services/document-ingestion.ts
                       │
             ┌─────────┼──────────┐
             ▼         ▼          ▼
       MediaStore  DocumentExtractor  transaction-matcher (pure)
    (fixture map)  (Mock or LLM)          │
             │         │                  ▼
             └─────────┴────────► persist Document + DocumentMatch[]
                                          │
                                          ▼
                                   /review (server component)
                                          │
                                          ▼
                             confirmMatch / rejectMatch (server actions)
```

Two hard interfaces make the pipeline swappable end-to-end without touching
the matcher or the persistence layer:

- **`DocumentExtractor`** (`lib/extraction/types.ts`) — the mock is the default so
  reviewers can run the app with zero keys; swap for an LLM vision call by
  passing a different implementation to the singleton in
  `lib/webhooks/handler-utils.ts`.
- **`MediaStore`** (`lib/media/types.ts`) — the fixture-backed implementation
  loads files from `fixtures/documents/`; a production version would call
  `graph.facebook.com/{version}/{media-id}` with a bearer token.

## Matching engine

Lives in [`lib/services/transaction-matcher.ts`](lib/services/transaction-matcher.ts). Pure function, zero I/O.
Sender scoping is done by the ingestion layer (pre-filter of candidate
transactions) so the matcher can be unit-tested with hand-built inputs.

### Signals + weights

| Signal    | Weight | Why this weight |
|-----------|--------|-----------------|
| amount    | 0.30   | Most information-rich when it lines up exactly. Loses some strength on tips/rounding, so we don't give it a majority. |
| cardLast4 | 0.25   | Very strong when present, but often missing from receipts. Present-and-mismatched is treated as a soft veto (see below). |
| merchant  | 0.25   | Reliable after normalization but noisy on acquirer strings. Never enough on its own for a chain like "Alfanar Fuel". |
| date      | 0.20   | Lowest because documents legitimately arrive late (multi-day gap). Still useful as a tie-breaker. |

When a signal is missing on the document side (e.g. no card printed), we
**re-normalize** — the confidence is `sum(available_score × weight) / sum(available_weight)`.
That way a receipt with only amount + merchant + date can still auto-match
if all three are perfect.

### Amount score

Halalas are the base unit throughout the codebase; the matcher never touches
floats for money.

- `±100 halalas` (±1 SAR) → **1.0** (VAT rounding tolerance)
- receipt **smaller** than charge (customer tipped on the POS), diff ≤ 30% of charge → `1 − 0.5·(ratio / 0.30)` (linear decay from 1.0 to 0.5)
- receipt **larger** than charge, diff ≤ 2% → **0.9** (rare post-rounding overshoot)
- everything else → **0**

### Date score

Piecewise linear so the decay tracks the real world:

- same 24h → **1.0**
- 1–3 days → linear 1.0 → 0.7 (drivers often submit "yesterday's" receipts)
- 3–14 days → linear 0.7 → 0.2 (weekly reconciliation, holidays)
- >14 days → **0**

### Merchant score

`normalizeMerchant()`:
1. Upper-case, NFKD-strip diacritics
2. Replace non-alphanumeric with space
3. Drop tokens that are pure numbers (branch codes like `04`)
4. Drop a small stopword list: category noise (`ST`, `STATION`, `STORE`,
   `BR`, `BRANCH`), corporate suffixes (`LTD`, `LLC`, `INC`, `POS`), and
   KSA city codes seen on acquirer strings (`RUH`, `JED`, `DMM`, ...).

Then the score is the mean of:
- **Token Jaccard** (identifies chain overlap on short strings)
- **Character-bigram Dice** (survives spelling / spacing drift)

No dependency needed; both are ~15 lines of pure TS.

Example: `"ALFANAR FUEL ST 04 RUH"` and `"Alfanar Fuel Station"` both
normalize to `"ALFANAR FUEL"` → **1.0**.

### cardLast4 score

- match → **1.0**
- mismatch → **0** *and* a `0.25` multiplier is applied to the total
  confidence. This is a soft veto: card OCR is unreliable enough that we
  don't want a single misread digit to remove an otherwise excellent match
  from the review queue entirely, but we do want it out of the auto-match
  band.

### Outcome thresholds

| Threshold        | Value | Meaning |
|------------------|-------|---------|
| `autoMatch`      | 0.82  | Top confidence needed for AUTO_MATCHED |
| `autoMatchGap`   | 0.12  | Minimum gap over the runner-up for AUTO_MATCHED |
| `tieGap`         | 0.05  | Below this the top two are treated as a tie → NEEDS_REVIEW |
| `review`         | 0.55  | Below this: not even worth surfacing (UNMATCHED) |
| `maxCandidates`  | 5     | Cap on the ranked list persisted for the review UI |

The **one-confirmed-doc-per-transaction rule** is applied in the matcher too:
if the top candidate transaction already has a CONFIRMED or AUTO_CONFIRMED
match, the outcome is demoted from AUTO_MATCHED to NEEDS_REVIEW so a human
can decide whether this is a duplicate receipt.

### Why these numbers?

`0.82` felt like the right auto-match line after running the six fixtures:
the exact-match Alrajhi case lands at approximately **0.90** (auto), the Marhaba tip case
lands at **0.813** (review — correct — tips are heuristic and defensible),
the Petromin exact case lands at **≥0.95** (auto). Every threshold in
`MATCHER_CONFIG` is a single-line change and every scoring function is
individually unit-tested (`__tests__/normalization.test.ts`) so tuning them
is cheap.

## Data model

See [`prisma/schema.prisma`](prisma/schema.prisma). Notable choices:

- **`Client` + `ClientEmail`** — the task snippet only had `clientId Int` on
  Transaction with no way to resolve `sender@…` to a client. I added a
  first-class `Client` model and a `ClientEmail` allowlist table so the
  email scoping rule ("an email document only for that client") is a real
  DB constraint via a FK, not a runtime string check.
- **Enums declared even though SQLite has no native enum** — Prisma stores
  them as TEXT under SQLite and still generates typed TS enums. Documented
  at the top of the schema.
- **`DocumentMatch.signals` is `String`** — SQLite has no Json type in
  Prisma. Serialized JSON via `JSON.stringify(signals)`; the review UI
  parses defensively.
- **Indexes** — `Transaction(driverPhone)`, `Transaction(clientId, transactionAt)`,
  `Transaction(cardLast4)`, `Document(status)`, `DocumentMatch(transactionId, status)`.
  These cover the two hot paths (candidate scoping for a webhook, review
  queue).
- **Extra `Document` fields** beyond the spec: `errorMessage` (for the
  FAILED branch), `extractionConfidence` (for reviewer context),
  `updatedAt`, `invoiceNumber`.

## Pipeline / ingestion

`lib/services/document-ingestion.ts` is the seam between webhooks and
persistence.

- **Idempotency**: dedupe by `externalId` **or** `contentHash`. The unique
  constraints are the source of truth; a pre-check handles the common path
  and explicit unique-error recovery handles concurrent redeliveries.
- **Failure isolation**: once a Document exists, extraction, invalid extracted
  values, scoping, and match-persistence failures are translated to FAILED.
  Failure before the initial row exists is reported as a per-item webhook
  error because no terminal state can be persisted during a database outage.
- **Extraction low-confidence gating**: `documentType === 'UNKNOWN'`,
  `extractionConfidence < 0.3`, or `totalAmount == null` → skip matching
  and mark FAILED. The extracted text is still persisted so the reviewer
  has context.
- **Sender scoping** (per the spec):
  - WhatsApp: `Transaction.driverPhone = normalizedSender`
  - Email: sender → `ClientEmail.email` → `Client.id` → transactions
- **Persistence**: for AUTO_MATCHED we persist a single AUTO_CONFIRMED
  DocumentMatch. For NEEDS_REVIEW we persist all ranked candidates as
  CANDIDATE. All wrapped in `prisma.$transaction` so the doc status and
  matches move together.

## Review actions

`lib/actions/review.ts` (next-safe-action wrapper) → `lib/services/review-service.ts` (logic).

- **Idempotent replays**: submitting `confirmMatch` on an already-CONFIRMED
  match returns the current state, no error. Same for reject on
  already-REJECTED.
- **Race-safe transitions**: the CANDIDATE → CONFIRMED/REJECTED update is
  a `updateMany` with `where: { status: 'CANDIDATE' }`. If two reviewers
  click at the same time, the second one gets `count === 0` and we surface
  a "state changed under you" error instead of silently overwriting.
- **One-confirmed-per-transaction enforced at the data layer**: a partial
  unique SQLite index on `DocumentMatch(transactionId)` for CONFIRMED and
  AUTO_CONFIRMED rows lives in the raw SQL migration. The service also does
  an early transactional lookup to return a useful domain error.
- **Sibling auto-reject**: confirming a match auto-rejects the other
  CANDIDATE matches on the same document (they lost).
- **Document status transitions**: confirm → MATCHED; reject with no
  remaining candidates → UNMATCHED.

## Assumptions

- **Base unit is halalas** (integer). No floating-point math on money.
- **`from` on the email webhook is the internal forwarder**, not the
  original supplier. Real inbound-parse setups typically have a dedicated
  fleet-manager address forwarding vendor invoices to `receipts@…`; that's
  what `ClientEmail` allowlists.
- **Phone comparison is E.164 with `+`**. WhatsApp sends `"966…"` (no `+`);
  ingestion normalizes both sides.
- **Extraction is trusted to produce ISO 8601 dates and ISO 4217 currency**
  when it does emit them. Zod at the boundary catches malformed inputs
  before they touch matching.
- **Client scope is single-tenant per email address**. If one email
  address belonged to multiple clients we'd have to add `Client` to the
  webhook payload; not required by the current spec.

## Trade-offs

- **SQLite over Postgres** — the task allowed it and it made setup one
  command. JSON is serialized as String, while the partial unique index
  lives in SQL because Prisma's schema DSL cannot declare it.
- **Matcher pre-filter vs signal** — I chose pre-filter for sender scoping
  because it keeps the matcher pure. The alternative (a scoping signal
  inside the matcher with weight 0.0/1.0) mixes access-control with
  scoring; the pre-filter version is easier to unit-test.
- **Raw SQL migration for the partial index** — the portable model remains
  in Prisma while the database-specific invariant stays version-controlled.
- **Extractor is async** but the fixture map lives entirely in memory.
  Matches the shape a real HTTP extractor would need without adding real
  latency.

## Bonus features implemented

- **HMAC signature verification** on both webhook endpoints
  (`lib/webhooks/signature.ts`). Off by default so local demos work
  without key setup; set `EMAIL_WEBHOOK_SECRET` / `WHATSAPP_WEBHOOK_SECRET`
  to enforce. Uses `timingSafeEqual` and accepts both `sha256=…` (GitHub
  style) and bare hex signatures.
- **Rematching on new transactions** (`lib/services/rematch-unmatched.ts`).
  When a transaction arrives late, call `rematchUnmatched({ clientId })`
  or `rematchUnmatched({ driverPhone })` to re-run the matcher over
  UNMATCHED documents in that scope. Covered by an integration test in
  `__tests__/rematch.test.ts`. Not wired to `Transaction.create` in this
  build; would sit behind a Prisma extension in production.
- **`/review` UI**. Server component listing NEEDS_REVIEW documents with
  ranked candidates, per-signal confidence breakdown, and confirm/reject
  buttons wired to the safe-action server actions. Verified end-to-end
  during development.

## Design sketch: multi-transaction invoice

Not implemented; sketching only per the bonus prompt.

A statement covering many transactions (e.g. monthly fuel invoice
listing 42 fillups) breaks the "one document → one transaction" model.
Shape:

1. **Extraction** would emit an array of line items: `lineItems: Array<{
   date, amount, cardLast4?, merchant?, description }>`. The `ExtractedDocument`
   type gains an optional `lineItems` field; the top-level `totalAmount` is
   the invoice total.
2. **Data model** gets a `DocumentLine` model:
   `DocumentLine { id, documentId, index, amount, date, ... }` and
   `DocumentMatch` grows a nullable `lineIndex Int?` — matches now attach a
   *line* to a transaction, not a whole document.
3. **Matcher** runs per line (each line becomes an `ExtractedFields`
   input), then aggregates: a document with N lines produces up to N
   AUTO_CONFIRMED matches, or moves to NEEDS_REVIEW if any line was
   ambiguous. The top-level `Document.status` becomes derived
   (MATCHED = all lines matched, PARTIALLY_MATCHED = some, UNMATCHED = none).
4. **Rate-limit / batching**: for large statements we batch matcher runs
   inside a single transaction to keep the write ratio sane.

The scoring engine itself doesn't change — it's already line-shaped.

## What I would improve with more time

1. **Weight learning**: the current weights are hand-tuned. With a labeled
   history of confirmed matches, I'd fit a small logistic model on the four
   signals and back out weights. Better yet: expose the weights via a
   feature flag so we can A/B them.
2. **Streaming ingestion** for large email attachments (multi-page PDFs).
   Right now we buffer in memory; a real system would stream to blob
   storage and pass the URL to the extractor.
3. **Extractor-timeout guard**. `ingestDocument` awaits the extractor
   without a timeout. Should wrap it in a `Promise.race` against a
   configurable deadline and treat timeouts as FAILED.
4. **Observability**: OpenTelemetry span around each ingestion, tagged
   with the outcome — makes it trivial to alert on a spike in
   NEEDS_REVIEW or FAILED.
5. **Real OCR extractor** behind the same interface — either a managed
   document-AI service or a hosted vision model. Would keep the mock as the
   default for tests and CI so the suite stays offline and deterministic.
