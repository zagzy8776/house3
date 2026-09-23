/*
  Geocode subjects: a geocode can describe a SourceListing or a Location, before
  any canonical Property exists (coordinates are then a matching signal).

  REVIEWED BY HAND - do not regenerate blindly.
  Prisma generated this migration together with two DROP INDEX statements for
  "Property_geog_gist_idx" and "Operator_normalizedName_trgm_idx". Those indexes
  are created in raw SQL the Prisma datamodel cannot describe, so `migrate dev`
  sees them as drift to clean up. Applying those drops would silently delete the
  geospatial and trigram indexes, so they have been removed from this file.

  The same warning applies to the CHECK constraint and the partial unique indexes
  at the end: they exist only here, they are not in schema.prisma, and a future
  generated migration must NOT drop them.

  `GeocodeRecord` is empty wherever this runs - nothing writes geocodes yet - so
  adding the required `subject` column without a default is safe. On a populated
  table this would need the expand / backfill / contract sequence instead.

  Prisma warnings retained for the reviewer:
  - Added the required column `subject` to the `GeocodeRecord` table without a
    default value. This is not possible if the table is not empty.
*/
-- CreateEnum
CREATE TYPE "GeocodeSubject" AS ENUM ('SOURCE_LISTING', 'LOCATION', 'PROPERTY');

-- DropForeignKey
ALTER TABLE "GeocodeRecord" DROP CONSTRAINT "GeocodeRecord_propertyId_fkey";

-- DropIndex
DROP INDEX "GeocodeRecord_propertyId_key";

-- AlterTable
ALTER TABLE "GeocodeRecord" ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "normalizedAddress" TEXT,
ADD COLUMN     "sourceListingId" TEXT,
ADD COLUMN     "subject" "GeocodeSubject" NOT NULL,
ALTER COLUMN "propertyId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "GeocodeRecord_subject_idx" ON "GeocodeRecord"("subject");

-- CreateIndex
CREATE INDEX "GeocodeRecord_propertyId_idx" ON "GeocodeRecord"("propertyId");

-- CreateIndex
CREATE INDEX "GeocodeRecord_sourceListingId_idx" ON "GeocodeRecord"("sourceListingId");

-- CreateIndex
CREATE INDEX "GeocodeRecord_locationId_idx" ON "GeocodeRecord"("locationId");

-- AddForeignKey
ALTER TABLE "GeocodeRecord" ADD CONSTRAINT "GeocodeRecord_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeocodeRecord" ADD CONSTRAINT "GeocodeRecord_sourceListingId_fkey" FOREIGN KEY ("sourceListingId") REFERENCES "ProspectListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeocodeRecord" ADD CONSTRAINT "GeocodeRecord_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written from here: the invariants Prisma cannot express.
-- ---------------------------------------------------------------------------

-- Exactly one subject, and `subject` must agree with which key column is set.
-- Without it a row could claim to describe a Property while pointing at a
-- Location, and every join, cluster and map query that read it would quietly
-- mislead rather than fail.
ALTER TABLE "GeocodeRecord" ADD CONSTRAINT "GeocodeRecord_exactly_one_subject" CHECK (
  ("subject" = 'SOURCE_LISTING' AND "sourceListingId" IS NOT NULL AND "propertyId" IS NULL AND "locationId" IS NULL)
  OR ("subject" = 'LOCATION' AND "locationId" IS NOT NULL AND "propertyId" IS NULL AND "sourceListingId" IS NULL)
  OR ("subject" = 'PROPERTY' AND "propertyId" IS NOT NULL AND "sourceListingId" IS NULL AND "locationId" IS NULL)
);

-- One geocode per subject per provider. All three key columns are nullable, so
-- this takes partial indexes rather than a plain unique constraint. One row per
-- provider is deliberate: a second provider disagreeing is a second opinion worth
-- keeping, and `reviewStatus` records which one a human accepted. Re-running the
-- same provider is an upsert, not a new row.
CREATE UNIQUE INDEX "GeocodeRecord_source_listing_provider_key"
  ON "GeocodeRecord" ("sourceListingId", "provider") WHERE "sourceListingId" IS NOT NULL;
CREATE UNIQUE INDEX "GeocodeRecord_location_provider_key"
  ON "GeocodeRecord" ("locationId", "provider") WHERE "locationId" IS NOT NULL;
CREATE UNIQUE INDEX "GeocodeRecord_property_provider_key"
  ON "GeocodeRecord" ("propertyId", "provider") WHERE "propertyId" IS NOT NULL;
