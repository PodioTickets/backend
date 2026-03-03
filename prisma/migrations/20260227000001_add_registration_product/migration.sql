-- CreateTable
CREATE TABLE "RegistrationProduct" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "registrationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variationId" UUID,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER NOT NULL,
    "totalPrice" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RegistrationProduct_registrationId_idx" ON "RegistrationProduct"("registrationId");

-- CreateIndex
CREATE INDEX "RegistrationProduct_productId_idx" ON "RegistrationProduct"("productId");

-- CreateIndex
CREATE INDEX "RegistrationProduct_variationId_idx" ON "RegistrationProduct"("variationId");

-- AddForeignKey
ALTER TABLE "RegistrationProduct" ADD CONSTRAINT "RegistrationProduct_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationProduct" ADD CONSTRAINT "RegistrationProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationProduct" ADD CONSTRAINT "RegistrationProduct_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "ProductVariation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
