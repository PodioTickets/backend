-- Ads / rastreamento (organizador): Meta Pixel, GA4, Google Ads — não expostos em API pública por padrão.

ALTER TABLE "Event" ADD COLUMN "meta_pixel_id" TEXT;
ALTER TABLE "Event" ADD COLUMN "google_analytics_id" TEXT;
ALTER TABLE "Event" ADD COLUMN "google_ads_id" TEXT;
