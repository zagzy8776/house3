"""
Nigeria Property Centre adapter.

Reconnaissance, 2026-09-23:
  - robots.txt for `User-agent: *` disallows only `*report/create*`. Every
    property path is permitted, a Sitemap is published, and AI crawlers get an
    explicit `Allow: /`. `trovitBot` (a competitor aggregator) is disallowed.
  - Sitemap index publishes `sitemap_listings_1..4.txt` plus `neighbourhoods`,
    `area_guides`, `list_pages`, `market_reports`, `demand_supply`.
  - Canonical short-let paths: /for-rent/short-let/{type}/{state}/{locality}/{id}
    e.g. /for-rent/short-let/houses/detached-duplexes/lagos/lekki/lekki-phase-1/3690360-full-duplex
    The older /for-rent/short-let/{state}/{locality} shape is only a category
    landing page and publishes no listing URLs of its own.
  - Sitemap census, re-verified 2026-09-23: 172,186 listing URLs total, of which
    16,322 are short-let. The remainder are for-sale houses and land, joint
    ventures, and annual rentals - none of which are House3 prospects.
  - The site is Livewire/Alpine (`@resize.window.debounce`, `x-data`), so filter
    and pagination interactions are JavaScript-driven. That is why the pipeline
    offers PlaywrightTransport: a plain fetch gets the first page of results, the
    browser is needed to walk the rest.

DISCOVERY STRATEGY
------------------
Discovery uses their sitemap, not a guessed URL pattern. A publisher that
advertises a sitemap is telling crawlers where its canonical pages are; guessing
URL shapes is both more fragile and less welcome. List-page pagination is the
fallback, and it is capped.

WHAT THIS ADAPTER EXTRACTS
--------------------------
Facts: price, type, bedrooms, area, the operator's published contact, and the
listing's own gallery. Media is extracted by `extraction/media.py` and allowlisted
by `compliance/allowed_fields.py`; prose (description text) is still refused, and
`assert_no_media_or_prose` fails the run if a change makes this adapter emit it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterator, Optional
from urllib.parse import urljoin, urlparse

from sources.base import DiscoveredListing, SourceLayer
from extraction.contact import find_email, find_instagram, find_operator_website, find_phones
from extraction.media import cover_from, extract_gallery
from extraction.operator import extract_operator

from extraction.pms import detect_pms, find_availability_url, find_booking_url
from extraction.property import (
    BATHROOMS_RE,
    BEDROOMS_RE,
    PRICE_RE,
    extract_property_name,
    extract_property_type,
    extract_title_document,
    first_int,
    parse_price_basis,
    parse_price_to_kobo,
    strip_tags,
)

#: State code -> the slug NPC uses in paths.
STATE_SLUGS: dict[str, str] = {
    "LA": "lagos",
    "FC": "abuja",
    "OY": "oyo",
    "IM": "imo",
    "AK": "akwa-ibom",
}

#: Lagos localities, taken from the filter list on /for-rent/short-let/lagos.
#: Seeded so a crawl can be scoped to the neighbourhoods House3 actually onboards,
#: instead of walking all 50 on the first run.
LAGOS_LOCALITIES: tuple[str, ...] = (
    "ajah",
    "eko-atlantic-city",
    "gbagada",
    "ibeju-lekki",
    "ikeja",
    "ikoyi",
    "lagos-island",
    "lekki",
    "magodo",
    "maryland",
    "ogudu",
    "ojodu",
    "oshodi",
    "surulere",
    "victoria-island-vi",
    "yaba",
)

#: The listing's numeric reference, wherever the publisher puts it in the final
#: path segment. Three shapes are live:
#:
#:   .../ikeja/luxury-3-bedrooms-flats-with-city-view-1043552   (reference last)
#:   .../lekki-phase-1/3690360-full-duplex                      (reference first)
#:   .../ikeja/7654321                                          (bare reference)
#:
#: The number is the stable part; the words around it are the listing's *title*,
#: and editing a title rewrites the slug. Keying on the whole segment - which is
#: what the previous regex fell through to, because it only accepted a trailing
#: reference - would record the same listing twice after the operator renamed it.
#: Leftmost match wins, so a leading reference is preferred.
LISTING_ID_RE = re.compile(r"(?:^|[-/])(\d{6,})(?=[-/]|$)")

#: Only short-let paths are prospects. Filtering on the state slug alone (the
#: previous behaviour) matched every listing in the sitemap for that state, so a
#: "Lagos" run returned terraced duplexes *for sale* at NGN 290,000,000 and flats
#: at "NGN 10,000,000 per annum" - the wrong inventory at the wrong price basis,
#: and the first land plot recorded an advertised price of NGN 24,000,000,000.
SHORTLET_PATH = "/for-rent/short-let/"

#: The page's own statement of what it is. Preferred over the URL we fetched,
#: because a list page offers us the list URL for every row on it.
CANONICAL_URL_RE = re.compile(
    r"""<link[^>]+rel=["']canonical["'][^>]*?href=["']([^"']+)["']""", re.IGNORECASE
)
OG_URL_RE = re.compile(
    r"""<meta[^>]+property=["']og:url["'][^>]*?content=["']([^"']+)["']""", re.IGNORECASE
)

# PRICE_RE, BEDROOMS_RE and BATHROOMS_RE are imported from extraction.property.
# They must NOT be redefined here: an earlier version defined them locally after
# the import, so the local copies silently shadowed the shared ones - and the
# local BEDROOMS_RE was missing the "bedrooms" plural, so "3 Bedrooms" never
# matched. One definition, in extraction/, is the rule for every adapter.

#: `<loc>https://.../for-rent/short-let/lagos/lekki/1234567</loc>` inside a txt sitemap.
SITEMAP_LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.IGNORECASE)
#: Plain-URL sitemaps: one absolute URL per line.
PLAIN_URL_RE = re.compile(r"^\s*(https?://\S+)\s*$", re.MULTILINE)


