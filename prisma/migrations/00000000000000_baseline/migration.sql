CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CreateEnum
CREATE TYPE "StateStatus" AS ENUM ('PENDING', 'SUPPLY_ONBOARDING', 'LIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "PropertyVerificationStatus" AS ENUM ('DISCOVERED', 'NORMALIZED', 'GEOCODED', 'DEDUPLICATED', 'DATABASE', 'PUBLISHED', 'VERIFIED', 'BOOKABLE');

-- CreateEnum
CREATE TYPE "LocationPrecision" AS ENUM ('ROOFTOP', 'ADDRESS', 'STREET', 'NEIGHBORHOOD', 'CITY', 'STATE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SourceAccessMethod" AS ENUM ('PUBLIC_WEB', 'API', 'FEED', 'MANUAL');

-- CreateEnum
CREATE TYPE "SourceTermsStatus" AS ENUM ('UNREVIEWED', 'PERMITTED', 'RESTRICTED', 'PROHIBITED');

-- CreateEnum
CREATE TYPE "PriceBasis" AS ENUM ('PER_NIGHT', 'PER_WEEK', 'PER_MONTH', 'PER_YEAR', 'PER_STAY', 'PER_PERSON_NIGHT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "GeocodeReviewStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "MatchDecisionType" AS ENUM ('AUTO_MERGED', 'REVIEW_APPROVED', 'REVIEW_REJECTED', 'SPLIT', 'LEFT_SEPARATE');

-- CreateEnum
CREATE TYPE "AvailabilitySignalState" AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'UNKNOWN', 'REQUIRES_CONFIRMATION');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED');

-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('PARTNER_API', 'ICAL_FEED', 'PARTNER_DASHBOARD', 'AFFILIATE_PROGRAM');

-- CreateEnum
CREATE TYPE "AuthorizationBasis" AS ENUM ('SIGNED_SUPPLY_AGREEMENT', 'API_CREDENTIALS_ISSUED', 'PARTNER_PUBLISHED_FEED', 'AFFILIATE_PROGRAM_TERMS');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "UnitType" AS ENUM ('APARTMENT', 'STUDIO', 'ROOM', 'HOSTEL_BED', 'VILLA');

-- CreateEnum
CREATE TYPE "UnitStatus" AS ENUM ('DRAFT', 'LISTED', 'HIDDEN', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TitleDocument" AS ENUM ('C_OF_O', 'GOVERNORS_CONSENT', 'DEED_OF_ASSIGNMENT', 'EXCISION_GAZETTE', 'RIGHT_OF_OCCUPANCY', 'FREEHOLD', 'REGISTERED_DEED', 'UNREGISTERED', 'NOT_DISCLOSED');

-- CreateEnum
CREATE TYPE "NightState" AS ENUM ('OPEN', 'CLOSED', 'ON_REQUEST');

-- CreateEnum
CREATE TYPE "NightSource" AS ENUM ('PARTNER_API', 'ICAL_FEED', 'PARTNER_DASHBOARD', 'BOOKING');

-- CreateEnum
CREATE TYPE "PolicyScope" AS ENUM ('GLOBAL', 'STATE', 'PARTNER');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('ACTIVE', 'CONVERTED', 'EXPIRED', 'RELEASED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('DRAFT', 'HELD', 'AWAITING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "Processor" AS ENUM ('PAYSTACK', 'FLUTTERWAVE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "LedgerRecipient" AS ENUM ('PARTNER', 'PLATFORM');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('ROOM_REVENUE', 'CLEANING_PASSTHROUGH', 'SERVICE_FEE', 'SERVICE_FEE_VAT', 'PROCESSOR_FEE', 'REFUND');

-- CreateEnum
CREATE TYPE "LedgerStatus" AS ENUM ('PENDING', 'SETTLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "MediaLicence" AS ENUM ('PARTNER_SUPPLIED', 'HOUSE3_COMMISSIONED', 'LICENSED_FEED');

-- CreateTable
CREATE TABLE "State" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phase" INTEGER NOT NULL,
    "launchOrder" INTEGER NOT NULL,
    "status" "StateStatus" NOT NULL DEFAULT 'PENDING',
    "primaryCity" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "State_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Area" (
    "id" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "city" TEXT,
    "lga" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "operatorKey" TEXT,
    "displayName" TEXT,
    "normalizedName" TEXT NOT NULL,
    "phoneNormalized" TEXT,
    "email" TEXT,
    "websiteDomain" TEXT,
    "stateCode" TEXT,
    "partnerId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT,
    "propertyType" TEXT,
    "bedrooms" INTEGER,
    "bathrooms" INTEGER,
    "maxGuests" INTEGER,
    "stateCode" TEXT,
    "locationId" TEXT,
    "addressLine" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "geog" geography(Point, 4326),
    "locationPrecision" "LocationPrecision",
    "geocodeConfidence" INTEGER,
    "geocodeProvider" TEXT,
    "geocodedAt" TIMESTAMP(3),
    "verificationStatus" "PropertyVerificationStatus" NOT NULL DEFAULT 'DISCOVERED',
    "canonicalSourceListingId" TEXT,
    "operatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceRegistry" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "ownerLegalName" TEXT,
    "regions" TEXT[],
    "accessMethod" "SourceAccessMethod" NOT NULL,
    "termsStatus" "SourceTermsStatus" NOT NULL DEFAULT 'UNREVIEWED',
    "termsUrl" TEXT,
    "robotsPolicySnapshot" TEXT,
    "attributionRequirement" TEXT,
    "rateLimitPerMinute" INTEGER,
    "contactEmail" TEXT,
    "lastReviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectListing" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceListingId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "propertyId" TEXT,
    "operatorId" TEXT,
    "sourceRegistryId" TEXT,
    "locationId" TEXT,
    "city" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "advertisedPriceKobo" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "priceBasis" "PriceBasis" NOT NULL DEFAULT 'UNKNOWN',
    "bedrooms" INTEGER,
    "bathrooms" INTEGER,
    "area" TEXT,
    "stateCode" TEXT,
    "operatorKey" TEXT,
    "operatorName" TEXT,
    "rawSnapshotRef" TEXT,
    "parserVersion" TEXT,
    "normalizedAt" TIMESTAMP(3),
    "rawFacts" JSONB,
    "provenance" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProspectListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectObservation" (
    "id" TEXT NOT NULL,
    "sourceListingId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "normalizedFacts" JSONB NOT NULL,
    "rawFacts" JSONB,
    "provenance" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceObservation" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT,
    "sourceListingId" TEXT NOT NULL,
    "amountKobo" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "basis" "PriceBasis" NOT NULL DEFAULT 'UNKNOWN',
    "nights" INTEGER,
    "guests" INTEGER,
    "taxesIncluded" BOOLEAN,
    "feesIncluded" BOOLEAN,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeocodeRecord" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "confidenceBps" INTEGER,
    "precision" "LocationPrecision" NOT NULL,
    "reviewStatus" "GeocodeReviewStatus" NOT NULL DEFAULT 'PENDING',
    "observedAt" TIMESTAMP(3) NOT NULL,
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeocodeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchDecision" (
    "id" TEXT NOT NULL,
    "leftType" TEXT NOT NULL,
    "leftId" TEXT NOT NULL,
    "rightType" TEXT NOT NULL,
    "rightId" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "scoreBps" INTEGER,
    "decision" "MatchDecisionType" NOT NULL,
    "evidence" JSONB NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedByDecisionId" TEXT,

    CONSTRAINT "MatchDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Amenity" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Amenity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmenityAlias" (
    "id" TEXT NOT NULL,
    "amenityId" TEXT NOT NULL,
    "source" TEXT,
    "sourceWording" TEXT NOT NULL,
    "normalizedWording" TEXT NOT NULL,
    "mappingVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmenityAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyAmenity" (
    "propertyId" TEXT NOT NULL,
    "amenityId" TEXT NOT NULL,
    "confidenceBps" INTEGER,
    "decidedBy" TEXT NOT NULL,
    "mappingVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyAmenity_pkey" PRIMARY KEY ("propertyId","amenityId")
);

-- CreateTable
CREATE TABLE "SourceListingAmenity" (
    "sourceListingId" TEXT NOT NULL,
    "amenityId" TEXT NOT NULL,
    "sourceWording" TEXT NOT NULL,
    "confidenceBps" INTEGER,
    "decidedBy" TEXT NOT NULL,
    "mappingVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceListingAmenity_pkey" PRIMARY KEY ("sourceListingId","amenityId")
);

-- CreateTable
CREATE TABLE "AvailabilitySignal" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT,
    "unitId" TEXT,
    "state" "AvailabilitySignalState" NOT NULL,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "confidenceBps" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilitySignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryPartner" (
    "id" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "areaId" TEXT,
    "legalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "status" "PartnerStatus" NOT NULL DEFAULT 'ONBOARDING',
    "supplyAgreementRef" TEXT,
    "supplyAgreementSignedAt" TIMESTAMP(3),
    "paystackSubaccountCode" TEXT,
    "flutterwaveSubaccountId" TEXT,
    "settlementBankName" TEXT,
    "settlementAccountName" TEXT,
    "settlementAccountNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerChannel" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "kind" "ChannelKind" NOT NULL,
    "status" "ChannelStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorizationReference" TEXT NOT NULL,
    "authorizationBasis" "AuthorizationBasis" NOT NULL,
    "authorizationGrantedAt" TIMESTAMP(3) NOT NULL,
    "authorizationExpiresAt" TIMESTAMP(3),
    "config" JSONB NOT NULL,
    "secretRef" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitType" "UnitType" NOT NULL,
    "maxGuests" INTEGER NOT NULL,
    "bedrooms" INTEGER NOT NULL,
    "bathrooms" INTEGER NOT NULL,
    "nightlyRateKobo" INTEGER NOT NULL,
    "cleaningFeeKobo" INTEGER NOT NULL DEFAULT 0,
    "extraGuestFeePerNightKobo" INTEGER NOT NULL DEFAULT 0,
    "includedGuests" INTEGER NOT NULL DEFAULT 2,
    "minNights" INTEGER NOT NULL DEFAULT 1,
    "maxNights" INTEGER NOT NULL DEFAULT 30,
    "bookable" BOOLEAN NOT NULL DEFAULT true,
    "deepLinkBaseUrl" TEXT,
    "partnerDisplayName" TEXT,
    "status" "UnitStatus" NOT NULL DEFAULT 'DRAFT',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "titleDocument" "TitleDocument" NOT NULL DEFAULT 'NOT_DISCLOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitNight" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "night" DATE NOT NULL,
    "state" "NightState" NOT NULL,
    "nightlyRateKobo" INTEGER,
    "source" "NightSource" NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnitNight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeePolicy" (
    "id" TEXT NOT NULL,
    "scope" "PolicyScope" NOT NULL,
    "subjectId" TEXT,
    "stateCode" TEXT,
    "rateBps" INTEGER NOT NULL,
    "minFeeKobo" INTEGER NOT NULL,
    "maxFeeKobo" INTEGER,
    "minNightlyFeeKobo" INTEGER,
    "vatRateBps" INTEGER NOT NULL DEFAULT 750,
    "roundingStepKobo" INTEGER NOT NULL DEFAULT 5000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LengthOfStayDiscountRule" (
    "id" TEXT NOT NULL,
    "unitId" TEXT,
    "partnerId" TEXT,
    "stateCode" TEXT,
    "label" TEXT NOT NULL,
    "minNights" INTEGER NOT NULL,
    "discountBps" INTEGER NOT NULL,

    CONSTRAINT "LengthOfStayDiscountRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hold" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'DRAFT',
    "partnerId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "stateCode" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "guestEmail" TEXT NOT NULL,
    "guestPhone" TEXT NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 2,
    "children" INTEGER NOT NULL DEFAULT 0,
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "nights" INTEGER NOT NULL,
    "policyId" TEXT NOT NULL,
    "roomSubtotalKobo" INTEGER NOT NULL,
    "discountTotalKobo" INTEGER NOT NULL DEFAULT 0,
    "serviceFeeKobo" INTEGER NOT NULL,
    "serviceFeeVatKobo" INTEGER NOT NULL DEFAULT 0,
    "cleaningFeeKobo" INTEGER NOT NULL DEFAULT 0,
    "totalKobo" INTEGER NOT NULL,
    "partnerNetKobo" INTEGER NOT NULL,
    "platformNetKobo" INTEGER NOT NULL,
    "processorFeeKobo" INTEGER NOT NULL DEFAULT 0,
    "processor" "Processor",
    "priceBreakdown" JSONB NOT NULL,
    "holdExpiresAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "processor" "Processor" NOT NULL,
    "processorRef" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "rawPayload" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "recipient" "LedgerRecipient" NOT NULL,
    "kind" "LedgerKind" NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "status" "LedgerStatus" NOT NULL DEFAULT 'PENDING',
    "settlementRef" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingEvent" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "fromStatus" "BookingStatus",
    "toStatus" "BookingStatus" NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "processor" "Processor" NOT NULL,
    "eventType" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "rawBody" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "unitId" TEXT,
    "licence" "MediaLicence" NOT NULL,
    "licenceRef" TEXT NOT NULL,
    "licenceGrantedAt" TIMESTAMP(3) NOT NULL,
    "licenceExpiresAt" TIMESTAMP(3),
    "position" INTEGER NOT NULL DEFAULT 0,
    "alt" TEXT NOT NULL,
    "variants" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "State_launchOrder_key" ON "State"("launchOrder");

-- CreateIndex
CREATE INDEX "State_status_launchOrder_idx" ON "State"("status", "launchOrder");

-- CreateIndex
CREATE INDEX "Area_stateCode_rank_idx" ON "Area"("stateCode", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "Area_stateCode_name_key" ON "Area"("stateCode", "name");

-- CreateIndex
CREATE INDEX "Location_stateCode_name_idx" ON "Location"("stateCode", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Location_stateCode_normalizedName_key" ON "Location"("stateCode", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "Operator_operatorKey_key" ON "Operator"("operatorKey");

-- CreateIndex
CREATE INDEX "Operator_normalizedName_stateCode_idx" ON "Operator"("normalizedName", "stateCode");

-- CreateIndex
CREATE INDEX "Operator_phoneNormalized_idx" ON "Operator"("phoneNormalized");

-- CreateIndex
CREATE INDEX "Operator_email_idx" ON "Operator"("email");

-- CreateIndex
CREATE INDEX "Property_stateCode_verificationStatus_idx" ON "Property"("stateCode", "verificationStatus");

-- CreateIndex
CREATE INDEX "Property_locationId_verificationStatus_idx" ON "Property"("locationId", "verificationStatus");

-- CreateIndex
CREATE INDEX "Property_operatorId_idx" ON "Property"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRegistry_key_key" ON "SourceRegistry"("key");

-- CreateIndex
CREATE INDEX "ProspectListing_lastSeenAt_idx" ON "ProspectListing"("lastSeenAt");

-- CreateIndex
CREATE INDEX "ProspectListing_propertyId_idx" ON "ProspectListing"("propertyId");

-- CreateIndex
CREATE INDEX "ProspectListing_operatorKey_idx" ON "ProspectListing"("operatorKey");

-- CreateIndex
CREATE INDEX "ProspectListing_stateCode_area_idx" ON "ProspectListing"("stateCode", "area");

-- CreateIndex
CREATE UNIQUE INDEX "ProspectListing_source_sourceListingId_key" ON "ProspectListing"("source", "sourceListingId");

-- CreateIndex
CREATE INDEX "ProspectObservation_observedAt_idx" ON "ProspectObservation"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProspectObservation_sourceListingId_observedAt_key" ON "ProspectObservation"("sourceListingId", "observedAt");

-- CreateIndex
CREATE INDEX "PriceObservation_propertyId_observedAt_idx" ON "PriceObservation"("propertyId", "observedAt");

-- CreateIndex
CREATE INDEX "PriceObservation_observedAt_idx" ON "PriceObservation"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PriceObservation_sourceListingId_observedAt_key" ON "PriceObservation"("sourceListingId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GeocodeRecord_propertyId_key" ON "GeocodeRecord"("propertyId");

-- CreateIndex
CREATE INDEX "MatchDecision_leftType_leftId_idx" ON "MatchDecision"("leftType", "leftId");

-- CreateIndex
CREATE INDEX "MatchDecision_rightType_rightId_idx" ON "MatchDecision"("rightType", "rightId");

-- CreateIndex
CREATE INDEX "MatchDecision_decision_decidedAt_idx" ON "MatchDecision"("decision", "decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Amenity_key_key" ON "Amenity"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AmenityAlias_amenityId_source_normalizedWording_key" ON "AmenityAlias"("amenityId", "source", "normalizedWording");

-- CreateIndex
CREATE INDEX "AvailabilitySignal_propertyId_observedAt_idx" ON "AvailabilitySignal"("propertyId", "observedAt");

-- CreateIndex
CREATE INDEX "AvailabilitySignal_unitId_observedAt_idx" ON "AvailabilitySignal"("unitId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPartner_paystackSubaccountCode_key" ON "InventoryPartner"("paystackSubaccountCode");

-- CreateIndex
CREATE INDEX "InventoryPartner_stateCode_status_idx" ON "InventoryPartner"("stateCode", "status");

-- CreateIndex
CREATE INDEX "PartnerChannel_status_lastSyncedAt_idx" ON "PartnerChannel"("status", "lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerChannel_partnerId_kind_key" ON "PartnerChannel"("partnerId", "kind");

-- CreateIndex
CREATE INDEX "Unit_status_idx" ON "Unit"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_partnerId_externalId_key" ON "Unit"("partnerId", "externalId");

-- CreateIndex
CREATE INDEX "UnitNight_night_state_idx" ON "UnitNight"("night", "state");

-- CreateIndex
CREATE UNIQUE INDEX "UnitNight_unitId_night_key" ON "UnitNight"("unitId", "night");

-- CreateIndex
CREATE INDEX "FeePolicy_scope_subjectId_active_idx" ON "FeePolicy"("scope", "subjectId", "active");

-- CreateIndex
CREATE INDEX "LengthOfStayDiscountRule_unitId_idx" ON "LengthOfStayDiscountRule"("unitId");

-- CreateIndex
CREATE INDEX "LengthOfStayDiscountRule_partnerId_idx" ON "LengthOfStayDiscountRule"("partnerId");

-- CreateIndex
CREATE INDEX "LengthOfStayDiscountRule_stateCode_idx" ON "LengthOfStayDiscountRule"("stateCode");

-- CreateIndex
CREATE INDEX "Hold_unitId_status_expiresAt_idx" ON "Hold"("unitId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_reference_key" ON "Booking"("reference");

-- CreateIndex
CREATE INDEX "Booking_status_createdAt_idx" ON "Booking"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_guestEmail_idx" ON "Booking"("guestEmail");

-- CreateIndex
CREATE INDEX "Booking_unitId_checkIn_checkOut_idx" ON "Booking"("unitId", "checkIn", "checkOut");

-- CreateIndex
CREATE INDEX "Booking_stateCode_createdAt_idx" ON "Booking"("stateCode", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_processorRef_key" ON "Payment"("processorRef");

-- CreateIndex
CREATE INDEX "Payment_bookingId_status_idx" ON "Payment"("bookingId", "status");

-- CreateIndex
CREATE INDEX "LedgerEntry_recipient_status_idx" ON "LedgerEntry"("recipient", "status");

-- CreateIndex
CREATE INDEX "LedgerEntry_bookingId_idx" ON "LedgerEntry"("bookingId");

-- CreateIndex
CREATE INDEX "BookingEvent_bookingId_createdAt_idx" ON "BookingEvent"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_processor_signature_key" ON "WebhookEvent"("processor", "signature");

-- CreateIndex
CREATE INDEX "MediaAsset_unitId_position_idx" ON "MediaAsset"("unitId", "position");

-- CreateIndex
CREATE INDEX "MediaAsset_partnerId_licenceExpiresAt_idx" ON "MediaAsset"("partnerId", "licenceExpiresAt");

-- AddForeignKey
ALTER TABLE "Area" ADD CONSTRAINT "Area_stateCode_fkey" FOREIGN KEY ("stateCode") REFERENCES "State"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_stateCode_fkey" FOREIGN KEY ("stateCode") REFERENCES "State"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operator" ADD CONSTRAINT "Operator_stateCode_fkey" FOREIGN KEY ("stateCode") REFERENCES "State"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operator" ADD CONSTRAINT "Operator_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "InventoryPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_stateCode_fkey" FOREIGN KEY ("stateCode") REFERENCES "State"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectListing" ADD CONSTRAINT "ProspectListing_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectListing" ADD CONSTRAINT "ProspectListing_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectListing" ADD CONSTRAINT "ProspectListing_sourceRegistryId_fkey" FOREIGN KEY ("sourceRegistryId") REFERENCES "SourceRegistry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectListing" ADD CONSTRAINT "ProspectListing_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectObservation" ADD CONSTRAINT "ProspectObservation_sourceListingId_fkey" FOREIGN KEY ("sourceListingId") REFERENCES "ProspectListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceObservation" ADD CONSTRAINT "PriceObservation_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceObservation" ADD CONSTRAINT "PriceObservation_sourceListingId_fkey" FOREIGN KEY ("sourceListingId") REFERENCES "ProspectListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeocodeRecord" ADD CONSTRAINT "GeocodeRecord_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmenityAlias" ADD CONSTRAINT "AmenityAlias_amenityId_fkey" FOREIGN KEY ("amenityId") REFERENCES "Amenity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyAmenity" ADD CONSTRAINT "PropertyAmenity_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyAmenity" ADD CONSTRAINT "PropertyAmenity_amenityId_fkey" FOREIGN KEY ("amenityId") REFERENCES "Amenity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceListingAmenity" ADD CONSTRAINT "SourceListingAmenity_sourceListingId_fkey" FOREIGN KEY ("sourceListingId") REFERENCES "ProspectListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceListingAmenity" ADD CONSTRAINT "SourceListingAmenity_amenityId_fkey" FOREIGN KEY ("amenityId") REFERENCES "Amenity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilitySignal" ADD CONSTRAINT "AvailabilitySignal_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilitySignal" ADD CONSTRAINT "AvailabilitySignal_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPartner" ADD CONSTRAINT "InventoryPartner_stateCode_fkey" FOREIGN KEY ("stateCode") REFERENCES "State"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPartner" ADD CONSTRAINT "InventoryPartner_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerChannel" ADD CONSTRAINT "PartnerChannel_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "InventoryPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "InventoryPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitNight" ADD CONSTRAINT "UnitNight_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeePolicy" ADD CONSTRAINT "FeePolicy_stateCode_fkey" FOREIGN KEY ("stateCode") REFERENCES "State"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hold" ADD CONSTRAINT "Hold_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "InventoryPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "InventoryPartner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- PostGIS and fuzzy entity-resolution indexes are intentionally hand-written.
CREATE INDEX "Property_geog_gist_idx"
ON "Property" USING GIST ("geog");

CREATE INDEX "Operator_normalizedName_trgm_idx"
ON "Operator" USING GIN ("normalizedName" gin_trgm_ops);
