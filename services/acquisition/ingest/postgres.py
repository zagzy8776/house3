"""Idempotent discovery-record writer for House3 PostgreSQL/PostGIS.

This module deliberately writes discovery/catalogue records, not bookable units.
The crawler has no partner agreement, calendar, or settlement account, so a
successful ingest must never create or mutate ``Unit`` rows.

The implementation accepts any small DB-API 2.0 connection. ``psycopg`` is only
needed by the command-line entry point; tests can use a recording connection and
the acquisition service remains runnable without a database driver installed.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Iterable, Optional, Protocol
from urllib.parse import urlparse

from normalization.addresses import canonical_area, slug
from normalization.names import normalise_operator_name, operator_key as build_operator_key
from normalization.phones import normalise_phone
from sources.base import DiscoveredListing


class Cursor(Protocol):
    def execute(self, operation: str, parameters: tuple[Any, ...] = ()) -> Any: ...

    def fetchone(self) -> Optional[tuple[Any, ...]]: ...

    def fetchall(self) -> list[tuple[Any, ...]]: ...

    def close(self) -> None: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...


@dataclass(frozen=True)
class RejectedRecord:
    source: str
    source_listing_id: str
    reason: str

    def to_dict(self) -> dict[str, str]:
        return {
            "source": self.source,
            "source_listing_id": self.source_listing_id,
            "reason": self.reason,
        }


@dataclass
class IngestReport:
    received: int = 0
    written: int = 0
    rejected: list[RejectedRecord] = field(default_factory=list)
    dry_run: bool = False

    @property
    def rejected_count(self) -> int:
        return len(self.rejected)

    def to_dict(self) -> dict[str, Any]:
        return {
            "received": self.received,
            "written": self.written,
            "rejected": self.rejected_count,
            "dry_run": self.dry_run,
            "rejected_records": [record.to_dict() for record in self.rejected],
        }


def _utc_datetime(value: str | date | datetime) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _stable_id(prefix: str, *parts: str) -> str:
    digest = hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:24]
    return f"{prefix}_{digest}"


def _website_domain(website: Optional[str]) -> Optional[str]:
    if not website:
        return None
    parsed = urlparse(website if "://" in website else f"https://{website}")
    return parsed.netloc.lower().removeprefix("www.") or None


def _validate_listing(listing: DiscoveredListing) -> Optional[str]:
    if not listing.source.strip():
        return "source is required"
    if not listing.source_listing_id.strip():
        return "source_listing_id is required"
    if not listing.source_url.strip():
        return "source_url is required"
    parsed = urlparse(listing.source_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return "source_url must be an absolute HTTP(S) URL"
    if not listing.property_name.strip():
        return "property_name is required"
    if listing.advertised_price is not None and listing.advertised_price < 0:
        return "advertised_price cannot be negative"
    return None


def _facts(listing: DiscoveredListing) -> dict[str, Any]:
    """Return the allowlisted normalized record, including internal provenance facts."""
    return listing.to_record()


class PostgresIngestor:
    """Write normalized discovery listings and append-only observations."""

    def __init__(self, connection: Optional[Connection], *, parser_version: str = "acquisition-v1") -> None:
        self.connection = connection
        self.parser_version = parser_version
        self._registry_ids: dict[str, str] = {}
        self._state_codes: Optional[set[str]] = None

    def ingest(
        self,
        listings: Iterable[DiscoveredListing],
        *,
        observed_at: str | date | datetime,
        dry_run: bool = False,
        limit: Optional[int] = None,
    ) -> IngestReport:
        timestamp = _utc_datetime(observed_at)
        report = IngestReport(dry_run=dry_run)
        candidates = list(listings)
        if limit is not None:
            candidates = candidates[: max(0, limit)]
        report.received = len(candidates)

        for listing in candidates:
            reason = _validate_listing(listing)
            if reason:
                report.rejected.append(
                    RejectedRecord(listing.source, listing.source_listing_id, reason)
                )
                continue
            if dry_run:
                report.written += 1
                continue
            self._write_listing(listing, timestamp)
            report.written += 1

        if not dry_run:
            if self.connection is None:
                raise RuntimeError("a database connection is required unless --dry-run is set")
            try:
                self.connection.commit()
            except Exception:
                self.connection.rollback()
                raise
        return report

    def _write_listing(self, listing: DiscoveredListing, observed_at: datetime) -> None:
        if self.connection is None:
            raise RuntimeError("a database connection is required for database ingest")
        cursor = self.connection.cursor()
        try:
            registry_id = self._upsert_registry(cursor, listing.source)
            operator_id = self._upsert_operator(cursor, listing, observed_at)
            location_id = self._upsert_location(cursor, listing)
            facts = _facts(listing)
            provenance = {
                "source": listing.source,
                "source_url": listing.source_url,
                "source_listing_id": listing.source_listing_id,
                "observed_at": observed_at.isoformat(),
                "parser_version": self.parser_version,
                "layer": "DISCOVERY_SOURCE",
            }

            cursor.execute(
                '''
                INSERT INTO "ProspectListing" (
                  "id", "source", "sourceListingId", "sourceUrl", "operatorId",
                  "sourceRegistryId", "locationId", "city", "firstSeenAt",
                  "lastSeenAt", "advertisedPriceKobo", "currency", "priceBasis",
                  "bedrooms", "bathrooms", "area", "stateCode", "operatorKey",
                  "operatorName", "parserVersion", "normalizedAt", "rawFacts",
                  "provenance", "updatedAt"
                ) VALUES (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'UNKNOWN',
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, NOW()
                )
                ON CONFLICT ("source", "sourceListingId") DO UPDATE SET
                  "sourceUrl" = EXCLUDED."sourceUrl",
                  "operatorId" = COALESCE(EXCLUDED."operatorId", "ProspectListing"."operatorId"),
                  "sourceRegistryId" = EXCLUDED."sourceRegistryId",
                  "locationId" = COALESCE(EXCLUDED."locationId", "ProspectListing"."locationId"),
                  "city" = EXCLUDED."city",
                  "lastSeenAt" = EXCLUDED."lastSeenAt",
                  "advertisedPriceKobo" = EXCLUDED."advertisedPriceKobo",
                  "currency" = EXCLUDED."currency",
                  "bedrooms" = EXCLUDED."bedrooms",
                  "bathrooms" = EXCLUDED."bathrooms",
                  "area" = EXCLUDED."area",
                  "stateCode" = EXCLUDED."stateCode",
                  "operatorKey" = EXCLUDED."operatorKey",
                  "operatorName" = EXCLUDED."operatorName",
                  "parserVersion" = EXCLUDED."parserVersion",
                  "normalizedAt" = EXCLUDED."normalizedAt",
                  "rawFacts" = EXCLUDED."rawFacts",
                  "provenance" = EXCLUDED."provenance",
                  "updatedAt" = NOW()
                RETURNING "id"
                ''',
                (
                    _stable_id("sl", listing.source, listing.source_listing_id),
                    listing.source,
                    listing.source_listing_id,
                    listing.source_url,
                    operator_id,
                    registry_id,
                    location_id,
                    listing.city,
                    observed_at,
                    observed_at,
                    listing.advertised_price,
                    listing.currency or "NGN",
                    listing.bedrooms,
                    listing.bathrooms,
                    listing.area,
                    listing.state,
                    self._operator_key(listing),
                    listing.operator_name,
                    self.parser_version,
                    observed_at,
                    json.dumps(facts, ensure_ascii=False),
                    json.dumps(provenance, ensure_ascii=False),
                ),
            )
            source_listing_id = cursor.fetchone()
            if not source_listing_id:
                raise RuntimeError("source listing upsert returned no id")
            source_listing_pk = source_listing_id[0]

            cursor.execute(
                '''
                INSERT INTO "ProspectObservation" (
                  "id", "sourceListingId", "observedAt", "normalizedFacts",
                  "rawFacts", "provenance"
                ) VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb)
                ON CONFLICT ("sourceListingId", "observedAt") DO UPDATE SET
                  "normalizedFacts" = EXCLUDED."normalizedFacts",
                  "rawFacts" = EXCLUDED."rawFacts",
                  "provenance" = EXCLUDED."provenance"
                ''',
                (
                    _stable_id("obs", listing.source, listing.source_listing_id, observed_at.isoformat()),
                    source_listing_pk,
                    observed_at,
                    json.dumps(facts, ensure_ascii=False),
                    json.dumps(facts, ensure_ascii=False),
                    json.dumps(provenance, ensure_ascii=False),
                ),
            )

            if listing.advertised_price is not None:
                cursor.execute(
                    '''
                    INSERT INTO "PriceObservation" (
                      "id", "sourceListingId", "amountKobo", "currency", "basis",
                      "observedAt", "sourceUrl"
                    ) VALUES (%s, %s, %s, %s, 'UNKNOWN', %s, %s)
                    ON CONFLICT ("sourceListingId", "observedAt") DO UPDATE SET
                      "amountKobo" = EXCLUDED."amountKobo",
                      "currency" = EXCLUDED."currency",
                      "sourceUrl" = EXCLUDED."sourceUrl"
                    ''',
                    (
                        _stable_id("price", listing.source, listing.source_listing_id, observed_at.isoformat()),
                        source_listing_pk,
                        listing.advertised_price,
                        listing.currency or "NGN",
                        observed_at,
                        listing.source_url,
                    ),
                )
        except Exception:
            self.connection.rollback()
            raise
        finally:
            cursor.close()

    def _operator_key(self, listing: DiscoveredListing) -> Optional[str]:
        if not listing.operator_name:
            return None
        return build_operator_key(
            listing.operator_name,
            canonical_area(listing.area) or listing.area or "",
            listing.state or "",
        )

    def _upsert_registry(self, cursor: Cursor, source: str) -> str:
        cached = self._registry_ids.get(source)
        if cached:
            return cached
        registry_id = _stable_id("src", source)
        cursor.execute(
            '''
            INSERT INTO "SourceRegistry" ("id", "key", "displayName", "regions", "accessMethod", "updatedAt")
            VALUES (%s, %s, %s, %s, 'PUBLIC_WEB', NOW())
            ON CONFLICT ("key") DO UPDATE SET
              "displayName" = EXCLUDED."displayName",
              "updatedAt" = NOW()
            RETURNING "id"
            ''',
            (registry_id, source, source, []),
        )
        row = cursor.fetchone()
        if not row:
            raise RuntimeError("source registry upsert returned no id")
        self._registry_ids[source] = row[0]
        return row[0]

    def _upsert_operator(
        self, cursor: Cursor, listing: DiscoveredListing, observed_at: datetime
    ) -> Optional[str]:
        key = self._operator_key(listing)
        if not key:
            return None
        operator_id = _stable_id("op", key)
        state_code = listing.state if self._state_exists(cursor, listing.state) else None
        cursor.execute(
            '''
            INSERT INTO "Operator" (
              "id", "operatorKey", "displayName", "normalizedName", "phoneNormalized",
              "email", "websiteDomain", "stateCode", "firstSeenAt", "lastSeenAt", "updatedAt"
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT ("operatorKey") DO UPDATE SET
              "displayName" = COALESCE(EXCLUDED."displayName", "Operator"."displayName"),
              "phoneNormalized" = COALESCE(EXCLUDED."phoneNormalized", "Operator"."phoneNormalized"),
              "email" = COALESCE(EXCLUDED."email", "Operator"."email"),
              "websiteDomain" = COALESCE(EXCLUDED."websiteDomain", "Operator"."websiteDomain"),
              "lastSeenAt" = EXCLUDED."lastSeenAt",
              "updatedAt" = NOW()
            RETURNING "id"
            ''',
            (
                operator_id,
                key,
                listing.operator_name,
                normalise_operator_name(listing.operator_name or ""),
                normalise_phone(listing.phone) if listing.phone else None,
                listing.email,
                _website_domain(listing.website),
                state_code,
                observed_at,
                observed_at,
            ),
        )
        row = cursor.fetchone()
        return row[0] if row else None

    def _state_exists(self, cursor: Cursor, state_code: Optional[str]) -> bool:
        if not state_code:
            return False
        if self._state_codes is None:
            cursor.execute('SELECT "code" FROM "State"')
            self._state_codes = {row[0] for row in cursor.fetchall()}
        return state_code in self._state_codes

    def _upsert_location(self, cursor: Cursor, listing: DiscoveredListing) -> Optional[str]:
        if not listing.state or not listing.area or not self._state_exists(cursor, listing.state):
            return None
        name = canonical_area(listing.area) or listing.area
        normalized = slug(name)
        location_id = _stable_id("loc", listing.state, normalized)
        cursor.execute(
            '''
            INSERT INTO "Location" ("id", "stateCode", "name", "normalizedName", "city", "updatedAt")
            VALUES (%s, %s, %s, %s, %s, NOW())
            ON CONFLICT ("stateCode", "normalizedName") DO UPDATE SET
              "name" = EXCLUDED."name",
              "city" = COALESCE(EXCLUDED."city", "Location"."city"),
              "updatedAt" = NOW()
            RETURNING "id"
            ''',
            (location_id, listing.state, name, normalized, listing.city),
        )
        row = cursor.fetchone()
        return row[0] if row else location_id


def write_report(report: IngestReport, path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(report.to_dict(), handle, ensure_ascii=False, indent=2)
