-- AlterTable (IF NOT EXISTS: column may have been added by 20260422000000_soft_delete_question)
ALTER TABLE "Question" ADD COLUMN IF NOT EXISTS "description" TEXT;
