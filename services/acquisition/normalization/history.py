"""
Listing history and change detection.

The funnel in pipeline.py tells you what exists right now. It cannot tell you
what changed, which is most of the value:

  * a listing that appeared this week is a new operator, or an operator testing
    a rate - both worth a call
  * a rate that has moved twice in a month is an operator whose pricing we can
    actually say something useful about when we call them
  * a listing that disappeared was let, withdrawn, or moved to a platform with
    better reach - which is the sharpest acquisition signal we have

So every crawl writes an observation rather than overwriting a row, and the
differences between two observations are computed here.

Deliberately NOT built: a "views" or "popularity" counter. We cannot observe how
many people viewed someone else's listing - that number lives in their analytics
and is not on the page. Inferring it from position, or from how often a listing
appears, would be inventing a metric and then presenting it as measured. What we
can measure honestly is presence, absence and advertised price, so that is all
this module produces.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Iterable, Optional

#: A listing we do not see for this many days is treated as gone. Portals
#: re-order and paginate unpredictably, so a single miss is not evidence.
DEFAULT_DELIST_GRACE_DAYS = 7


@dataclass(frozen=True)
class Observation:
    """One sighting of one listing, on one day."""

    source: str
    source_listing_id: str
    observed_on: str  # ISO date, YYYY-MM-DD
    advertised_price: Optional[int] = None
    currency: str = "NGN"
    bedrooms: Optional[int] = None
    area: Optional[str] = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.source, self.source_listing_id)

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "source_listing_id": self.source_listing_id,
            "observed_on": self.observed_on,
            "advertised_price": self.advertised_price,
            "currency": self.currency,
            "bedrooms": self.bedrooms,
            "area": self.area,
        }


@dataclass
class ListingHistory:
    """Every sighting of one listing, oldest first."""

    source: str
    source_listing_id: str
    observations: list[Observation] = field(default_factory=list)

    def add(self, observation: Observation) -> None:
        if observation.key != (self.source, self.source_listing_id):
            raise ValueError("observation does not belong to this history")
        if not self.observations:
            self.observations.append(observation)
            return

        # Same day observed twice is one observation, not two. Without this, a
        # re-run inside a day would look like a duplicate listing.
        if observation.observed_on == self.observations[-1].observed_on:
            self.observations[-1] = observation
            return

        self.observations.append(observation)

    @property
    def key(self) -> tuple[str, str]:
        return (self.source, self.source_listing_id)

    @property
    def first_seen(self) -> str:
        return self.observations[0].observed_on

    @property
    def last_seen(self) -> str:
        return self.observations[-1].observed_on

    @property
    def latest(self) -> Observation:
        return self.observations[-1]

    def days_on_market(self, today: Optional[str] = None) -> int:
        """
        Days between first sighting and now.

        Reported as "at least" wherever it is displayed, because it is a floor:
        the listing existed before we found it, by an unknown amount.
        """
        start = date.fromisoformat(self.first_seen)
        end = date.fromisoformat(today) if today else date.today()
        return max(0, (end - start).days)

    def price_history(self) -> list[tuple[str, Optional[int]]]:
        return [(o.observed_on, o.advertised_price) for o in self.observations]

    def price_changes(self) -> list["PriceChange"]:
        changes: list[PriceChange] = []
        for earlier, later in zip(self.observations, self.observations[1:]):
            if earlier.advertised_price is None or later.advertised_price is None:
                continue
            if earlier.advertised_price == later.advertised_price:
                continue
            changes.append(
                PriceChange(
                    source=self.source,
                    source_listing_id=self.source_listing_id,
                    on=later.observed_on,
                    previous=earlier.advertised_price,
                    current=later.advertised_price,
                )
            )
        return changes


@dataclass(frozen=True)
class PriceChange:
    source: str
    source_listing_id: str
    on: str
    previous: int
    current: int

    @property
    def delta(self) -> int:
        return self.current - self.previous

    @property
    def direction(self) -> str:
        return "cut" if self.delta < 0 else "rise"

    def percent(self) -> float:
        if self.previous == 0:
            return 0.0
        return round(self.delta / self.previous * 100, 1)

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "source_listing_id": self.source_listing_id,
            "on": self.on,
            "previous": self.previous,
            "current": self.current,
            "direction": self.direction,
            "percent": self.percent(),
        }


@dataclass
class ChangeSet:
    """What one crawl changed, relative to what we already knew."""

    new_listings: list[Observation] = field(default_factory=list)
    price_changes: list[PriceChange] = field(default_factory=list)
    delisted: list[Observation] = field(default_factory=list)
    unchanged: list[Observation] = field(default_factory=list)

    @property
    def observed(self) -> int:
        return len(self.new_listings) + len(self.unchanged) + len(self.price_changes)

    def summary(self) -> dict:
        return {
            "new_listings": len(self.new_listings),
            "price_changes": len(self.price_changes),
            "delisted": len(self.delisted),
            "unchanged": len(self.unchanged),
        }


def detect_changes(
    previous: Iterable[ListingHistory],
    current: Iterable[Observation],
    *,
    today: Optional[str] = None,
    delist_grace_days: int = DEFAULT_DELIST_GRACE_DAYS,
) -> ChangeSet:
    """
    Diff this crawl against everything we knew before.

    A listing counts as delisted only once it has been missing for longer than
    the grace period. Portals reorder, filtrations change, and a crawl that
    stopped early all look identical to a listing being withdrawn on the day it
    happens, so the grace period is what separates a signal from a rumour.
    """
    known = {history.key: history for history in previous}
    today_iso = today or date.today().isoformat()

    changes = ChangeSet()
    seen_now: set[tuple[str, str]] = set()

    for observation in current:
        seen_now.add(observation.key)
        history = known.get(observation.key)

        if history is None:
            changes.new_listings.append(observation)
            continue

        history.add(observation)
        found = history.price_changes()
        if found and found[-1].on == observation.observed_on:
            changes.price_changes.append(found[-1])
        else:
            changes.unchanged.append(observation)

    for key, history in known.items():
        if key in seen_now:
            continue
        gone_for = _days_between(history.last_seen, today_iso)
        if gone_for > delist_grace_days:
            changes.delisted.append(history.latest)

    return changes


def _days_between(start_iso: str, end_iso: str) -> int:
    return (date.fromisoformat(end_iso) - date.fromisoformat(start_iso)).days
