-- Convert all price/amount fields from Float (reais) to Int (cents)
-- Multiply existing values by 100 to convert from reais to cents

-- Convert all price/amount fields from Float (reais) to Int (cents)
-- Use numeric for precision, then cast to integer (no rounding, exact conversion)

-- Modality.price
ALTER TABLE "Modality" ALTER COLUMN "price" TYPE INTEGER USING (("price"::NUMERIC * 100)::INTEGER);

-- Order.totalAmount, serviceFee, discount, finalAmount
ALTER TABLE "Order" ALTER COLUMN "totalAmount" TYPE INTEGER USING (("totalAmount"::NUMERIC * 100)::INTEGER);
ALTER TABLE "Order" ALTER COLUMN "serviceFee" TYPE INTEGER USING (("serviceFee"::NUMERIC * 100)::INTEGER);
ALTER TABLE "Order" ALTER COLUMN "discount" TYPE INTEGER USING ((COALESCE("discount", 0)::NUMERIC * 100)::INTEGER);
ALTER TABLE "Order" ALTER COLUMN "finalAmount" TYPE INTEGER USING (("finalAmount"::NUMERIC * 100)::INTEGER);

-- Payment.amount
ALTER TABLE "Payment" ALTER COLUMN "amount" TYPE INTEGER USING (("amount"::NUMERIC * 100)::INTEGER);

-- Coupon.value and minCartValue
-- Note: For PERCENTAGE type, value should remain as-is (percentage), but we'll convert anyway
-- You may need to adjust this manually for percentage coupons
ALTER TABLE "Coupon" ALTER COLUMN "value" TYPE INTEGER USING (("value"::NUMERIC * 100)::INTEGER);
ALTER TABLE "Coupon" ALTER COLUMN "minCartValue" TYPE INTEGER USING ((COALESCE("minCartValue", 0)::NUMERIC * 100)::INTEGER);

-- TicketBatch.price
ALTER TABLE "TicketBatch" ALTER COLUMN "price" TYPE INTEGER USING (("price"::NUMERIC * 100)::INTEGER);

-- Product.basePrice
ALTER TABLE "Product" ALTER COLUMN "basePrice" TYPE INTEGER USING ((COALESCE("basePrice", 0)::NUMERIC * 100)::INTEGER);

-- ProductVariation.price
ALTER TABLE "ProductVariation" ALTER COLUMN "price" TYPE INTEGER USING (("price"::NUMERIC * 100)::INTEGER);
