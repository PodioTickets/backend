-- Fix double conversion: values were already in cents but migration multiplied by 100 again
-- Divide by 100 to correct the values

-- Modality.price
UPDATE "Modality" SET "price" = "price" / 100 WHERE "price" > 1000000;

-- Order.totalAmount, serviceFee, discount, finalAmount
UPDATE "Order" SET "totalAmount" = "totalAmount" / 100 WHERE "totalAmount" > 1000000;
UPDATE "Order" SET "serviceFee" = "serviceFee" / 100 WHERE "serviceFee" > 1000000;
UPDATE "Order" SET "discount" = "discount" / 100 WHERE "discount" > 1000000;
UPDATE "Order" SET "finalAmount" = "finalAmount" / 100 WHERE "finalAmount" > 1000000;

-- Payment.amount
UPDATE "Payment" SET "amount" = "amount" / 100 WHERE "amount" > 1000000;

-- Coupon.value and minCartValue (only for FIXED type, PERCENTAGE should remain as-is)
UPDATE "Coupon" SET "value" = "value" / 100 WHERE "value" > 1000000 AND "type" = 'FIXED';
UPDATE "Coupon" SET "minCartValue" = "minCartValue" / 100 WHERE "minCartValue" > 1000000;

-- TicketBatch.price
UPDATE "TicketBatch" SET "price" = "price" / 100 WHERE "price" > 1000000;

-- Product.basePrice
UPDATE "Product" SET "basePrice" = "basePrice" / 100 WHERE "basePrice" > 1000000;

-- ProductVariation.price
UPDATE "ProductVariation" SET "price" = "price" / 100 WHERE "price" > 1000000;
