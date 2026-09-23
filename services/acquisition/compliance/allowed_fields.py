"""
Field allowlist - the wall between a crawler and someone else's copyright.

Crawling is one permission; copyright is another. nigeriapropertycentre.com's
robots.txt permits us to fetch their pages. It does not grant a licence to their
photographs or their written descriptions, so this module makes it structurally
impossible for a parser to hand those to us.

`assert_no_media_or_prose()` runs at the boundary between extraction and storage.
A parser that over-reaches fails the run loudly rather than quietly writing a
photographer's work into a database.
"""

from __future__ import annotations


class PolicyViolation(RuntimeError):
    """Raised when a fetch or an extraction would breach policy."""


#: The only fields that may leave the extraction layer.
ALLOWED_FIELDS = frozenset(
    {
        # listing-level facts
        "source",
        "source_url",
        "source_listing_id",
        "property_name",
        "property_type",
        "bedrooms",
        "bathrooms",
        "advertised_price",
        "currency",
        "state",
        "city",
        "area",
        "first_seen_at",
        "last_seen_at",
        # operator-level signals
        "operator_name",
        "phone",
        "email",
        "website",
        "instagram",
        "pms_detected",
        "booking_url",
        "availability_url",
        "title_document",
    }
)

#: Never extracted, never stored. Named explicitly so the exclusion is a decision
#: on record rather than an oversight.
FORBIDDEN_FIELDS = frozenset(
    {
        "photo",
        "photos",
        "image",
        "images",
        "gallery",
        "photo_count",
        "description",
        "body_text",
        "summary",
        "review_text",
        "agent_name",
        "agent_photo",
    }
)


def assert_no_media_or_prose(record: dict) -> dict:
    """
    Reject a record containing a forbidden or undeclared field.

    Deliberately fails on *undeclared* fields too: a new field should be a
    conscious addition to ALLOWED_FIELDS, not something that slips through
    because a parser started emitting it.
    """
    for key in record:
        if key in FORBIDDEN_FIELDS:
            raise PolicyViolation(
                f"Extraction produced forbidden field '{key}'. This service collects "
                "operator identity and advertised rates only - never media or copy."
            )

    unknown = set(record) - ALLOWED_FIELDS
    if unknown:
        raise PolicyViolation(
            f"Extraction produced undeclared fields: {sorted(unknown)}. "
            "Add them to ALLOWED_FIELDS deliberately, or drop them."
        )

    return record
