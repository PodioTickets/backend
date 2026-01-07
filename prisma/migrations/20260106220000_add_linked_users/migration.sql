-- CreateTable
CREATE TABLE "LinkedUser" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mainUserId" UUID NOT NULL,
    "linkedUserId" UUID NOT NULL,
    "relationshipType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkedUser_mainUserId_linkedUserId_key" ON "LinkedUser"("mainUserId", "linkedUserId");

-- CreateIndex
CREATE INDEX "LinkedUser_mainUserId_idx" ON "LinkedUser"("mainUserId");

-- CreateIndex
CREATE INDEX "LinkedUser_linkedUserId_idx" ON "LinkedUser"("linkedUserId");

-- AddForeignKey
ALTER TABLE "LinkedUser" ADD CONSTRAINT "LinkedUser_mainUserId_fkey" FOREIGN KEY ("mainUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedUser" ADD CONSTRAINT "LinkedUser_linkedUserId_fkey" FOREIGN KEY ("linkedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

