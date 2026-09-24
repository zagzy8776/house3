"""
Field allowlist - what the extraction layer may hand onward.

Crawling is one permission; what you may store is another. nigeriapropertycentre.com's
robots.txt permits us to fetch their pages, so we fetch them. This module defines
the boundary: the fields a parser is allowed to emit, and the fields it is not.

THE MEDIA DECISION CHANGED. THIS IS RECORDED DELIBERATELY.

An earlier revision of this module stripped every image reference out of the HTML
before a parser saw it, and refused to let a media field leave extraction at all.
The reasoning was that a photograph is a creative work with a live owner.

That policy is now LIFTED for gallery media, by explicit product decision: House3
displays the photographs a listing publishes, because a guest choosing a place to
call needs to see the place. Where the decision lands:

  * Media is now an ALLOWED field, declared below. `strip_media` no longer removes
    `<img>` elements, so the pixels reach the parser.
  * `MEDIA_FIELDS` are allowlisted separately from `ALLOWED_FIELDS` so the media
    surface stays visible as its own decision instead of dissolving into the
    general list.
  * Prose is STILL forbidden. `description`, `body_text` and `summary` remain in
    FORBIDDEN_FIELDS: a listing's marketing copy is a different thing from its
    gallery and is still somebody's writing.

`assert_no_media_or_prose()` keeps its name and its failing-on-undeclared-field
behaviour, because a new field should still be a conscious addition here.
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
        # the property's own gallery - see MEDIA_FIELDS
        "media",
        "media_count",
        "cover_image_url",
    }
)

#: Media is allowlisted, but as its own set so the decision is legible. A reviewer
#: asking "does this crawler carry other people's photographs?" should get a
#: one-line answer from the file, not have to infer it from ALLOWED_FIELDS.
MEDIA_FIELDS = frozenset({"media", "media_count", "cover_image_url"})

#: Never extracted, never stored. Named explicitly so the exclusion is a decision
#: on record rather than an oversight.
#:
#: Media has been removed from this set by product decision (see the module
#: docstring). Prose has NOT: we display a listing's photographs, we still do not
#: republish its written description.
FORBIDDEN_FIELDS = frozenset(
    {
        "description",
        "body_text",
        "summary",
        "review_text",
        "agent_name",
        "agent_photo",
    }
)

#: Was forbidden, now permitted. Kept as a named set so a future reversal is a
#: one-line change and so the history is greppable.
FORMERLY_FORBIDDEN_FIELDS = frozenset(
    {
        "photo",
        "photos",
        "image",
        "images",
        "gallery",
        "photo_count",
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
#: `picture` is deliberately NOT in this list any more: a `<picture>` wraps the
#: `<img>` that IS the gallery. It is unwrapped instead, just below.
_MEDIA_CONTAINER_RE = re.compile(
    r"<(video|audio|object|embed)\b[^>]*>.*?</\1\s*>",
    re.IGNORECASE | re.DOTALL,
)

#: `<picture><source ...><img src=...></picture>` becomes the `<img>` alone, so a
#: parser reading `src` sees one element per photograph instead of two.
_PICTURE_RE = re.compile(
    r"<picture\b[^>]*>(.*?)</picture\s*>",
    re.IGNORECASE | re.DOTALL,
)

#: Void elements. `<source>` survives only in the sense that a `<video>`'s sources
#: are already gone with their container; an orphan `<source>` outside a picture is
#: dropped here.
_EMBED_URL_RE = re.compile(r"<(track)\b[^>]*>", re.IGNORECASE)


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
    Normalise a page's media so extraction sees only the gallery we accept.

    WHY THIS NO LONGER DELETES IMAGES

    This function used to remove every image reference from the document. That was
    the enforcement point for the old no-media policy, which has been lifted (see
    the module docstring). It is kept - and kept running on every provider's
    output - because it still does three things worth doing:

      1. It drops the container elements that carry NO listing value and a lot of
         noise: `<video>`, `<audio>`, `<object>`, `<embed>`. A property tour video
         is not the gallery and a parser should not go looking inside one.
      2. It normalises inline base64 blobs to a marker, so a data URI cannot bloat
         an extraction record or smuggle bytes past a URL check.
      3. It rewrites `<picture>` to the `<img>` inside it, so a parser reading
         `src` finds one element per photograph rather than two.

    `<img>` and `<source>` are deliberately preserved now: they are the gallery.

    Never raises. There is a real question about what to do with markup that
    cannot be parsed at all; the failure worth catching is a parser emitting a
    field that is not allowlisted, and `assert_no_media_or_prose` catches that
    separately.
    """
    without_containers = _MEDIA_CONTAINER_RE.sub(f"<!-- {STRIPPED} -->", html)
    unwrapped_pictures = _PICTURE_RE.sub(lambda match: match.group(1), without_containers)
    without_data_uris = _DATA_URI_RE.sub(STRIPPED, unwrapped_pictures)
    return _EMBED_URL_RE.sub(STRIPPED, without_data_uris)


def image_urls_in(html: str) -> list[str]:
    """
    Every image URL the extractor can see. Used by tests and by an audit run, so
    the claim "we carry the gallery a listing published" is demonstrable.
    """
    return _IMAGE_URL_RE.findall(html)

