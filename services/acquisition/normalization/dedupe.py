"""
Operator consolidation: many listings -> one operator.

This is the step that turns a crawl into a call list. Without it an operator with
twelve units appears twelve times, the outreach team phones the same person
repeatedly, and the pipeline looks like it found twelve times more supply than it
did.

The work is a connected-components problem, not a pairwise dedupe, because
matching is transitive through a listing:

    Listing A  phone   0803...            \\
    Listing B  phone   0803...            /  same phone -> one component
    Listing C  email   bookings@...
               ^ C shares nothing with A except through B.

A pairwise comparison misses that. So we build a graph and take components.

Signals are weighted, because they are not equally trustworthy:

  STRONG  phone, email, website domain  - a business identifier. Union always.
  WEAK    normalised name + area        - normally right, occasionally merges
                                          two unrelated "Prime Suites".

Weak matches are still unioned, but the evidence is recorded on the operator, so
a human reviewing the call list can see why two listings were treated as one
business - and split them if the machine was wrong.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional
from urllib.parse import urlparse

from normalization.addresses import canonical_area
from normalization.names import normalise_operator_name, operator_key
from normalization.phones import normalise_phone, phone_dedupe_key

from sources.base import DiscoveredListing

#: Domains that are never an operator identity.
NON_OPERATOR_DOMAINS = frozenset(
    {
        "nigeriapropertycentre.com",
        "propertypro.ng",
        "jiji.ng",
        "facebook.com",
        "instagram.com",
        "wa.me",
        "whatsapp.com",
        "google.com",
    }
)


@dataclass
class MatchEvidence:
    """Why two listings were judged to be the same operator."""

    kind: str  # STRONG | WEAK
    signal: str  # e.g. "phone", "name+area"
    value: str
    listing_ids: tuple[str, str]


@dataclass
class OperatorProfile:
    """One operator, consolidated from every listing observed for it."""

    operator_id: str
    display_name: str
    listing_ids: list[str] = field(default_factory=list)
    source_urls: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    emails: list[str] = field(default_factory=list)
    websites: list[str] = field(default_factory=list)
    instagrams: list[str] = field(default_factory=list)
    areas: list[str] = field(default_factory=list)
    states: list[str] = field(default_factory=list)
    property_types: list[str] = field(default_factory=list)
    prices_kobo: list[int] = field(default_factory=list)
    pms_detected: list[str] = field(default_factory=list)
    availability_urls: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    evidence: list[MatchEvidence] = field(default_factory=list)

    @property
    def listing_count(self) -> int:
        return len(self.listing_ids)

    @property
    def area_count(self) -> int:
        return len(self.areas)

    @property
    def has_direct_booking(self) -> bool:
        return bool(self.websites or self.availability_urls or self.pms_detected)

    def to_lead(self) -> dict:
        """Shape for the TypeScript lead engine, matching src/domain/lead.ts."""
        return {
            "operatorId": self.operator_id,
            "displayName": self.display_name,
            "listingCount": self.listing_count,
            "observedNightlyRatesKobo": sorted(set(self.prices_kobo)),
            "areas": self.areas,
            "states": self.states,
            "propertyTypes": self.property_types,
            "contact": {
                "phone": self.phones[0] if self.phones else None,
                "email": self.emails[0] if self.emails else None,
                "website": self.websites[0] if self.websites else None,
                "instagram": self.instagrams[0] if self.instagrams else None,
            },
            "pmsFingerprints": self.pms_detected,
            "allPhones": self.phones,
            "allEmails": self.emails,
            "sourceUrls": self.source_urls,
            "sources": self.sources,
            "matchEvidence": [entry.signal for entry in self.evidence],
        }


def domain_of(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    host = urlparse(url).netloc.lower().replace("www.", "")
    if not host or any(host.endswith(bad) for bad in NON_OPERATOR_DOMAINS):
        return None
    return host


def strong_keys(listing: DiscoveredListing) -> set[str]:
    """Business identifiers. A shared one means the same operator, confidently."""
    keys: set[str] = set()

    phone = phone_dedupe_key(normalise_phone(listing.phone))
    if phone:
        keys.add(f"phone:{phone}")

    if listing.email and "@" in listing.email:
        email = listing.email.strip().lower()
        keys.add(f"email:{email}")
        # The registrable domain of a business address is the same business as
        # that domain's website, so "bookings@lekkihomes.com" and
        # "https://lekkihomes.com" are one operator, not two.
        domain = domain_of(f"https://{email.split('@', 1)[1]}")
        if domain:
            keys.add(f"domain:{domain}")

    domain = domain_of(listing.website)
    if domain:
        keys.add(f"domain:{domain}")

    return keys


def key_signal(key: str) -> str:
    """The signal a match key represents, for the evidence record."""
    return key.split(":", 1)[0]


def weak_keys(listing: DiscoveredListing) -> set[str]:
    """A name in a place. Usually the same business, occasionally not."""
    if not listing.operator_name:
        return set()
    area = canonical_area(listing.area) or listing.area or ""
    name = normalise_operator_name(listing.operator_name)
    if not name:
        return set()
    return {f"name:{operator_key(name, area, listing.state or '')}"}


class _UnionFind:
    """Disjoint sets. Path-halving on find, which is plenty at this scale."""

    def __init__(self) -> None:
        self.parent: dict[int, int] = {}

    def find(self, item: int) -> int:
        self.parent.setdefault(item, item)
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, a: int, b: int) -> None:
        root_a, root_b = self.find(a), self.find(b)
        if root_a != root_b:
            self.parent[root_b] = root_a


def consolidate(listings: Iterable[DiscoveredListing]) -> list[OperatorProfile]:
    """
    Group listings into operators and build one profile per operator.

    Listings with no operator signal still produce a profile keyed on their own
    listing id. They score low, but dropping them would hide real inventory from
    the funnel counts.
    """
    items = list(listings)
    if not items:
        return []

    uf = _UnionFind()
    for index in range(len(items)):
        uf.find(index)

    evidence: list[MatchEvidence] = []

    def union_by(key_fn: Callable[[DiscoveredListing], set[str]], kind: str) -> None:
        buckets: dict[str, list[int]] = {}
        for index, item in enumerate(items):
            for key in key_fn(item):
                buckets.setdefault(key, []).append(index)

        for key, members in buckets.items():
            if len(members) < 2:
                continue
            # The signal is derived from the key itself, never passed in. An
            # earlier version labelled every strong match "phone" because the
            # label was a parameter, which made the evidence record lie about
            # why two listings were merged.
            signal = key_signal(key)
            # Every member joins the first, which is what makes the merge
            # transitive through a middle listing.
            anchor = members[0]
            for other in members[1:]:
                if uf.find(anchor) != uf.find(other):
                    evidence.append(
                        MatchEvidence(
                            kind=kind,
                            signal=signal,
                            value=key.split(":", 1)[1],
                            listing_ids=(
                                items[anchor].source_listing_id,
                                items[other].source_listing_id,
                            ),
                        )
                    )
                uf.union(anchor, other)

    # Strong signals first, so a component is anchored by a real business
    # identifier before weaker evidence is allowed to attach anything to it.
    # One pass, because the signal comes from the key.
    union_by(strong_keys, "STRONG")
    union_by(weak_keys, "WEAK")

    components: dict[int, list[int]] = {}
    for index in range(len(items)):
        components.setdefault(uf.find(index), []).append(index)

    profiles = [_build_profile([items[i] for i in members], evidence) for members in components.values()]
    profiles.sort(key=lambda profile: profile.listing_count, reverse=True)
    return profiles


def _build_profile(members: list[DiscoveredListing], evidence: list[MatchEvidence]) -> OperatorProfile:
    member_ids = {listing.source_listing_id for listing in members}

    # Prefer a real operator name over a property name.
    named = [listing.operator_name for listing in members if listing.operator_name]
    display_name = _best_name(named) or members[0].property_name

    areas: list[str] = []
    for listing in members:
        canonical = canonical_area(listing.area)
        if canonical and canonical not in areas:
            areas.append(canonical)

    prices = [listing.advertised_price for listing in members if listing.advertised_price]
    primary_area = areas[0] if areas else ""
    primary_state = members[0].state or ""

    return OperatorProfile(
        operator_id=operator_key(display_name, primary_area, primary_state),
        display_name=display_name,
        listing_ids=[listing.source_listing_id for listing in members],
        source_urls=[listing.source_url for listing in members],
        phones=_unique([normalise_phone(listing.phone) for listing in members if listing.phone]),
        emails=_unique([listing.email for listing in members if listing.email]),
        websites=_unique([listing.website for listing in members if listing.website]),
        instagrams=_unique([listing.instagram for listing in members if listing.instagram]),
        areas=areas,
        states=_unique([listing.state for listing in members if listing.state]),
        property_types=_unique([listing.property_type for listing in members if listing.property_type]),
        prices_kobo=prices,
        pms_detected=_unique([listing.pms_detected for listing in members if listing.pms_detected]),
        availability_urls=_unique(
            [listing.availability_url for listing in members if listing.availability_url]
        ),
        sources=_unique([listing.source for listing in members]),
        evidence=[entry for entry in evidence if set(entry.listing_ids) & member_ids],
    )


def _best_name(names: list[str]) -> Optional[str]:
    """Longest plausible name wins: 'Lekki Homes Ltd' over a domain hint 'Lekki'."""
    if not names:
        return None
    return max(names, key=len).strip()


def _unique(values: list[Optional[str]]) -> list[str]:
    seen: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.append(value)
    return seen
