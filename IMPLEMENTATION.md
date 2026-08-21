# Implementation notes

## Table of contents
1. [Architecture at a glance](#architecture-at-a-glance)
2. [Key decisions](#key-decisions)
3. [Matching engine](#matching-engine)
4. [Data model](#data-model)
5. [Pipeline / ingestion](#pipeline--ingestion)
6. [Review actions](#review-actions)
7. [Evaluation and operational metrics](#evaluation-and-operational-metrics)
8. [Assumptions](#assumptions)
9. [Trade-offs](#trade-offs)
10. [Bonus features implemented](#bonus-features-implemented)
11. [Design sketch: multi-transaction invoice](#design-sketch-multi-transaction-invoice)
12. [What I would improve with more time](#what-i-would-improve-with-more-time)

## Architecture at a glance

```
webhook (email / whatsapp)         lib/services/document-ingestion.ts
        │                                     │
        ▼                                     ▼
Zod schema validation ─┐   ┌──── tenant-safe exact + semantic dedupe
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
                    confirmMatch / rejectMatch / explainMatch (server actions)
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

## Key decisions

| Decision | Choice | Reason |
|---|---|---|
| Matching boundary | Pure matcher; candidate scoping stays in ingestion | Keeps authorization/tenant rules out of scoring and makes edge cases cheap to unit-test. |
| Confidence | Explainable weighted heuristic, not a claimed probability | The repository has no production labels for trustworthy probabilistic calibration. Every component score can be shown to the reviewer. |
| Missing evidence | Re-normalize available signals, then gate automation by evidence coverage | Missing card digits should not destroy ranking, but a sparse “100%” must never auto-confirm. |
| Ambiguity | Require both an absolute threshold and a lead over the runner-up | Two equally good transactions should be reviewed even if both individually score 100%. |
| Idempotency | Provider ID + tenant-scoped byte hash + semantic identity, enforced by unique constraints | Handles redelivery, re-encoding, and concurrent requests without cross-tenant suppression. |
| Storage | SQLite with versioned Prisma migrations | Makes a fresh clone runnable without infrastructure while retaining relational constraints and transactional review actions. |
| OCR integration | `DocumentExtractor` interface with deterministic fixtures | Demonstrates the production seam while keeping tests, CI, and reviewer setup offline and reproducible. |
| Explanations | Generated only after an explicit click, cached by evidence hash | Avoids latency and LLM cost on page load and prevents generated prose from influencing the deterministic decision engine. |
| Human review UI | Extracted receipt fields beside each exact candidate transaction | Lets finance operators verify what is being compared instead of trusting a score without context. |

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
That way a receipt with amount + merchant + date can still rank strongly.
The UI calls this value **similarity**. A separate conservative decision
confidence is `similarity × sqrt(evidence coverage)` and drives ranking and
thresholds, so matching every available field cannot be displayed as certainty
when most expected evidence is absent.
Automation additionally requires at least 70% weighted evidence coverage,
three available core signals, no reliable contradiction, and a 0.12 lead.
This prevents a perfect score over two sparse fields from looking certain.

### Amount score

Halalas are the base unit throughout the codebase; the matcher never touches
floats for money.

- `max(100 halalas, 0.2% of the transaction)` → **1.0** (hybrid absolute/relative rounding tolerance)
- for tip-eligible receipts only (restaurant/cafe/hospitality), receipt **smaller** than charge by ≤30% → linear decay from 1.0 to 0.5
- receipt **larger** than charge, diff ≤ 2% → **0.9** (rare post-rounding overshoot)
- everything else → **0**

### Date score

Piecewise linear so the decay tracks the real world:

- same calendar date in `Asia/Riyadh` → **1.0**
- within 24h across a Riyadh date boundary → **0.98**
- 1–3 days → linear 0.98 → 0.7 (drivers often submit "yesterday's" receipts)
- 3–14 days → linear 0.7 → 0.2 (weekly reconciliation, holidays)
- >14 days → **0**

### Merchant score

`normalizeMerchant()`:
1. Upper-case, NFKD-strip Latin and Arabic diacritics/tatweel
2. Canonicalize Arabic alef/yaa/hamza forms and Arabic-Indic digits
3. Preserve Arabic and Latin letters while replacing punctuation with spaces
4. Drop pure numeric tokens from the chain-level name
5. Drop a small bilingual stopword list: category noise (`ST`, `STATION`, `STORE`,
   `BR`, `BRANCH`), corporate suffixes (`LTD`, `LLC`, `INC`, `POS`), and
   KSA city codes seen on acquirer strings (`RUH`, `JED`, `DMM`, ...).

Then the chain-level score is the mean of:
- **Token Jaccard** (identifies chain overlap on short strings)
- **Character-bigram Dice** (survives spelling / spacing drift)

An Arabic-to-Latin fallback helps with cross-script strings. City and branch
are parsed separately and contribute small context scores, so the engine can
distinguish two branches without corrupting the chain name.

Example: `"ALFANAR FUEL ST 04 RUH"` and `"Alfanar Fuel Station"` both
normalize to `"ALFANAR FUEL"` → **1.0**.

### cardLast4 score

- match → **1.0**
- mismatch → **0**. When field-level OCR confidence is at least 0.80 it is
  recorded as a hard contradiction: automation is vetoed and the ranking
  score is reduced. Low-confidence OCR remains reviewable.

### Strong identifiers and rarity

Exact VAT number, invoice number, and authorization code comparisons are
supported when the transaction feed contains them. ZATCA QR TLV payloads can
fill missing VAT, seller, date, and total fields at 0.99 source reliability.
Inside each tenant/date block, rare merchant and amount values receive a small,
bounded ranking bonus; it is deliberately limited until reviewer labels prove
how much discriminative value it has.

### Outcome thresholds

| Threshold        | Value | Meaning |
|------------------|-------|---------|
| `autoMatch`      | 0.82  | Top confidence needed for AUTO_MATCHED |
| `autoMatchGap`   | 0.12  | Minimum gap over the runner-up for AUTO_MATCHED |
| `review`         | 0.55  | Below this: not even worth surfacing (UNMATCHED) |
| `candidateDisplay` | 0.35 | Weak alternatives below this are omitted from review |
| evidence coverage | 0.70 | Minimum available weighted evidence for AUTO_MATCHED |
| `maxCandidates`  | 5     | Cap on the ranked list persisted for the review UI |

The **one-confirmed-doc-per-transaction rule** is applied in the matcher too:
if the top candidate transaction already has a CONFIRMED or AUTO_CONFIRMED
match, the outcome is demoted from AUTO_MATCHED to NEEDS_REVIEW so a human
can decide whether this is a duplicate receipt.

### Why these numbers?

`confidence` is explicitly a **heuristic ranking score**, not a probability.
`0.82` is the current fixture-informed auto-match line:
the exact-match Alrajhi case and the Marhaba tip-tolerant case both clear the
automation safeguards, while tied Alfanar transactions remain in review despite
perfect individual scores. The Petromin exact case lands at **≥0.95** (auto). Every threshold in
`MATCHER_CONFIG` is a single-line change and every scoring function is
individually unit-tested (`__tests__/normalization.test.ts`) so tuning them
is cheap. `npm run matcher:evaluate` provides the safe path to replace these
choices with held-out reviewer-label metrics and isotonic calibration.

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
  `updatedAt`, strong identifiers, semantic fingerprint, and per-field OCR
  confidence. `DocumentMatch` persists rank, evidence coverage, contradictions,
  and an optional cached on-demand explanation with its evidence hash, provider,
  model, prompt version, and generation timestamp for auditability. `statusReason`
  stores a stable lifecycle code while `statusDetails` stores JSON diagnostics
  such as best score, thresholds, transactions checked, rejection count, and
  extraction confidence. Processing History renders both as a human-readable
  “why” disclosure without inventing a reason in the UI.

## Pipeline / ingestion

`lib/services/document-ingestion.ts` is the seam between webhooks and
persistence.

- **Idempotency**: provider IDs are unique per source; byte hashes and semantic
  invoice identities are unique per canonical client owner. This handles
  re-encoding/cropping without allowing one tenant to suppress another. The unique
  constraints are the source of truth; a pre-check handles the common path
  and explicit unique-error recovery handles concurrent redeliveries.
- **Failure isolation**: once a Document exists, extraction, invalid extracted
  values, scoping, and match-persistence failures are translated to FAILED.
  Failure before the initial row exists is reported as a per-item webhook
  error because no terminal state can be persisted during a database outage.
- **Extractor timeout**: provider calls have a configurable 15-second deadline;
  a timeout follows the same persisted FAILED path as other extraction errors.
- **Extraction low-confidence gating**: `documentType === 'UNKNOWN'`,
  `extractionConfidence < 0.3`, or `totalAmount == null` → skip matching
  and mark FAILED. The extracted text is still persisted so the reviewer
  has context.
- **Sender scoping** (per the spec):
  - WhatsApp: `Transaction.driverPhone = normalizedSender`
  - Email: sender → `ClientEmail.email` → `Client.id` → transactions
- **Candidate blocking**: after tenant scoping, a valid document date limits
  candidates through a union of exact-identifier, card/date, amount/date,
  learned-merchant-alias, and bounded fallback blocks. Exact authorization,
  invoice, or VAT identifiers may recover an older transaction outside the
  normal window. When the printed date is absent, `receivedAt` supplies the
  bounded window but remains a weak 0.25-reliability ranking signal and cannot
  support auto-confirmation.
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
  remaining candidates → UNMATCHED. Both transitions persist a stable reason;
  an unmatched record can therefore distinguish weak scoring from explicit
  human rejection.
- **Immutable labels and learned aliases**: every successful human transition
  appends a `ReviewDecisionEvent` containing matcher version plus document and
  candidate snapshots. Rejects store a structured reason. Confirmation also
  upserts a tenant-scoped `MerchantAlias`, allowing bank and receipt descriptors
  to become comparable without global or cross-client learning.
- **On-demand candidate explanations**: no explanation is generated during
  ingestion, scoring, or page rendering. The reviewer must click **Explain
  match**. The server re-reads the trusted match row, sends only sanitized
  matcher evidence to the configured provider, and stores the result. A SHA-256
  hash of the evidence plus prompt version makes repeat requests free and
  invalidates the cache if the scoring evidence changes. With no API key (or a
  provider failure), the same action uses a deterministic local explainer so
  the assessment remains fully runnable offline. The explanation never changes
  a score or decision; it is presentation only.

## Evaluation and operational metrics

Human-confirmed decisions are the source of truth. Automatic matches must not
grade the same model that created them. `npm run matcher:evaluate` currently
reports the following offline metrics from reviewer-labelled examples:

| Metric | Why it matters |
|---|---|
| Top-1 accuracy | How often the first-ranked candidate is the transaction the reviewer confirms. |
| Recall@1 / @3 / @5 | Whether the correct transaction appears anywhere in the candidate list. |
| True / false positives | Safe automatic matches versus incorrect automatic attachments. False positives are the highest-risk error. |
| True / false negatives | Correctly withheld weak matches versus safe matches unnecessarily sent to review. |
| Auto precision / recall | Correctness of automation and how much safe work it captures. |
| Auto coverage / review rate | Operational trade-off between automation and reviewer workload. |
| Brier score / calibration error | Whether displayed confidence tracks observed correctness. |

Production telemetry should additionally aggregate these dimensions without
logging raw OCR text or card data:

- document count by terminal status and `statusReason`;
- webhook dedupe rate and failure rate by pipeline stage;
- extraction and end-to-end latency at p50, p95, and p99;
- candidate-block size, top score, runner-up gap, evidence coverage, and contradiction rate;
- review queue age, time-to-decision, rejection rate, and correction rate;
- metrics sliced by source, document type, merchant category, score band, and
  model/rules version to detect drift and poorly served cohorts.

Alert primarily on false automatic matches, precision below the agreed safety
target, sudden extraction failures, growing queue age, and material calibration
drift. Optimize review rate only after correctness is stable.

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
- **Synchronous pipeline over a queue** — completing extraction and matching
  inside the webhook makes the take-home easy to run and inspect. The cost is
  request latency and weaker retry semantics; production would acknowledge,
  enqueue, and process asynchronously.
- **On-demand prose over automatic LLM calls** — deterministic signals remain
  the source of truth. Generating only after a reviewer asks avoids unnecessary
  cost and latency, while caching preserves auditability. The fallback local
  explainer keeps offline behavior predictable.
- **Persist only the top candidate set** — capping at five keeps review payloads
  understandable and storage bounded. It trades away long-tail alternatives,
  which can be recomputed from the original extracted fields if thresholds or
  scoring change.

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
  build; would sit behind a Prisma extension in production. Batch rematching
  uses maximum-weight one-to-one assignment, not greedy independent choices.
- **Offline evaluation and calibration** (`lib/services/matcher-evaluation.ts`).
  Computes ranking/automation/calibration metrics, selects a threshold at a
  target precision, and fits a dependency-free isotonic calibrator. Only human
  CONFIRMED decisions are eligible labels.
- **Active-learning review order and audits**. The review queue prioritizes
  threshold uncertainty, small candidate margins, and contradictions. A stable
  2% sample of otherwise automatic decisions is routed to review for unbiased QA.
- **Saudi ZATCA QR decoding** (`lib/extraction/zatca-qr.ts`). Mandatory TLV tags
  enrich missing OCR fields without overwriting visible extracted values.
- **`/review` UI**. Server component listing NEEDS_REVIEW documents with
  ranked candidates, per-signal confidence breakdown, and confirm/reject
  buttons wired to the safe-action server actions. Each candidate shows a
  field-by-field receipt-versus-transaction comparison with agreement/conflict
  indicators. Every candidate also has an explicit, click-only explanation
  control; stored explanations render under their candidate. Verified
  end-to-end during development.

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

1. **Fit and validate calibration with reviewer labels**: the evaluation
   pipeline exists, but this repository
   has zero human-labelled production decisions. I would require at least 100
   labels for an initial report and substantially more before changing an
   auto-match threshold. Split by time/client to avoid leakage.
2. **Replace fixture OCR with a production extractor** behind the existing
   `DocumentExtractor` interface. I would evaluate extraction quality per field,
   add provider retries/circuit breaking, and retain the mock for deterministic
   tests.
3. **Store and preview original documents securely**. The current review UI
   compares extracted fields with transaction fields; a production reviewer
   should also be able to open the original receipt/PDF from tenant-scoped blob
   storage using a short-lived URL.
4. **Move extraction and matching to a durable job queue**. Webhooks currently
   complete the pipeline synchronously for assessment simplicity. Production
   handlers should acknowledge quickly, enqueue work idempotently, retry
   transient provider failures, and dead-letter exhausted jobs.
5. **Streaming ingestion** for large email attachments and multi-page PDFs.
   Right now we buffer in memory; a real system would stream to blob
   storage and pass the URL to the extractor.
6. **Operational observability**: add OpenTelemetry spans and structured
   metrics for ingestion latency, extraction failure rate, review rate,
   auto-match precision, and queue depth. Alert on changes by client/source.
7. **Move from SQLite to PostgreSQL for deployment** while preserving the
   current constraints. This would improve concurrent writes and provide
   native JSON fields, stronger operational tooling, and production backups.
8. **End-to-end browser and webhook contract tests** in addition to the current
   unit/integration suite: fire signed payloads through a running server, make a
   review decision, and assert the visible lifecycle transition.
