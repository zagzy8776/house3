"""
Gallery extraction.

WHAT THIS DOES
--------------
Pulls the photographs a listing publishes, as absolute URLs, in page order.

WHY PHOTOGRAPHS ARE NOW EXTRACTED
---------------------------------
This module did not exist for most of the project's life, because the acquisition
layer was built to refuse media entirely: `compliance.allowed_fields.strip_media`
deleted every image reference before a parser saw the page. The product decision
changed - House3 shows a guest the gallery, because a guest choosing a place to
call needs to see the place - so media is now allowlisted and this is the module
that reads it. `compliance/allowed_fields.py` carries the record of that decision.

WHAT IS STILL EXCLUDED
----------------------
Prose. `description`, `body_text` and `summary` remain in `FORBIDDEN_FIELDS`: a
listing's marketing copy is somebody's writing and is a different thing from its
gallery. Nothing here touches text.

THE FILTERS, AND WHY EACH ONE MATTERS
-------------------------------------
A portal page carries far more images than the property's gallery: logos, social
icons, agent avatars, map tiles, tracking pixels, ad creatives. Returning all of
them would put a tracking gif on a guest's screen as "photo 3". So:

  * Tracking pixels are dropped on dimensions when the tag states them, and on
    filename patterns (`pixel`, `spacer`, `blank`, `1x1`) regardless.
  * Site chrome is dropped on filename and path patterns: `logo`, `favicon`,
    `sprite`, `placeholder`, anything under `/static/`, `/theme/` or an icon path.
  * Duplicates are removed, because a portal that renders a thumbnail and a full
    image from the same asset must not present it twice.
  * `srcset` is parsed and its LARGEST candidate is taken, so we store the high
    resolution URL rather than a 150px thumbnail.
  * Lazy-loaded images are handled: many templates carry `data-src`,
    `data-lazy-src` or `data-original` with a 1x1 gif in `src`, so the data
    attribute is checked before `src`.

WHY ABSOLUTE URLS
-----------------
`../images/x.jpg` is meaningless once it leaves the page it was found on. Every
returned URL is absolute, resolved against the page it came from, so a stored row
is self-contained and the UI never has to know which page to resolve against.

WHY MOST IMAGES ARE NOW REFUSED, AND WHY THE ONES THAT SURVIVE DO
-----------------------------------------------------------------
The allowlist permits media. This module is where that permission is narrowed by
what the pixels actually are, and the narrowing is severe: a photograph we cannot
serve honestly is worse than no photograph, so most of what a portal publishes is
refused outright.

  * WATERMARKS (`has_watermark`). A portal stamps its own brand over the
    photograph - "Nigeria property centre" with a house logo sits dead centre of
    every NPC image, verified by fetching one. Publishing that is not citing a
    source and it is not displaying the operator's gallery either: it is
    redistributing the portal's branded asset under our own listing page, which
    is precisely the use the stamp exists to prevent. So a URL that names a
    branding asset, or that carries a portal's own brand token, is refused.
  * THIRD-PARTY HOTLINKING (`is_hotlinkable`). A tracked URL means our guests'
    browsers fetch the image from the publisher's server, so our page views are
    their bandwidth and their logs. We do not do that either.

The distinction that decides it: a photograph that merely LIVES on a portal's CDN
is that portal's storage of the operator's picture - `images.example-portal.com/
properties/images/12345/abc.webp` is the operator's own room. A photograph whose
URL carries the portal's brand token, or whose token is a measurement, is the
portal's asset. The first is publishable with attribution; the second is refused.

On NPC the branded token is the filename itself - `.../properties/images/3691970/
06ab405aa95d40-newly-launched-1-bedroom-apartment....webp` - and the surviving
count on the current crawl is near zero, which is the honest number.

So `extract_gallery` keeps the listing's own gallery and rejects the branded
remainder, and a listing left with nothing gets asked for its photographs by phone
rather than shown a picture we had no right to serve. That is a worse-looking page
and a correct one.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional
from urllib.parse import urljoin, urlparse

#: `<img ...>` and `<source ...>`, captured whole so attributes can be read.
_IMG_TAG_RE = re.compile(r"<(img|source)\b([^>]*)>", re.IGNORECASE)

#: `attr="value"`, `attr='value'` and bare `attr=value`.
_ATTR_RE = re.compile(
    r"""([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""",
)

#: Attributes that can hold the real image, in priority order. Lazy-loading
#: templates put a placeholder in `src` and the photograph in one of the others,
#: so `src` is checked LAST rather than first.
_SRC_ATTRS = (
    "data-src",
    "data-lazy-src",
    "data-original",
    "data-image",
    "data-full-src",
    "data-hi-res-src",
    "src",
)

#: An image extension we accept, anchored at the end of the path.
_IMAGE_EXT_RE = re.compile(r"\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?|heic)(?:$|\?)", re.IGNORECASE)

#: Filenames and paths that are never a property photograph. Ordered roughly by how
#: often each one appears on a real portal page.
_CHROME_PATTERNS = re.compile(
    r"(?:"
    r"logo|favicon|sprite|placeholder|blank\.|spacer|pixel|tracking|beacon"
    r"|/static/|/assets/img/icon|/images/icon|/img/icon|/theme/|/skin/"
    r"|avatar|/user/|/agent/|/icon|/icons/|1x1|2x2"
    # A publisher's own brand assets: `/properties/profiles/7215_l.jpg` is an
    # operator's avatar on NPC, not a photograph of the property.
    r"|/profiles?/|/brand/|/partner-logos?/"
    # A thumbnail strip of OTHER properties. Portals render "similar listings"
    # at the bottom of every page, and those images belong to different
    # properties entirely - the id in their path is not this listing's id.
    r"|/thumbs?/"
    r")",
    re.IGNORECASE,
)

#: A path segment that is a listing reference: `/properties/images/3690360/...`.
#: Used to tell THIS listing's photographs from a similar-properties strip.
_LISTING_ID_IN_PATH_RE = re.compile(r"/(\d{5,})/")

#: A publisher's own brand, as it appears in an image URL. When one of these is in
#: the path, the image is the PUBLISHER'S asset rather than the operator's
#: photograph, and it carries the publisher's watermark in its pixels. See
#: `has_watermark` for the measured case that put this here.
_PUBLISHER_BRAND_TOKENS = (
    "npc",
    "nigeriapropertycentre",
    "nigeria-property-centre",
    "propertycentre",
    "propertypro",
    "propertypro.ng",
    "privateproperty",
    "jiji",
    "jiji.ng",
    "realestate",
    "nigeriaproperty",
)

#: Filenames that are a watermark rather than a photograph.
_WATERMARK_ASSET_PATTERNS = re.compile(
    r"(?:watermark|water-mark|wm_|_wm\.|_branded|branded\.|stamp\.|overlay-watermark)",
    re.IGNORECASE,
)

#: Query parameters that mark a re-hosting or tracking URL rather than a plain
#: image. `?w=800` is a resize and fine; `?url=`, `?src=`, `?source=` and any
#: `utm_*` mean the bytes are proxied through, or measured by, somebody else.
_TRACKING_QUERY_RE = re.compile(
    r"[?&](?:url|src|source|image|img|u|q)=|(?:[?&]utm_|imgix|wsrv\.nl|images\.weserv)",
    re.IGNORECASE,
)

#: Hosts we serve from directly. An image on one of these is the platform's own
#: storage, so there is no third party to hotlink and no publisher watermark.
_STORAGE_HOST_PATTERNS = re.compile(
    r"(?:^|\.)(?:cloudinary\.com|imgix\.net|images\.unsplash\.com|"
    r"storage\.googleapis\.com|s3\.amazonaws\.com|r2\.dev|cdn\.house3\.ng|"
    r"house3\.ng)$",
    re.IGNORECASE,
)


#: Dimension attributes that mark a tracking pixel or a spacer.
_TINY_DIM_RE = re.compile(r"^(?:[12])$")


def has_watermark(url: str) -> bool:
    """
    True when the URL names a publisher's branded asset rather than a photograph.

    THE PROBLEM THIS SOLVES, MEASURED

    Every photograph on a Nigeria Property Centre listing carries the portal's
    watermark burned into the pixels - the words "Nigeria property centre" and its
    house logo, dead centre of the image. Verified by fetching one:

        /properties/images/3691970/06ab405aa95d40-newly-launched-1-bedroom-....webp

    Two things are wrong with publishing that. It is the portal's brand on our
    page, which is the portal's own asset used the way its stamp exists to
    forbid; and it makes our listing page look like a scraped NPC page, which is
    what it was.

    The URL is what tells us, without downloading and inspecting pixels: NPC puts
    the brand in the filename, and the namespace `/properties/images/` is NPC's.
    A URL that names the brand, or that names a watermark asset, is refused.

    WHAT THIS DOES NOT CATCH

    A portal that watermarks without putting the brand in the URL - a generic
    `/img/8821.jpg` over which the brand is drawn - is invisible to this check.
    That is a real limit and the honest statement of it is that this is a filter
    for a known, measured case, not a watermark detector. Detecting it generally
    needs the pixels, which needs the image bytes, which is the very hotlinking
    this module refuses.
    """
    lowered = url.lower()
    if _WATERMARK_ASSET_PATTERNS.search(lowered):
        return True

    # The brand can be in the HOST or in the PATH, and on the measured case it is
    # the host: `images.nigeriapropertycentre.com/properties/images/3691970/
    # 06ab405aa95d40-newly-launched-....webp`. The path carries no brand token at
    # all, so a path-only check missed every NPC photograph - which is exactly the
    # bug this comment exists to stop someone reintroducing.
    parsed = urlparse(lowered)
    for surface in (parsed.hostname or "", parsed.path):
        for token in _PUBLISHER_BRAND_TOKENS:
            # Match on a boundary so a random hash containing "npc" does not trip
            # it, but "npc.", "-npc-", "/npc/" and "npc" as a whole label all do.
            if re.search(rf"(?:^|[/._-]){re.escape(token)}(?:$|[/._-])", surface):
                return True
    return False


def is_hotlinkable(url: str) -> bool:
    """
    True when fetching this image would spend somebody else's bandwidth.

    The guest's browser is what fetches an `<img src>`, not our server, so a
    third-party URL means our page views appear in the publisher's logs and are
    served from the publisher's CDN. That is a decision about somebody else's
    resources that we are not in a position to make on their behalf, so a URL is
    only used when it is the platform's own storage or a plain, untracked image.

    Fail-closed on the ambiguous cases: a re-hosting or tracking parameter is
    refused, because a proxied image is somebody else's service by definition.
    """
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if _STORAGE_HOST_PATTERNS.search(host):
        return False
    if _TRACKING_QUERY_RE.search(url):
        return True
    return False


def _attrs_of(tag: str) -> dict[str, str]:
    """Every attribute on one tag, lowercased names, first occurrence wins."""
    found: dict[str, str] = {}
    for match in _ATTR_RE.finditer(tag):
        name = match.group(1).lower()
        value = match.group(2) or match.group(3) or match.group(4) or ""
        if name not in found:
            found[name] = value.strip()
    return found


def _is_tiny(attrs: dict[str, str]) -> bool:
    """True when the tag declares itself 1x1 or 2x2 - a pixel or a spacer."""
    width = attrs.get("width", "").strip()
    height = attrs.get("height", "").strip()
    return bool(_TINY_DIM_RE.match(width) and _TINY_DIM_RE.match(height))


def _largest_from_srcset(srcset: str) -> Optional[str]:
    """
    The biggest candidate in a `srcset`.

    `a.jpg 150w, b.jpg 800w, c.jpg 1600w` -> `c.jpg`. Width descriptors are the
    common case; a density descriptor (`2x`) is scaled so a `2x` beats a `1x`
    when no widths are stated.
    """
    best: Optional[str] = None
    best_score = -1.0

    for candidate in srcset.split(","):
        parts = candidate.strip().split()
        if not parts:
            continue
        url = parts[0]
        score = 1.0
        if len(parts) > 1:
            descriptor = parts[1].strip().lower()
            try:
                if descriptor.endswith("w"):
                    score = float(descriptor[:-1])
                elif descriptor.endswith("x"):
                    score = float(descriptor[:-1]) * 1000.0
            except ValueError:
                score = 1.0
        if score > best_score:
            best_score = score
            best = url

    return best


def _absolute(url: str, page_url: str) -> Optional[str]:
    """Resolve to an absolute http(s) URL, or None when it cannot be one."""
    cleaned = url.strip().strip("'\"")
    if not cleaned or cleaned.startswith("data:") or cleaned.startswith("blob:"):
        return None
    if cleaned.startswith("//"):
        cleaned = f"{urlparse(page_url).scheme or 'https'}:{cleaned}"
    absolute = urljoin(page_url, cleaned)
    scheme = urlparse(absolute).scheme.lower()
    if scheme not in {"http", "https"}:
        return None
    return absolute


def is_other_listings_photo(url: str, listing_id: Optional[str]) -> bool:
    """
    True when a URL carries a listing reference that is not this listing's.

    THE BUG THIS EXISTS FOR

    A live NPC page for listing 3690360 returned five images. Four belonged to
    other properties (3693771, 3589721, 3575995) because they came from the
    "similar properties" strip at the bottom of the page; one was an operator
    profile logo. Showing four strangers' apartments under this listing's name
    would be the single most misleading thing this feature could do - worse than
    showing nothing, because a guest would believe they were looking at the room
    they are about to call about.

    A URL with no listing reference at all is kept: most CDNs put the id in the
    filename or nowhere, and refusing those would refuse nearly every real photo.
    Only a URL that positively names a DIFFERENT id is rejected.
    """
    if not listing_id:
        return False
    for segment in _LISTING_ID_IN_PATH_RE.findall(url):
        if segment != listing_id:
            return True
    return False


def extract_gallery(
    html: str,
    page_url: str,
    *,
    limit: int = 40,
    listing_id: Optional[str] = None,
) -> tuple[str, ...]:
    """
    The property's gallery, absolute and de-duplicated, in page order.

    `limit` is a guard, not a product decision: some portals render an entire
    portfolio in a "similar properties" strip at the bottom of every page, and
    without a cap a single listing's row can absorb a hundred other people's
    properties. Forty covers every real listing and bounds the row size.

    `listing_id` is the listing's own reference. When supplied, an image whose
    path names a DIFFERENT reference is dropped, because it belongs to another
    property - see `is_other_listings_photo`. Photographs that this listing's own
    id appears in are ranked first, so the gallery leads with the real ones
    rather than with whatever the template rendered first.
    """
    seen: set[str] = set()
    confirmed: list[str] = []
    unconfirmed: list[str] = []

    for match in _IMG_TAG_RE.finditer(html):
        attrs = _attrs_of(match.group(2))

        if _is_tiny(attrs):
            continue

        candidate: Optional[str] = None
        for name in _SRC_ATTRS:
            value = attrs.get(name)
            if value:
                candidate = value
                # The first populated attribute wins, and `_SRC_ATTRS` already
                # orders data-* before `src`, so `src` is only reached when no
                # lazy-loading attribute held the real photograph.
                break

        # `srcset` outranks `src`. A lazy-loading template carries a 1px placeholder
        # in `src` and the real candidates in `srcset`; taking `src` first would
        # have stored the placeholder as the property's photograph. This was a
        # measured bug: a gallery of four real images came back as four placeholders.
        srcset_pick = _largest_from_srcset(attrs["srcset"]) if attrs.get("srcset") else None
        if srcset_pick:
            candidate = srcset_pick
        elif not candidate:
            continue

        absolute = _absolute(candidate, page_url)
        if not absolute:
            continue
        if not _IMAGE_EXT_RE.search(urlparse(absolute).path):
            continue
        if _CHROME_PATTERNS.search(absolute):
            continue
        if has_watermark(absolute):
            # The portal's own branded asset, watermark and all. We refuse it
            # rather than publish the portal's brand as this listing's photograph.
            continue
        if is_hotlinkable(absolute):
            # Serving this would spend the publisher's bandwidth for our page view.
            continue
        if is_other_listings_photo(absolute, listing_id):
            continue
        if absolute in seen:
            continue

        seen.add(absolute)
        if listing_id and listing_id in absolute:
            confirmed.append(absolute)
        else:
            unconfirmed.append(absolute)

    return tuple((confirmed + unconfirmed)[:limit])



def cover_from(gallery: Iterable[str]) -> Optional[str]:
    """The first gallery image, or None. A card shows this; the page shows all."""
    for url in gallery:
        return url
    return None
