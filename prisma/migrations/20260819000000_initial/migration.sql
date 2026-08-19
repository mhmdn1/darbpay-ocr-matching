-- Initial Darb document-ingestion schema.
CREATE TABLE "Client" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL
);

CREATE TABLE "ClientEmail" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    CONSTRAINT "ClientEmail_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Transaction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "clientId" INTEGER NOT NULL,
    "cardLast4" TEXT NOT NULL,
    "driverPhone" TEXT,
    "merchantName" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "transactionAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "Document" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "senderIdentifier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "documentType" TEXT,
    "merchantName" TEXT,
    "vatNumber" TEXT,
    "totalAmount" INTEGER,
    "currency" TEXT,
    "documentDate" DATETIME,
    "cardLast4" TEXT,
    "invoiceNumber" TEXT,
    "rawText" TEXT,
    "extractionConfidence" REAL,
    "errorMessage" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "DocumentMatch" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "documentId" INTEGER NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "confidence" REAL NOT NULL,
    "signals" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentMatch_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DocumentMatch_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ClientEmail_email_key" ON "ClientEmail"("email");
CREATE INDEX "Transaction_driverPhone_idx" ON "Transaction"("driverPhone");
CREATE INDEX "Transaction_clientId_transactionAt_idx" ON "Transaction"("clientId", "transactionAt");
CREATE INDEX "Transaction_cardLast4_idx" ON "Transaction"("cardLast4");
CREATE UNIQUE INDEX "Document_externalId_key" ON "Document"("externalId");
CREATE UNIQUE INDEX "Document_contentHash_key" ON "Document"("contentHash");
CREATE INDEX "Document_status_idx" ON "Document"("status");
CREATE INDEX "Document_senderIdentifier_idx" ON "Document"("senderIdentifier");
CREATE UNIQUE INDEX "DocumentMatch_documentId_transactionId_key" ON "DocumentMatch"("documentId", "transactionId");
CREATE INDEX "DocumentMatch_transactionId_status_idx" ON "DocumentMatch"("transactionId", "status");
CREATE INDEX "DocumentMatch_documentId_status_idx" ON "DocumentMatch"("documentId", "status");

-- Prisma's schema DSL cannot express partial indexes. This is the database
-- source of truth for the one-confirmed-document-per-transaction invariant.
CREATE UNIQUE INDEX "one_confirmed_document_per_transaction"
ON "DocumentMatch"("transactionId")
WHERE "status" IN ('CONFIRMED', 'AUTO_CONFIRMED');
