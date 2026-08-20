ALTER TABLE "DocumentMatch" ADD COLUMN "explanation" TEXT;
ALTER TABLE "DocumentMatch" ADD COLUMN "explanationInputHash" TEXT;
ALTER TABLE "DocumentMatch" ADD COLUMN "explanationProvider" TEXT;
ALTER TABLE "DocumentMatch" ADD COLUMN "explanationModel" TEXT;
ALTER TABLE "DocumentMatch" ADD COLUMN "explanationPromptVersion" TEXT;
ALTER TABLE "DocumentMatch" ADD COLUMN "explanationGeneratedAt" DATETIME;
