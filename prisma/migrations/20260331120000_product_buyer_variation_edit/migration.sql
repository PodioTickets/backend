-- AlterTable
ALTER TABLE "Product" ADD COLUMN "buyerVariationEditAllowed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "variationEditDeadlineDays" INTEGER NOT NULL DEFAULT 0;
