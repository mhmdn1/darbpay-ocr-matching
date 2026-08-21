-- Separate ranking similarity from conservative decision confidence.
ALTER TABLE "DocumentMatch" ADD COLUMN "decisionConfidence" REAL NOT NULL DEFAULT 0;
ALTER TABLE "DocumentMatch" ADD COLUMN "matcherVersion" TEXT NOT NULL DEFAULT 'heuristic-v2';

-- Preserve a useful approximation for rows created before this migration.
UPDATE "DocumentMatch"
SET "decisionConfidence" = "confidence" * (0.5 + 0.5 * "evidenceCoverage");

-- Tenant-scoped merchant aliases learned from human-confirmed decisions.
CREATE TABLE "MerchantAlias" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "clientId" INTEGER NOT NULL,
  "alias" TEXT NOT NULL,
  "normalizedAlias" TEXT NOT NULL,
  "canonicalMerchantName" TEXT NOT NULL,
  "canonicalNormalized" TEXT NOT NULL,
  "confirmationCount" INTEGER NOT NULL DEFAULT 1,
  "lastConfirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "MerchantAlias_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MerchantAlias_clientId_normalizedAlias_canonicalNormalized_key"
  ON "MerchantAlias"("clientId", "normalizedAlias", "canonicalNormalized");
CREATE INDEX "MerchantAlias_clientId_canonicalNormalized_idx"
  ON "MerchantAlias"("clientId", "canonicalNormalized");

-- Append-only reviewer labels with the exact document and candidate snapshots.
CREATE TABLE "ReviewDecisionEvent" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "documentId" INTEGER NOT NULL,
  "matchId" INTEGER NOT NULL,
  "transactionId" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "decidedBy" TEXT NOT NULL,
  "matcherVersion" TEXT NOT NULL,
  "documentSnapshot" TEXT NOT NULL,
  "candidateSnapshot" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReviewDecisionEvent_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ReviewDecisionEvent_documentId_createdAt_idx"
  ON "ReviewDecisionEvent"("documentId", "createdAt");
CREATE INDEX "ReviewDecisionEvent_action_createdAt_idx"
  ON "ReviewDecisionEvent"("action", "createdAt");
