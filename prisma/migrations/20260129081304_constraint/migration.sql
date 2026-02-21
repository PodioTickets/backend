/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `Event` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[googleId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex (only if it doesn't exist)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'Event_slug_key'
  ) THEN
    CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");
  END IF;
END $$;

-- CreateIndex (only if it doesn't exist)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'User_googleId_key'
  ) THEN
    CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
  END IF;
END $$;