@dataclass
class NpcAdapter:
    """Implements the SourceAdapter protocol for nigeriapropertycentre.com."""

    name: str = "npc"
    layer: str = SourceLayer.DISCOVERY
    host: str = "www.nigeriapropertycentre.com"
    base_url: str = "https://www.nigeriapropertycentre.com"
    sitemap_index: str = "https://nigeriapropertycentre.com/sitemaps/index.xml"
    max_list_pages: int = 20

    # ---- discovery -----------------------------------------------------------

    def sitemap_listing_urls(self, transport) -> list[str]:
        """
        Every listing URL from the published sitemap. This is the discovery path
        the publisher intends, and it avoids guessing URL shapes.
        """
        index = transport.fetch(self.sitemap_index)
        children = SITEMAP_LOC_RE.findall(index)

        urls: list[str] = []
        for child in children:
            if "sitemap_listings" not in child:
                continue
            body = transport.fetch(child)
            found = SITEMAP_LOC_RE.findall(body) or PLAIN_URL_RE.findall(body)
            urls.extend(found)
        return urls

    def list_page_urls(self, state_code: str, area: Optional[str] = None) -> Iterator[str]:
        """
        Paginated list pages. Fallback when a sitemap is unavailable, capped so a
        misconfiguration cannot walk an entire site.
        """
        slug = STATE_SLUGS.get(state_code)
        if not slug:
            raise ValueError(f"NPC has no slug for state '{state_code}'")

        path = f"/for-rent/short-let/{slug}"
        if area:
            path = f"{path}/{area.strip().lower().replace(' ', '-')}"

        for page in range(1, self.max_list_pages + 1):
            suffix = "" if page == 1 else f"?page={page}"
            yield f"{self.base_url}{path}{suffix}"

    def discover(self, transport, state_code: str, area: Optional[str] = None) -> Iterator[str]:
        """
        Yield candidate listing URLs for a state.

        Sitemap first (canonical and complete); list pages as a fallback so a
        sitemap change does not silently stop acquisition.
        """
        slug = STATE_SLUGS.get(state_code)
        if not slug:
            raise ValueError(f"NPC has no slug for state '{state_code}'")

        try:
            listing_urls = self.sitemap_listing_urls(transport)
        except Exception:
            listing_urls = []

        matched = [
            url
            for url in listing_urls
            if SHORTLET_PATH in url and (f"/{slug}/" in url or url.endswith(f"/{slug}"))
        ]
        if area:
            needle = f"/{slug}/{area.strip().lower().replace(' ', '-')}"
            matched = [url for url in matched if needle in url]

        if matched:
            yield from matched
            return

        yield from self.list_page_urls(state_code, area)

    def parse(self, html: str, url: str) -> Optional[DiscoveredListing]:
        """
        Turn a listing page into a DiscoveredListing.

        Returns None rather than raising when a page is not a listing (a search
        page, an error page), so one bad URL does not abort a crawl.
        """
        name = extract_property_name(html)
        if not name:
            return None

        plain = strip_tags(html)

        # Identify from the page's own canonical URL where there is one. The URL
        # we fetched is what the sitemap or a list page offered us; the canonical
        # URL is what the publisher says the listing *is*. On a list page the
        # two differ sharply - every row on /for-rent/short-let/lagos carries its
        # own canonical - and using the fetched URL there collapsed an entire
        # page of listings into one record keyed by the state slug.
        source_url, listing_id = self._identify(html, url)

        # A page that is not a listing must not become one. When the sitemap is
        # unreachable, discovery falls back to list pages; parsing one produced a
        # record whose id was the last path segment and whose URL was a search
        # page, and because every row on it collapsed onto that single key a live
        # degraded run wrote one junk source listing and reported "18 written".
        # Refusing the page is the honest outcome: it is a search result, not a
        # place, and the funnel counts it as unusable rather than as inventory.
        if not self._is_listing_url(source_url):
            return None

        website = find_operator_website(html, url) or None
        identity = extract_operator(html, website)

        # A name the source *states* is an identity. A name inferred from a domain
        # is a hint: it is one weak signal, and treating it as identity attributed
        # an entire Lagos crawl to a font CDN, then a stylesheet CDN, then a sister
        # portal - with unrelated agencies merged by neighbourhood. The hint is
        # recorded and left for entity resolution, so this listing carries no
        # operator until something actually establishes one.
        operator_name = None
        operator_hint = None
        if identity:
            if identity.is_identity:
                operator_name = identity.name
            else:
                operator_hint = identity.name

        phones = find_phones(html)
        location = self._location_from_url(source_url)

        # One price match, two facts: what was asked, and the unit it was asked
        # in. The unit usually follows the figure in the title ("... - NGN 190,000
        # per day"), so it is read from the words around the match rather than from
        # the page as a whole.
        price_match = PRICE_RE.search(plain)
        advertised_price = parse_price_to_kobo(price_match.group(0) if price_match else None)
        price_basis = parse_price_basis(plain, price_match)

        # The gallery, extracted from the RAW html and not from `plain`: strip_tags
        # has already removed the <img> elements by this point.
        #
        # `url` is passed as the base rather than `source_url`, deliberately. The
        # page may have been reached from a list page whose relative paths resolve
        # differently, and the images are physically on the page we actually
        # fetched. Resolving against a canonical URL we never loaded would produce
        # URLs that 404.
        #
        # `listing_id` filters out the "similar properties" strip. A live page for
        # 3690360 returned four photographs of OTHER properties; without this they
        # would have been shown under this listing's name.
        gallery = extract_gallery(html, url, listing_id=listing_id)


        listing = DiscoveredListing(
            source=self.name,
            source_url=source_url,
            source_listing_id=listing_id,
            property_name=name[:200],
            property_type=extract_property_type(html),
            bedrooms=first_int(BEDROOMS_RE, plain),
            bathrooms=first_int(BATHROOMS_RE, plain),
            advertised_price=advertised_price,
            price_basis=price_basis,
            currency="NGN",
            state=location.get("state"),
            city=location.get("city"),
            area=location.get("area"),
            operator_name=operator_name,
            operator_hint=operator_hint,
            phone=phones[0] if phones else None,
            email=find_email(html),
            website=website,
            instagram=find_instagram(html),
            pms_detected=detect_pms(html),
            booking_url=find_booking_url(html, url),
            availability_hint_url=find_availability_url(html, url),
            title_document=extract_title_document(plain),
            media=gallery,
            cover_image_url=cover_from(gallery),
        )


        # A page with no operator signal at all is a property we cannot act on,
        # but it is still a real observation: keep it, scored low.
        return listing

    # ---- helpers -------------------------------------------------------------

    @staticmethod
    def _listing_id(url: str) -> str:
        match = LISTING_ID_RE.search(urlparse(url).path)
        if match:
            return match.group(1)
        # Fall back to the last path segment, which is stable even if NPC
        # changes its id format.
        return urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]

    def _identify(self, html: str, fetched_url: str) -> tuple[str, str]:
        """
        Return (source_url, source_listing_id) for a page.

        Preference order, most authoritative first:

          1. a canonical URL on the page - what the publisher says the listing is
          2. the fetched URL, when it already carries a numeric listing id
          3. the fetched URL's last path segment

        The canonical is only accepted when it stays on this adapter's host. A
        page that points its canonical somewhere else is either a syndicated copy
        or a publisher mistake, and adopting a foreign URL as our provenance
        would make the record unattributable.
        """
        canonical = CANONICAL_URL_RE.search(html) or OG_URL_RE.search(html)
        if canonical:
            candidate = canonical.group(1).strip()
            if candidate and self._same_host(candidate) and self._is_listing_url(candidate):
                return candidate, self._listing_id(candidate)

        return fetched_url, self._listing_id(fetched_url)

    @staticmethod
    def _is_listing_url(url: str) -> bool:
        """True when the URL is a SHORT-LET listing carrying its own reference.

        Two conditions, and both are load-bearing.

        1. A reference in the last path segment. Some templates publish their
           breadcrumb toggle as the canonical - observed as
           `/for-rent/short-let/houses/showtype`. Every page on such a template would
           be handed the SAME source_listing_id, and because
           `(source, sourceListingId)` is the uniqueness key they would collapse into
           one record, each overwriting the previous one's source_url - silently
           merging distinct properties instead of creating duplicates.

        2. `SHORTLET_PATH`. This was missing, and a live 500-listing stage proved why
           it matters: a shortlet list page publishes links to OTHER categories, and
           15 of the 79 links on `/for-rent/short-let/lagos/lekki` pointed outside
           short-let - including `/for-rent/flats-apartments/lagos/lekki/showtype`,
           which satisfied condition 1. Records entered the crawl at PER_MONTH with
           prices like NGN 2,500,000/year, which as an annual rent is correct and as
           shortlet inventory is meaningless. Filtering only the sitemap (which
           `discover` does) leaves the list-page fallback unfiltered, so the check
           belongs here, where every path into `parse` passes through it.
        """
        path = urlparse(url).path
        if SHORTLET_PATH not in path:
            return False
        segment = path.rstrip("/").rsplit("/", 1)[-1]
        return bool(LISTING_ID_RE.search(segment))

    def _same_host(self, candidate: str) -> bool:
        expected = self.host.replace("www.", "")
        host = urlparse(candidate).netloc.replace("www.", "")
        return bool(host) and (host == expected or host.endswith(f".{expected}"))

    def _location_from_url(self, url: str) -> dict[str, Optional[str]]:
        """
        NPC puts location in the path, so the URL is a more reliable source than
        any label on the page: /for-rent/short-let/lagos/lekki/1234567
        """
        parts = [part for part in urlparse(url).path.split("/") if part]
        slug_to_code = {slug: code for code, slug in STATE_SLUGS.items()}

        state_slug = next((part for part in parts if part in slug_to_code), None)
        state_code = slug_to_code.get(state_slug or "")
        city = state_slug.capitalize() if state_slug else None

        area = None
        if state_slug:
            index = parts.index(state_slug)
            # Guard the off-by-one: for /for-rent/short-let/lagos/lekki the
            # locality sits at index+1, and parts[index+1] must not be a numeric
            # listing id. An earlier version used `> index + 2`, which silently
            # never matched and left every listing without an area.
            if len(parts) > index + 1 and not parts[index + 1].isdigit():
                area = parts[index + 1].replace("-", " ").title()

        return {"state": state_code, "city": city, "area": area}


# Convenience so `from sources.npc import NpcAdapter` works without knowing the
# module re-exports these helpers.
__all__ = ["NpcAdapter", "STATE_SLUGS", "LAGOS_LOCALITIES"]
