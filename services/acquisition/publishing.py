"""
The publishable projection.

WHAT THIS IS
------------
Turns a crawl into rows the public site can display. It is the difference
between a lead list and a directory.

WHY FACTS ARE PUBLISHABLE AND PHOTOGRAPHS ARE NOT
-------------------------------------------------
A directory is legal. Yelp does not need a licence to say "Adeniyi Jones
Residences, Lekki, phone number, opens at 9". Facts about a business are not
owned by anyone: its name, its address, its phone number, its published prices.
We watched an operator advertise a 3-bedroom in Lekki at 220,000 a night. That
happened, we saw it, and we can say so.

A photograph is different. It is a creative work with an owner, and republishing
it is not made lawful by the fact that it was reachable. That holds whether we
fetched the page ourselves or paid an API to fetch it.

So this module publishes operator identity, location, size and advertised rate,
attributes every row to its source, and links the guest to the operator. Media
is `null` in the output, declared rather than merely absent, because "we have no
photographs of this place yet" is a fact about the row that the UI should be
able to render and the claim flow is built on.

WHAT IS DELIBERATELY EXCLUDED
-----------------------------
`property_name` is dropped even though it is on the allowlist. Listing titles are
the operator's marketing copy - "Luxury 3 Bedrooms Flats with City View" - and
they are worth nothing to a guest. "3-bedroom flat, Lekki Phase 1, 220,000 a
night" is both more useful and unambiguously fact. No trade-off.

Nothing here reads the network. The publishable set is derived from fields the
extraction layer already cleared, and it is checked again on the way out.
"""

from __future__ import annotations

from typing import Iterable, Optional

from compliance.allowed_fields import PolicyViolation
from normalization.dedupe import OperatorProfile
from sources.base import DiscoveredListing

#: The only fields a public directory row may expose. Narrower than
#: ALLOWED_FIELDS on purpose: an internal extraction field is not automatically
#: something we want on a public page.
PUBLISHABLE_FIELDS = frozenset(
    {
        # the operator - facts about a business
        "operator_name",
        "phone",
        "email",
        "website",
        "instagram",
        "pms_detected",
        "booking_url",
        # where and how big - facts about the property
        "property_type",
        "bedrooms",
        "bathrooms",
        "state",
        "city",
        "area",
        # what they asked - a published price, attributed
        "advertised_price",
        "currency",
        # our own observation, not theirs
        "first_seen_at",
        "last_seen_at",
        # provenance, required on every row
        "source",
        "source_url",
    }
)

#: Never published, whatever else changes. `property_name` is here because it is
#: the operator's marketing copy rather than a fact, so it stays internal for
#: dedupe and never appears in a public row.
NEVER_PUBLISHED = frozenset({"property_name", "title_document", "source_listing_id"})


def assert_publishable(record: dict) -> dict:
    """
    Refuse to emit a row containing anything outside the publishable set.

    Fails on undeclared fields as well as forbidden ones, matching the rule the
    extraction layer already enforces: putting something new on a public page
    should be a deliberate addition here, not a side effect of a parser change.
    """
    leaked = set(record) & NEVER_PUBLISHED
    if leaked:
        raise PolicyViolation(
            f"Directory row contains non-publishable fields: {sorted(leaked)}. "
            "Property titles are the operator's copy, not facts."
        )

    undeclared = set(record) - PUBLISHABLE_FIELDS
    if undeclared:
        raise PolicyViolation(
            f"Directory row contains undeclared fields: {sorted(undeclared)}. "
            "Add them to PUBLISHABLE_FIELDS deliberately, or drop them."
        )

    return record


def contact_route(listing: DiscoveredListing) -> Optional[dict]:
    """
    How a guest can reach the operator. Ordered by how directly it converts.

    Returned as a typed route rather than a bare string so the UI cannot render a
    phone number as a link to a website, and so a row with no route at all is
    detectable rather than silently blank.
    """
    if listing.booking_url:
        return {"kind": "BOOKING_URL", "href": listing.booking_url}
    if listing.phone:
        return {"kind": "PHONE", "href": f"tel:{listing.phone.replace(' ', '')}"}
    if listing.website:
        return {"kind": "WEBSITE", "href": listing.website}
    if listing.email:
        return {"kind": "EMAIL", "href": f"mailto:{listing.email}"}
    return None


def to_place_row(listing: DiscoveredListing, observed_on: str) -> dict:
    """
    One directory row for one place.

    Attribute-or-drop: every optional field is omitted rather than nulled, so a
    row never carries a placeholder the UI might render as real information.
    """
    raw = {
        "operator_name": listing.operator_name,
        "phone": listing.phone,
        "email": listing.email,
        "website": listing.website,
        "instagram": listing.instagram,
        "pms_detected": listing.pms_detected,
        "booking_url": listing.booking_url,
        "property_type": listing.property_type,
        "bedrooms": listing.bedrooms,
        "bathrooms": listing.bathrooms,
        "state": listing.state,
        "city": listing.city,
        "area": listing.area,
        "advertised_price": listing.advertised_price,
        "currency": listing.currency,
        "source": listing.source,
        "source_url": listing.source_url,
        # Our own observation dates, not theirs.
        "first_seen_at": observed_on,
        "last_seen_at": observed_on,
    }
    row = {key: value for key, value in raw.items() if value is not None}
    return assert_publishable(row)


def build_directory(
    listings: Iterable[DiscoveredListing],
    observed_on: str,
    *,
    attribution: str,
) -> dict:
    """
    The whole public directory for one run.

    Deduplicated by source listing id, because a crawl that walks both a sitemap
    and a list page will see the same place twice, and a directory that shows a
    place twice is worse than one that shows it once.

    `media` is declared null on every row rather than omitted. A guest should be
    able to tell the difference between "this place has no photographs we may
    show" and "this page failed to load them", and the claim flow exists to
    change the first into photographs.
    """
    seen: dict[str, dict] = {}
    for listing in listings:
        if listing.source_listing_id in seen:
            continue

        row = to_place_row(listing, observed_on)
        route = contact_route(listing)
        if route is None:
            # Still emitted: the operator is real and the place exists. It ranks
            # below contactable rows and is a prompt to go and find a channel.
            route = {"kind": "NONE", "href": None}

        row["id"] = f"{listing.source}:{listing.source_listing_id}"
        row["contact_route"] = route
        row["attribution"] = attribution
        seen[listing.source_listing_id] = row

    places = sorted(seen.values(), key=lambda entry: (entry["contact_route"]["kind"] == "NONE",))

    return {
        "generated_at": observed_on,
        "attribution": attribution,
        "counts": {
            "places": len(places),
            "contactable": sum(1 for entry in places if entry["contact_route"]["kind"] != "NONE"),
        },
        "media": None,
        "places": places,
    }
