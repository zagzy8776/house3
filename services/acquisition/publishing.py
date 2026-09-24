"""
The publishable projection.

WHAT THIS IS
------------
Turns a crawl into rows the public site can display. It is the difference
between a lead list and a directory.

FACTS, INCLUDING THE GALLERY

A directory publishes facts about a business: its name, its address, its phone
number, the prices it publishes, and the photographs it chose to show. House3
shows a guest the listing's own gallery, because a guest choosing a place to call
needs to see the place. Every row still carries `attribution` and links to
`source_url`, so the origin of every field - including every photograph - is one
click away.

This module used to drop `property_name` as "the operator's marketing copy" and
carry `media: null` as a declared feature. The media half of that decision has
been reversed by product decision and the reversal is recorded in
`compliance/allowed_fields.py`. PROSE IS STILL EXCLUDED: we display a listing's
photographs, we do not republish its written description - and `property_name`
is still dropped, for the reason below.

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
from urllib.parse import urlparse

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
        # provenance, required on every row
        "source",
        "source_url",
        # our own observation, not theirs
        "first_seen_at",
        "last_seen_at",
        # the property's own gallery, observed and attributed
        "media",
        "media_count",
        "cover_image_url",
        # public projection fields
        "id",
        "distribution",
        "attribution",
        "contact_route",
        "affiliate_partner",
        "affiliate_url",
        "affiliate_disclosure",
    }
)


#: Never published, whatever else changes. `property_name` is here because it is
#: the operator's marketing copy rather than a fact, so it stays internal for
#: dedupe and never appears in a public row. The crawl's booking/availability
#: URLs stay here too: observing a URL is not authorization to turn it into a
#: bookable or affiliate route.
NEVER_PUBLISHED = frozenset(
    {
        "property_name",
        "title_document",
        "source_listing_id",
        "booking_url",
        "availability_hint_url",
    }
)


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


def plausible_price_kobo(amount_kobo: Optional[int]) -> Optional[int]:
    """
    The advertised price, or None when the figure cannot be a nightly rate.

    Shared with `extraction.property.parse_price_to_kobo` so the ceiling is one
    constant rather than two that can drift. Applied a second time here because a
    row can arrive from records extracted before the guard existed.
    """
    from extraction.property import MAX_PLAUSIBLE_NIGHTLY_NAIRA

    if not isinstance(amount_kobo, int) or amount_kobo <= 0:
        return None
    if amount_kobo < 1_000 * 100:
        return None
    if amount_kobo > MAX_PLAUSIBLE_NIGHTLY_NAIRA * 100:
        return None
    return amount_kobo


def contact_route(listing: DiscoveredListing) -> Optional[dict]:
    """
    How a guest can reach the operator. Ordered by how directly it converts.

    Returned as a typed route rather than a bare string so the UI cannot render a
    phone number as a link to a website, and so a row with no route at all is
    detectable rather than silently blank.

    A crawled `booking_url` is deliberately ignored. Finding a booking link on a
    public page is not the same as being authorised to send guests down it, so
    only an explicitly authorised affiliate row may carry an `AFFILIATE_URL`.
    """
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

    The gallery is carried through. `media` is the listing's own photographs as
    absolute URLs, attributed to the source like every other field on the row, and
    `cover_image_url` is promoted so a card does not have to index the list.

    THE PRICE IS RE-CHECKED HERE, NOT ONLY AT EXTRACTION
    ----------------------------------------------------
    `parse_price_to_kobo` refuses an implausible figure when a page is parsed, but
    a directory can also be built from records extracted BEFORE that guard existed
    - which is exactly what happened: a re-publish carried NPC 3685973's mangled
    `145,888,581` straight through, because re-publishing must be lossless and
    therefore must not silently rewrite values. The ceiling is applied here as well
    so a stored artefact cannot reach a guest on the second pass. A price that
    fails the check is dropped, which the UI renders as "rate not published" -
    true, and better than a number nobody should believe.
    """
    raw = {
        "operator_name": listing.operator_name,
        "phone": listing.phone,
        "email": listing.email,
        "website": listing.website,
        "instagram": listing.instagram,
        "pms_detected": listing.pms_detected,
        "property_type": listing.property_type,
        "bedrooms": listing.bedrooms,
        "bathrooms": listing.bathrooms,
        "state": listing.state,
        "city": listing.city,
        "area": listing.area,
        "advertised_price": plausible_price_kobo(listing.advertised_price),
        "currency": listing.currency,
        "source": listing.source,
        "source_url": listing.source_url,
        "media": list(listing.media) or None,
        "media_count": len(listing.media) or None,
        "cover_image_url": listing.cover_image_url,

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

    Crawled listings are always `DIRECTORY` rows. A `booking_url` found while
    crawling is deliberately not promoted to a booking button: discovering a
    URL is not affiliate authorization. Affiliate rows enter through an
    authorized partner feed, represented separately by `to_affiliate_row()`.

    Each row carries the listing's own gallery: `media` is a list of absolute
    image URLs attributed to the source like every other field, and
    `cover_image_url` is the first of them. A row with no `media` published no
    photographs, which the UI renders as a placeholder rather than as a broken
    image.
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

        row = assert_publishable(
            {
                **row,
                "id": f"{listing.source}:{listing.source_listing_id}",
                "distribution": "DIRECTORY",
                "contact_route": route,
                "attribution": attribution,
            }
        )
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


def to_affiliate_row(
    *,
    id: str,
    operator_name: Optional[str],
    phone: Optional[str],
    email: Optional[str],
    website: Optional[str],
    property_type: Optional[str],
    bedrooms: Optional[int],
    bathrooms: Optional[int],
    state: Optional[str],
    city: Optional[str],
    area: Optional[str],
    advertised_price: Optional[int],
    currency: Optional[str],
    source: str,
    source_url: str,
    attribution: str,
    first_seen_at: str,
    last_seen_at: str,
    affiliate_partner: str,
    affiliate_url: str,
    affiliate_disclosure: str,
) -> dict:
    """Build one row from an authorized affiliate feed, never from a crawl.

    The destination must already be the partner's approved tracking/deep link.
    This function does not turn a public `booking_url` into an affiliate link;
    the caller must possess the affiliate programme authorization and provide the
    handoff explicitly.
    """
    if not isinstance(id, str) or not id.strip():
        raise PolicyViolation("Affiliate row requires a non-empty id")
    if not all(isinstance(value, str) and value.strip() for value in (source, source_url, attribution)):
        raise PolicyViolation("Affiliate row requires source, source URL and attribution")
    if not isinstance(affiliate_partner, str) or not affiliate_partner.strip():
        raise PolicyViolation("Affiliate row requires a partner name")
    if not isinstance(affiliate_disclosure, str) or not affiliate_disclosure.strip():
        raise PolicyViolation("Affiliate row requires a price disclosure")
    if not isinstance(first_seen_at, str) or not first_seen_at.strip():
        raise PolicyViolation("Affiliate row requires a first-seen date")
    if not isinstance(last_seen_at, str) or not last_seen_at.strip():
        raise PolicyViolation("Affiliate row requires a last-seen date")
    if not isinstance(affiliate_url, str):
        raise PolicyViolation("Affiliate destination must be an absolute HTTP(S) URL")
    parsed_destination = urlparse(affiliate_url)
    if parsed_destination.scheme not in {"http", "https"} or not parsed_destination.netloc:
        raise PolicyViolation("Affiliate destination must be an absolute HTTP(S) URL")

    route = {"kind": "AFFILIATE_URL", "href": affiliate_url}
    row = {
        "id": id,
        "distribution": "AFFILIATE",
        "operator_name": operator_name,
        "phone": phone,
        "email": email,
        "website": website,
        "property_type": property_type,
        "bedrooms": bedrooms,
        "bathrooms": bathrooms,
        "state": state,
        "city": city,
        "area": area,
        "advertised_price": advertised_price,
        "currency": currency,
        "source": source,
        "source_url": source_url,
        "attribution": attribution,
        "first_seen_at": first_seen_at,
        "last_seen_at": last_seen_at,
        "affiliate_partner": affiliate_partner,
        "affiliate_url": affiliate_url,
        "affiliate_disclosure": affiliate_disclosure,
        "contact_route": route,
    }
    return assert_publishable({key: value for key, value in row.items() if value is not None})
