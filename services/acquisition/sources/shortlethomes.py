"""
ShortletHomes adapter.

RECONNAISSANCE, 2026-09-24:
  - robots.txt: UNREACHABLE (SSL error)
  - An operator's own site (e.g. 1677 Mayfair Apartments)
  - Layer: OPERATOR_SITE (single operator, not a portal)
  - robots.txt: https://shortlethomes.com/robots.txt

DISCOVERY STRATEGY
------------------
This is an operator's own site. Since robots.txt is unreachable and no sitemap
is known, discovery will need to be adapted once the site structure is known.
For now, this adapter provides the structure for when the site becomes reachable.
"""

from __future__ import annotations

import re
from typing import Iterator, Optional
from urllib.parse import urljoin, urlparse

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
from sources.base import DiscoveredListing, SourceLayer

CANONICAL_URL_RE = re.compile(
    r"""<link[^>]+rel=["']canonical["'][^>]*?href=["']([^"']+)["']""", re.IGNORECASE
)
OG_URL_RE = re.compile(
    r"""<meta[^>]+property=["']og:url["'][^>]*?content=["']([^"']+)["']""", re.IGNORECASE
)

LISTING_ID_RE = re.compile(r"(?:^|[-/])([A-Za-z0-9]{5,})(?=[-/]|$)")

LISTING_LINK_RE = re.compile(r'href="(/[^"]*(?:property|apartment|listing|rent|short-let)[^"]*)"', re.IGNORECASE)
PAGINATION_RE = re.compile(r'href="([^"]*[?&]page=(\d+)[^"]*)"')

MAX_PAGES = 20

#: `<loc>https://.../...</loc>` inside a txt sitemap.
SITEMAP_LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.IGNORECASE)
#: Plain-URL sitemaps: one absolute URL per line.
PLAIN_URL_RE = re.compile(r"^\s*(https?://\S+)\s*$", re.MULTILINE)


class ShortletHomesAdapter:
    """ShortletHomes operator site adapter."""

    name = "shortlethomes"
    layer = SourceLayer.DISCOVERY
    host = "shortlethomes.com"
    base_url = "https://shortlethomes.com"
    sitemap_index = "https://shortlethomes.com/sitemap.xml"

    def sitemap_listing_urls(self, transport) -> list[str]:
        """Attempt to fetch from sitemap (may fail if robots.txt is unreachable)."""
        try:
            index = transport.fetch(self.sitemap_index)
        except Exception:
            return []

        children = SITEMAP_LOC_RE.findall(index)
        urls: list[str] = []
        for child in children:
            try:
                body = transport.fetch(child)
            except Exception:
                continue
            found = SITEMAP_LOC_RE.findall(body) or PLAIN_URL_RE.findall(body)
            urls.extend(found)
        return urls

    def list_page_urls(self) -> Iterator[str]:
        """Fallback: common property listing paths for operator sites."""
        common_paths = [
            "/properties/",
            "/apartments/",
            "/listings/",
            "/short-lets/",
            "/our-properties/",
            "/portfolio/",
        ]
        for path in common_paths:
            yield f"{self.base_url}{path}"

    def discover(self, transport, state_code: str, area: Optional[str] = None) -> Iterator[str]:
        """Yield candidate listing URLs."""
        listing_urls = self.sitemap_listing_urls(transport)

        property_paths = [
            url for url in listing_urls
            if any(keyword in url.lower() for keyword in ["/property/", "/apartment/", "/listing/", "/rent/", "/short-let/"])
        ]

        if property_paths:
            yield from property_paths
            return

        seen: set[str] = set()
        for page_url in self.list_page_urls():
            try:
                html = transport.fetch(page_url)
            except Exception:
                continue

            for href in LISTING_LINK_RE.findall(html):
                listing_url = urljoin(page_url, href).split("#")[0].split("?")[0]
                if listing_url in seen or not self._is_listing_url(listing_url):
                    continue
                seen.add(listing_url)
                yield listing_url

    def parse(self, html: str, url: str) -> Optional[DiscoveredListing]:
        """Turn a listing page into a DiscoveredListing."""
        name = extract_property_name(html)
        if not name:
            return None

        plain = strip_tags(html)
        source_url, listing_id = self._identify(html, url)

        if not self._is_listing_url(source_url):
            return None

        website = find_operator_website(html, url) or None
        identity = extract_operator(html, website)

        operator_name = None
        operator_hint = None
        if identity:
            if identity.is_identity:
                operator_name = identity.name
            else:
                operator_hint = identity.name

        phones = find_phones(html)
        location = self._location_from_url(source_url)

        price_match = PRICE_RE.search(plain)
        advertised_price = parse_price_to_kobo(price_match.group(0) if price_match else None)
        price_basis = parse_price_basis(plain, price_match)

        gallery = extract_gallery(html, url, listing_id=listing_id)

        return DiscoveredListing(
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

    @staticmethod
    def _listing_id(url: str) -> str:
        match = LISTING_ID_RE.search(urlparse(url).path)
        if match:
            return match.group(1)
        return urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]

    def _identify(self, html: str, fetched_url: str) -> tuple[str, str]:
        canonical = CANONICAL_URL_RE.search(html) or OG_URL_RE.search(html)
        if canonical:
            candidate = canonical.group(1).strip()
            if candidate and self._same_host(candidate) and self._is_listing_url(candidate):
                return candidate, self._listing_id(candidate)

        return fetched_url, self._listing_id(fetched_url)

    def _is_listing_url(self, url: str) -> bool:
        path = urlparse(url).path.lower()
        return any(keyword in path for keyword in ["/property/", "/apartment/", "/listing/", "/rent/", "/short-let/"])

    def _same_host(self, candidate: str) -> bool:
        expected = self.host.replace("www.", "")
        host = urlparse(candidate).netloc.replace("www.", "")
        return bool(host) and (host == expected or host.endswith(f".{expected}"))

    def _location_from_url(self, url: str) -> dict[str, Optional[str]]:
        return {"state": "LA", "city": "Lagos", "area": None}


__all__ = ["ShortletHomesAdapter"]