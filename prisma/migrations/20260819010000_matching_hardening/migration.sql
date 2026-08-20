-- Strong identifiers, tenant-safe idempotency, and persisted match evidence.
ALTER TABLE "Transaction" ADD COLUMN "merchantVatNumber" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "invoiceNumber" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "authorizationCode" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "merchantCategory" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "merchantCity" TEXT;

ALTER TABLE "Document" ADD COLUMN "ownerKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Document" ADD COLUMN "authorizationCode" TEXT;
ALTER TABLE "Document" ADD COLUMN "fieldConfidences" TEXT;

ALTER TABLE "DocumentMatch" ADD COLUMN "evidenceCoverage" REAL NOT NULL DEFAULT 0;
ALTER TABLE "DocumentMatch" ADD COLUMN "contradictions" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "DocumentMatch" ADD COLUMN "rank" INTEGER;

DROP INDEX "Document_externalId_key";
DROP INDEX "Document_contentHash_key";
CREATE UNIQUE INDEX "Document_source_externalId_key" ON "Document"("source", "externalId");
CREATE UNIQUE INDEX "Document_ownerKey_contentHash_key" ON "Document"("ownerKey", "contentHash");
