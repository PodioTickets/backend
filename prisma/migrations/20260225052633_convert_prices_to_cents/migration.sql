-- Convert all price/amount fields from Float (reais) to Int (cents)
-- Multiply existing values by 100 to convert from reais to cents

-- Convert all price/amount fields from Float (reais) to Int (cents)
-- Use numeric for precision, then cast to integer (no rounding, exact conversion)

-- Modality.price
ALTER TABLE "Modality" ALTER COLUMN "price" TYPE INTEGER USING (
  CASE 
    WHEN "price" IS NULL THEN 0
    WHEN ("price"::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN ("price"::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE ("price"::NUMERIC * 100)::INTEGER
  END
);

-- Order.totalAmount, serviceFee, discount, finalAmount
ALTER TABLE "Order" ALTER COLUMN "totalAmount" TYPE INTEGER USING (
  CASE 
    WHEN "totalAmount" IS NULL THEN 0
    WHEN ("totalAmount"::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN ("totalAmount"::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE ("totalAmount"::NUMERIC * 100)::INTEGER
  END
);
ALTER TABLE "Order" ALTER COLUMN "serviceFee" TYPE INTEGER USING (
  CASE 
    WHEN "serviceFee" IS NULL THEN 0
    WHEN ("serviceFee"::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN ("serviceFee"::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE ("serviceFee"::NUMERIC * 100)::INTEGER
  END
);
ALTER TABLE "Order" ALTER COLUMN "discount" TYPE INTEGER USING (
  CASE 
    WHEN "discount" IS NULL THEN 0
    WHEN (COALESCE("discount", 0)::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN (COALESCE("discount", 0)::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE (COALESCE("discount", 0)::NUMERIC * 100)::INTEGER
  END
);
ALTER TABLE "Order" ALTER COLUMN "finalAmount" TYPE INTEGER USING (
  CASE 
    WHEN "finalAmount" IS NULL THEN 0
    WHEN ("finalAmount"::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN ("finalAmount"::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE ("finalAmount"::NUMERIC * 100)::INTEGER
  END
);

-- Payment.amount
ALTER TABLE "Payment" ALTER COLUMN "amount" TYPE INTEGER USING (
  CASE 
    WHEN "amount" IS NULL THEN 0
    WHEN ("amount"::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN ("amount"::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE ("amount"::NUMERIC * 100)::INTEGER
  END
);

-- Coupon.value and minCartValue
-- Note: For PERCENTAGE type, value should remain as-is (percentage), but we'll convert anyway
-- You may need to adjust this manually for percentage coupons
ALTER TABLE "Coupon" ALTER COLUMN "value" TYPE INTEGER USING (
  CASE 
    WHEN "value" IS NULL THEN 0
    WHEN ("value"::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN ("value"::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE ("value"::NUMERIC * 100)::INTEGER
  END
);
ALTER TABLE "Coupon" ALTER COLUMN "minCartValue" TYPE INTEGER USING (
  CASE 
    WHEN "minCartValue" IS NULL THEN 0
    WHEN (COALESCE("minCartValue", 0)::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN (COALESCE("minCartValue", 0)::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE (COALESCE("minCartValue", 0)::NUMERIC * 100)::INTEGER
  END
);

-- TicketBatch.price
ALTER TABLE "TicketBatch" ALTER COLUMN "price" TYPE INTEGER USING (
  CASE 
    WHEN "price" IS NULL THEN 0
    WHEN ("price"::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN ("price"::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE ("price"::NUMERIC * 100)::INTEGER
  END
);

-- Product.basePrice
ALTER TABLE "Product" ALTER COLUMN "basePrice" TYPE INTEGER USING (
  CASE 
    WHEN "basePrice" IS NULL THEN 0
    WHEN (COALESCE("basePrice", 0)::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN (COALESCE("basePrice", 0)::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE (COALESCE("basePrice", 0)::NUMERIC * 100)::INTEGER
  END
);

-- ProductVariation.price
ALTER TABLE "ProductVariation" ALTER COLUMN "price" TYPE INTEGER USING (
  CASE 
    WHEN "price" IS NULL THEN 0
    WHEN ("price"::NUMERIC * 100) > 2147483647 THEN 2147483647
    WHEN ("price"::NUMERIC * 100) < -2147483648 THEN -2147483648
    ELSE ("price"::NUMERIC * 100)::INTEGER
  END
);
