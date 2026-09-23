"""The observation ledger, read from the database.

WHY THE DATABASE AND NOT A FILE
-------------------------------
Change detection answers "what is different since last time", and that is only a
true answer if every crawler shares one history. A JSONL file on one machine
cannot be that: run Lagos on Monday from a laptop and Abuja on Tuesday from CI,
and each run believes it has never seen anything, so every listing looks new and
every disappearance is invisible. The ledger is therefore the observation tables
themselves:

    SourceListing       one row per listing ever seen, keyed (source, sourceListingId)
    SourceObservation   one row per listing per day: presence, plus the facts seen
    PriceObservation    the advertised figure and its basis, per day

`PostgresIngestor` writes them; this module reads them back. Writes and reads are
deliberately owned in one place each - the ingestor owns the shape of a write,
this module owns the shape of a read, and neither invents the other's columns.

Two crawlers observing one listing on the same day converge on one row:
`@@unique([sourceListingId, observedAt])` makes the second an upsert, not a
duplicate. That is what lets Lagos, FCT and Oyo run concurrently.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ingest.postgres import Connection
from normalization.history import ListingHistory, Observation

#: One row per (listing, day) of presence, with that day's price where there was
#: one. Driven by SourceObservation and not PriceObservation: a listing with no
#: advertised figure is still an observation, and a ledger built only from priced
#: rows would call every price-less listing new on every crawl.
#:
#: Note the two meanings of "sourceListingId" here, which the schema inherits from
#: the original prospect tables: on SourceObservation it is a foreign key to
#: ProspectListing.id (our id), while on ProspectListing it is the *portal's* own
#: listing reference. The join below is on the former, the projection is the latter.
LEDGER_QUERY = '''
    SELECT sl."source",
           sl."sourceListingId",
           so."observedAt",
           po."amountKobo",
           so."normalizedFacts"->>'currency' AS currency,
           so."normalizedFacts"->>'bedrooms' AS bedrooms,
           so."normalizedFacts"->>'area'     AS area
    FROM "ProspectObservation" so
    JOIN "ProspectListing" sl ON sl."id" = so."sourceListingId"
    LEFT JOIN "PriceObservation" po
           ON po."sourceListingId" = so."sourceListingId"
          AND po."observedAt" = so."observedAt"
    ORDER BY sl."source", sl."sourceListingId", so."observedAt"
'''


def _iso_date(value: Any) -> str:
    """An ISO date for a timestamp column, whatever the driver hands back."""
    if isinstance(value, datetime):
        return value.date().isoformat()
    return str(value)[:10]


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


@dataclass
class PostgresLedger:
    """The shared observation ledger, read from PostgreSQL."""

    connection: Connection

    def load(self) -> list[ListingHistory]:
        """Replay every observation into per-listing histories, oldest first."""
        cursor = self.connection.cursor()
        try:
            cursor.execute(LEDGER_QUERY)
            rows = cursor.fetchall()
        finally:
            cursor.close()
        return self.histories_from(rows)

    @staticmethod
    def histories_from(rows: list[tuple[Any, ...]]) -> list[ListingHistory]:
        """Group ledger rows into histories. Pure, so it is testable without a driver."""
        grouped: dict[tuple[str, str], list[Observation]] = {}
        for source, source_listing_id, observed_at, amount, currency, bedrooms, area in rows:
            observation = Observation(
                source=source,
                source_listing_id=str(source_listing_id),
                observed_on=_iso_date(observed_at),
                advertised_price=_optional_int(amount),
                currency=currency or "NGN",
                bedrooms=_optional_int(bedrooms),
                area=area,
            )
            grouped.setdefault(observation.key, []).append(observation)

        histories: list[ListingHistory] = []
        for key, observations in grouped.items():
            history = ListingHistory(source=key[0], source_listing_id=key[1])
            # Sorted, so a ledger written out of order still replays into a
            # correct price history rather than a scrambled one.
            for observation in sorted(observations, key=lambda o: o.observed_on):
                history.add(observation)
            histories.append(history)
        return histories
