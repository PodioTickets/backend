-- This migration was applied directly to the database.
-- The same change is also covered by 20260304201155_add_variation_type_to_product (IF NOT EXISTS).
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "variationType" TEXT;
