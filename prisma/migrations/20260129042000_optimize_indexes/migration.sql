-- Optimize indexes for better query performance

-- Event: Reorder composite index for better selectivity
DROP INDEX IF EXISTS "Event_country_state_city_status_idx";
CREATE INDEX IF NOT EXISTS "Event_status_country_state_city_idx" ON "Event"("status", "country", "state", "city");

-- Event: Add index for eventDate ordering and filtering
CREATE INDEX IF NOT EXISTS "Event_eventDate_idx" ON "Event"("eventDate");

-- Registration: Optimize indexes for user history queries
DROP INDEX IF EXISTS "Registration_userId_createdAt_idx";
CREATE INDEX IF NOT EXISTS "Registration_userId_purchaseDate_idx" ON "Registration"("userId", "purchaseDate");

-- Registration: Add index for invited registrations
CREATE INDEX IF NOT EXISTS "Registration_invitedById_purchaseDate_idx" ON "Registration"("invitedById", "purchaseDate");
