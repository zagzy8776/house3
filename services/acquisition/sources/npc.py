"""
Nigeria Property Centre adapter.

Reconnaissance, 2026-09-23:
  - robots.txt for `User-agent: *` disallows only `*report/create*`. Every
    property path is permitted, a Sitemap is published, and AI crawlers get an
    explicit `Allow: /`. `trovitBot` (a competitor aggregator) is disallowed.
  - Sitemap index publishes `sitemap_listings_1..4.txt` plus `neighbourhoods`,
    `area_guides`, `list_pages`, `market_reports`, `demand_supply`.
  - Canonical short-let paths: /for-rent/short-let/{state}/{locality}
  - Lagos carried 13,525 short-let listings, 50 localities.
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

WHAT THIS ADAPTER WILL NOT DO
-----------------------------
It extracts facts: price, type, bedrooms, area, and the operator's published
contact. It never returns photographs or description text, and
`assert_no_media_or_prose` fails the run if a change makes it try.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterator, Optional
from urllib.parse import urljoin, urlparse

from sources.base import DiscoveredListing, SourceLayer
from extraction.contact import find_email, find_instagram, find_operator_website, find_phones
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

#: Listing URLs on NPC end in a numeric id. Observed in the published sitemap.
LISTING_ID_RE = re.compile(r"-(\d{6,})(?:/)?$")

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

        matched = [url for url in listing_urls if f"/{slug}/" in url or url.endswith(f"/{slug}")]
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

        website = find_operator_website(html, url) or None
        identity = extract_operator(html, website)

        phones = find_phones(html)
        location = self._location_from_url(url)

        listing = DiscoveredListing(
            source=self.name,
            source_url=url,
            source_listing_id=self._listing_id(url),
            property_name=name[:200],
            property_type=extract_property_type(html),
            bedrooms=first_int(BEDROOMS_RE, plain),
            bathrooms=first_int(BATHROOMS_RE, plain),
            advertised_price=parse_price_to_kobo(PRICE_RE.search(plain).group(0) if PRICE_RE.search(plain) else None),
            currency="NGN",
            state=location.get("state"),
            city=location.get("city"),
            area=location.get("area"),
            operator_name=identity.name if identity else None,
            phone=phones[0] if phones else None,
            email=find_email(html),
            website=website,
            instagram=find_instagram(html),
            pms_detected=detect_pms(html),
            booking_url=find_booking_url(html, url),
            availability_url=find_availability_url(html, url),
            title_document=extract_title_document(plain),
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
