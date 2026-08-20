ALTER TABLE "Document" ADD COLUMN "semanticFingerprint" TEXT;
CREATE UNIQUE INDEX "Document_ownerKey_semanticFingerprint_key"
ON "Document"("ownerKey", "semanticFingerprint");
