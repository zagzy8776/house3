"""
Krent.space adapter.

RECONNAISSANCE, 2026-09-24:
  - robots.txt: no disallow rules, reachable (HTTP 200)
  - Listing portal for short lets with agent-connect booking flow
  - robots.txt: https://krent.space/robots.txt
  - Sitemaps: not detected in robots.txt

DISCOVERY STRATEGY
------------------
Since no sitemap is published in robots.txt, discovery falls back to category
pagination. Krent appears to focus on short-lets specifically.
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

STATE_SLUGS: dict[str, str] = {
    "LA": "lagos",
    "FC": "abuja",
    "OY": "oyo",
    "IM": "imo",
    "AK": "akwa-ibom",
}

SHORTLET_PATH = "/short-let/"

LISTING_ID_RE = re.compile(r"(?:^|[-/])(\d{5,})(?=[-/]|$)")

CANONICAL_URL_RE = re.compile(
    r"""<link[^>]+rel=["']canonical["'][^>]*?href=["']([^"']+)["']""", re.IGNORECASE
)
OG_URL_RE = re.compile(
    r"""<meta[^>]+property=["']og:url["'][^>]*?content=["']([^"']+)["']""", re.IGNORECASE
)

LISTING_LINK_RE = re.compile(r'href="(/[^"]*short-let[^"]*)"', re.IGNORECASE)
PAGINATION_RE = re.compile(r'href="([^"]*[?&]page=(\d+)[^"]*)"')

MAX_PAGES = 20

#: `<loc>https://.../...</loc>` inside a txt sitemap.
SITEMAP_LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.IGNORECASE)
#: Plain-URL sitemaps: one absolute URL per line.
PLAIN_URL_RE = re.compile(r"^\s*(https?://\S+)\s*$", re.MULTILINE)


class KrentAdapter:
    """Krent.space discovery adapter."""

    name = "krent"
    layer = SourceLayer.DISCOVERY
    host = "krent.space"
    base_url = "https://krent.space"
    sitemap_index = "https://krent.space/sitemap.xml"

    def sitemap_listing_urls(self, transport) -> list[str]:
        """Attempt to fetch listing URLs from sitemap if available."""
        try:
            index = transport.fetch(self.sitemap_index)
        except Exception:
            return []

        children = SITEMAP_LOC_RE.findall(index)
        urls: list[str] = []
        for child in children:
            if "sitemap" not in child.lower():
                continue
            try:
                body = transport.fetch(child)
            except Exception:
                continue
            found = SITEMAP_LOC_RE.findall(body) or PLAIN_URL_RE.findall(body)
            urls.extend(found)
        return urls

    def list_page_urls(self, state_code: str, area: Optional[str] = None) -> Iterator[str]:
        """Paginated list pages for a state."""
        slug = STATE_SLUGS.get(state_code)
        if not slug:
            raise ValueError(f"Krent has no slug for state '{state_code}'")

        path = f"/short-let/{slug}"
        if area:
            path = f"{path}/{area.strip().lower().replace(' ', '-')}"

        for page in range(1, MAX_PAGES + 1):
            suffix = "" if page == 1 else f"?page={page}"
            yield f"{self.base_url}{path}{suffix}"

    def discover(self, transport, state_code: str, area: Optional[str] = None) -> Iterator[str]:
        """Yield candidate listing URLs for a state."""
        slug = STATE_SLUGS.get(state_code)
        if not slug:
            raise ValueError(f"Krent has no slug for state '{state_code}'")

        listing_urls = self.sitemap_listing_urls(transport)

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

        seen: set[str] = set()
        for page_url in self.list_page_urls(state_code, area):
            try:
                html = transport.fetch(page_url)
            except Exception:
                break

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
        parts = [part for part in urlparse(url).path.split("/") if part]
        slug_to_code = {slug: code for code, slug in STATE_SLUGS.items()}

        state_slug = next((part for part in parts if part in slug_to_code), None)
        state_code = slug_to_code.get(state_slug or "")
        city = state_slug.capitalize() if state_slug else None

        area = None
        if state_slug:
            index = parts.index(state_slug)
            if len(parts) > index + 1 and not parts[index + 1].isdigit():
                area = parts[index + 1].replace("-", " ").title()

        return {"state": state_code, "city": city, "area": area}


__all__ = ["KrentAdapter", "STATE_SLUGS"]