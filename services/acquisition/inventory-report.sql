-- Staged-rollout inspection: run after every acquisition stage.
--
--   psql "$DATABASE_URL" -f services/acquisition/inventory-report.sql
--
-- Read it as a shape, not a scoreboard. `Property` is expected to stay at 0 until
-- entity resolution decides otherwise: discovery records coverage, and the
-- canonical count is an output of matching, never a target for the crawler.
--
-- Rejected records are NOT here - they are per-run, and they live in
-- `services/acquisition/ingest-report.json` (`rejected`, `rejected_records`).

\pset pager off

\echo '=== 1. the ledger: what we have observed ==='
SELECT
  (SELECT count(*) FROM "ProspectListing")     AS source_listings,
  (SELECT count(*) FROM "ProspectObservation") AS source_observations,
  (SELECT count(*) FROM "PriceObservation")    AS price_observations,
  (SELECT count(DISTINCT "source") FROM "ProspectListing") AS sources;

\echo '=== 2. discovered geography ==='
SELECT
  (SELECT count(*) FROM "Location")                                 AS locations,
  (SELECT count(*) FROM "ProspectListing" WHERE "locationId" IS NOT NULL) AS listings_with_location,
  (SELECT count(*) FROM "ProspectListing" WHERE "area" IS NULL)     AS listings_without_area,
  (SELECT count(DISTINCT area) FROM "ProspectListing")              AS distinct_areas;

\echo '=== 3. geocoding: evidence, not yet the answer ==='
SELECT
  (SELECT count(*) FROM "GeocodeRecord") AS geocodes,
  (SELECT count(*) FROM "GeocodeRecord" WHERE subject = 'SOURCE_LISTING') AS for_listings,
  (SELECT count(*) FROM "GeocodeRecord" WHERE subject = 'LOCATION')       AS for_locations,
  (SELECT count(*) FROM "GeocodeRecord" WHERE subject = 'PROPERTY')       AS for_properties;

\echo '--- geocode confidence and precision (the number to watch) ---'
SELECT provider, precision, "reviewStatus",
       count(*)                                          AS records,
       round(avg("confidenceBps"))                       AS avg_confidence_bps,
       count(*) FILTER (WHERE "confidenceBps" IS NULL)   AS without_confidence
FROM "GeocodeRecord"
GROUP BY provider, precision, "reviewStatus"
ORDER BY records DESC;

\echo '=== 4. canonical inventory: entity resolution decides these ==='
SELECT
  (SELECT count(*) FROM "Property")                     AS properties,
  (SELECT count(*) FROM "ProspectListing"
     WHERE "propertyId" IS NOT NULL)                    AS listings_linked_to_property,
  (SELECT count(*) FROM "ProspectListing"
     WHERE "propertyId" IS NULL)                        AS awaiting_entity_resolution,
  (SELECT count(*) FROM "Operator")                     AS operators,
  (SELECT count(*) FROM "ProspectListing"
     WHERE "operatorId" IS NOT NULL)                    AS listings_linked_to_operator;

\echo '--- bookable inventory must stay untouched by discovery ---'
SELECT
  (SELECT count(*) FROM "Unit")     AS bookable_units,
  (SELECT count(*) FROM "Booking")  AS bookings;

\echo '=== 5. duplicates: zero is the only acceptable number ==='
SELECT
  (SELECT count(*) FROM (SELECT "source", "sourceListingId" FROM "ProspectListing"
     GROUP BY 1, 2 HAVING count(*) > 1) d)                                        AS duplicate_listings,
  (SELECT count(*) FROM (SELECT "sourceListingId", "observedAt" FROM "ProspectObservation"
     GROUP BY 1, 2 HAVING count(*) > 1) d)                                        AS duplicate_observations,
  (SELECT count(*) FROM (SELECT "sourceListingId", "observedAt" FROM "PriceObservation"
     GROUP BY 1, 2 HAVING count(*) > 1) d)                                        AS duplicate_prices,
  (SELECT count(*) FROM (SELECT "subject", coalesce("sourceListingId", "locationId", "propertyId"),
      provider FROM "GeocodeRecord"
     GROUP BY 1, 2, 3 HAVING count(*) > 1) d)                                     AS duplicate_geocodes;

\echo '=== 6. observed prices by unit: never compare across these ==='
SELECT "priceBasis", count(*) AS listings,
       min("advertisedPriceKobo") AS min_kobo,
       max("advertisedPriceKobo") AS max_kobo
FROM "ProspectListing" GROUP BY 1 ORDER BY 2 DESC;

\echo '=== 7. freshness: is the crawl actually reaching the sites? ==='
SELECT "source",
       count(*)                        AS listings,
       min("firstSeenAt")::date        AS first_seen,
       max("lastSeenAt")::date         AS last_seen,
       count(DISTINCT "lastSeenAt"::date) AS distinct_days
FROM "ProspectListing" GROUP BY 1;

\echo '=== 8. per-area spread, so a crawl that silently half-fails is visible ==='
SELECT "stateCode", area, count(*) AS listings,
       count(*) FILTER (WHERE "locationId" IS NOT NULL) AS located
FROM "ProspectListing"
GROUP BY 1, 2 ORDER BY 3 DESC;
