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

import re


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
        # A name inferred from a domain rather than stated by the source. Declared
        # deliberately: it is a business hint the entity-resolution step weighs, not
        # an identity and not personal data. `agent_name` stays forbidden.
        "operator_hint",
        "phone",
        "email",
        "website",
        "instagram",
        "pms_detected",
        "booking_url",
        # An availability link, explicitly unverified. Named for what it is so
        # nothing downstream mistakes it for a calendar endpoint.
        "availability_hint_url",
        # The unit an advertised price is quoted in (PER_NIGHT, PER_MONTH, ...).
        "price_basis",
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


# ---------------------------------------------------------------------------
# media stripping - the guard that runs before a parser ever sees the page
# ---------------------------------------------------------------------------

#: Container elements whose entire contents go, so no orphaned captions remain.
_MEDIA_CONTAINER_RE = re.compile(
    r"<(picture|figure|video|audio|object|embed)\b[^>]*>.*?</\1\s*>",
    re.IGNORECASE | re.DOTALL,
)

#: Void elements are self-closing, so they need their own pattern.
_MEDIA_VOID_RE = re.compile(r"<(img|source|track)\b[^>]*>", re.IGNORECASE)

#: Any reference anywhere in the document that points at an image asset. This is
#: the blunt instrument, and it is the one that matters: it catches attributes,
#: CSS url(), inline JSON blobs and data-* attributes without us having to
#: enumerate every way a developer can reference a file.
#:
#: Three forms, because the first version only caught the first and left every
#: root-relative path behind - which on a real portal is most of them:
#:
#:   https://cdn.x/1.jpg   absolute or protocol-relative
#:   /media/2.png          root-relative, and any path ending in an extension
#:   hero.webp             a bare filename, e.g. inside a srcset
_IMAGE_URL_RE = re.compile(
    r"""
    (?:
        (?:https?:)?//[^\s"'<>()\\]+      # absolute or protocol-relative
      | /[^\s"'<>()\\:]*                  # root- and path-relative
      | (?<![^\s"'=(,])[A-Za-z0-9_-]+     # bare filename
    )
    \.(?:jpe?g|png|gif|webp|avif|bmp|tiff|heic)
    (?:\?[^\s"'<>()\\]*)?
    """,
    re.IGNORECASE | re.VERBOSE,
)

#: Inline base64 media, which has no URL to match on.
_DATA_URI_RE = re.compile(r"data:image/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+", re.IGNORECASE)

#: Where a stripped asset used to be. Kept as a marker rather than deleted, so a
#: parser that expected an image fails visibly instead of silently shifting.
STRIPPED = "[media-stripped]"


def strip_media(html: str) -> str:
    """
    Remove every reference to a hosted image from a page, before extraction.

    Why this exists rather than only an output allowlist: an allowlist stops a
    bad field being *stored*, but a regex in extraction/ could still match a
    photo URL and hand it onward. Stripping at the boundary means the pixels are
    never in memory, so "we do not republish other operators' photographs" is a
    property of the data flow instead of a code-review habit.

    Runs on every provider's output, including paid crawl APIs. `excludeTags` in
    the Firecrawl request is a cost optimisation on top of this, never a
    replacement for it - it only helps for providers that offer such an option.

    Never raises. There is a real question about what to do with markup that
    cannot be parsed at all; the failure worth catching is a parser emitting
    image data, and the allowlist catches that separately.
    """
    without_containers = _MEDIA_CONTAINER_RE.sub(f"<!-- {STRIPPED} -->", html)
    without_voids = _MEDIA_VOID_RE.sub(f"<!-- {STRIPPED} -->", without_containers)
    without_urls = _IMAGE_URL_RE.sub(STRIPPED, without_voids)
    return _DATA_URI_RE.sub(STRIPPED, without_urls)


def image_urls_in(html: str) -> list[str]:
    """
    What `strip_media` would have removed. Used by tests and by an audit run, so
    the claim "we drop their photographs" can be demonstrated rather than
    asserted.
    """
    return _IMAGE_URL_RE.findall(html)
