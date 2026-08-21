ALTER TABLE "Document" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "Document" ADD COLUMN "statusDetails" TEXT;

-- Preserve a useful reason for databases upgraded from earlier revisions.
UPDATE "Document"
SET "statusReason" = CASE "status"
  WHEN 'MATCHED' THEN 'LEGACY_MATCHED'
  WHEN 'NEEDS_REVIEW' THEN COALESCE("reviewReason", 'AMBIGUOUS_MATCH')
  WHEN 'UNMATCHED' THEN 'LEGACY_UNMATCHED'
  WHEN 'FAILED' THEN 'LEGACY_FAILED'
  ELSE NULL
END
WHERE "statusReason" IS NULL;
