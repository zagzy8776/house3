"""
Adapter interface. Every portal implements exactly this.

The point of the architecture is that adding portal number two is a new file,
not a new shape. A source adapter knows how to:

  1. DISCOVER  - enumerate candidate listing URLs (preferably from the site's own
                 sitemap, which is the path the publisher intends)
  2. PARSE     - turn one listing page into a `DiscoveredListing`

Everything after that - operator consolidation, dedupe, scoring, retention - is
source-agnostic and lives in normalization/ and the TypeScript domain. That is
what stops this becoming a pile of brittle per-site scripts.

TWO LAYERS, DELIBERATELY SEPARATE
---------------------------------
`sources/` is a DISCOVERY layer. It produces prospects. It cannot produce
bookable inventory, because there is no calendar and no agreement here.

Bookable inventory comes from a BOOKING layer - PARTNER_API, ICAL_FEED,
PARTNER_DASHBOARD, AFFILIATE_PROGRAM - which is guarded by `assertAuthorized()`
in src/inventory/types.ts.

A scraper is a valid DISCOVERY source and never a valid BOOKING source. One
registry rejecting the other's inputs is the whole disagreement resolved.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator, Optional, Protocol, runtime_checkable

from compliance.allowed_fields import assert_no_media_or_prose


class SourceLayer:
    """Which layer a source feeds. Never mixed."""

    DISCOVERY = "DISCOVERY_SOURCE"
    BOOKING = "BOOKING_SOURCE"


@dataclass
class DiscoveredListing:
    """
    One listing page, reduced to facts we are allowed to keep.

    Note there is no image field and no description field: they cannot be
    represented here, which is stronger than promising not to use them.
    """

    source: str
    source_url: str
    source_listing_id: str
    property_name: str
    property_type: Optional[str] = None
    bedrooms: Optional[int] = None
    bathrooms: Optional[int] = None
    advertised_price: Optional[int] = None
    currency: str = "NGN"
    state: Optional[str] = None
    city: Optional[str] = None
    area: Optional[str] = None
    operator_name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    instagram: Optional[str] = None
    pms_detected: Optional[str] = None
    booking_url: Optional[str] = None
    availability_url: Optional[str] = None
    title_document: Optional[str] = None

    def to_record(self) -> dict:
        """Serialise for the allowlist check, dropping unset fields."""
        raw = {
            "source": self.source,
            "source_url": self.source_url,
            "source_listing_id": self.source_listing_id,
            "property_name": self.property_name,
            "property_type": self.property_type,
            "bedrooms": self.bedrooms,
            "bathrooms": self.bathrooms,
            "advertised_price": self.advertised_price,
            "currency": self.currency,
            "state": self.state,
            "city": self.city,
            "area": self.area,
            "operator_name": self.operator_name,
            "phone": self.phone,
            "email": self.email,
            "website": self.website,
            "instagram": self.instagram,
            "pms_detected": self.pms_detected,
            "booking_url": self.booking_url,
            "availability_url": self.availability_url,
            "title_document": self.title_document,
        }
        return assert_no_media_or_prose({k: v for k, v in raw.items() if v is not None})


@runtime_checkable
class SourceAdapter(Protocol):
    """
    What every portal must implement. Two methods, both pure with respect to
    policy: they read, they never write anywhere.
    """

    #: Stable identifier used in provenance and dedupe.
    name: str
    layer: str
    #: The host whose robots.txt governs this adapter. Used by the pipeline to
    #: refuse an adapter pointed at a host it does not own.
    host: str

    def discover(self, transport, state_code: str, area: Optional[str] = None) -> Iterator[str]:
        """Yield candidate listing URLs for a state (and optionally one area)."""
        ...

    def parse(self, html: str, url: str) -> Optional[DiscoveredListing]:
        """Turn one page into a listing, or None if the page is not a listing."""
        ...


@dataclass
class AdapterRegistry:
    """Keeps the portal list explicit, and refuses a mislabelled layer."""

    _adapters: dict[str, SourceAdapter] = field(default_factory=dict)

    def register(self, adapter: SourceAdapter) -> None:
        if adapter.layer != SourceLayer.DISCOVERY:
            raise ValueError(
                f"'{adapter.name}' declares layer '{adapter.layer}'. sources/ is a "
                "DISCOVERY layer; bookable channels are registered in "
                "src/inventory/registry.ts."
            )
        self._adapters[adapter.name] = adapter

    def get(self, name: str) -> SourceAdapter:
        try:
            return self._adapters[name]
        except KeyError as exc:
            raise KeyError(f"unknown source '{name}'; registered: {sorted(self._adapters)}") from exc

    def names(self) -> list[str]:
        return sorted(self._adapters)

    def all(self) -> list[SourceAdapter]:
        return [self._adapters[name] for name in self.names()]
