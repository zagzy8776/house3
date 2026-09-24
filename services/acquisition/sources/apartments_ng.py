"""
Apartments.ng adapter - updated for actual site structure (2026-09-24).

RECONNAISSANCE:
  - Osclass 3.8.0 based site with custom "wizestate" theme
  - Short lets at /search/pattern,short let (category 47)
  - Listing URLs: /real-estate/residential-short-lets/<slug>_<numeric_id>
  - Gallery images in <a class="pd-g" href="..."> with data-fancybox
  - Price in .pd-pr with "per Night"/"per Month" suffix
  - Bedrooms/baths in .pd-fact with icons
  - Host/agent in .pd-hostcard with profile link
  - robots.txt allows crawling, sitemap at /sitemap-p25
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

# URL patterns observed on the live site
SHORTLET_SEARCH_PATH = "/search/pattern,short let"
# Two listing path patterns observed:
# 1. /real-estate/residential-short-lets/<slug>_<id>  (detail page canonical)
# 2. /apartments-in-<city>/<area>/<slug>_<id>         (search results)
LISTING_PATHS = (
    "/real-estate/residential-short-lets/",
    "/apartments-in-",
)

# Listing ID is the numeric suffix after the last underscore in the URL
# e.g. .../henryroyalapartments_1407 -> 1407
LISTING_ID_RE = re.compile(r"_(\d+)(?:[/?#]|$)")

# State/area detection from breadcrumb or URL
STATE_SLUGS: dict[str, str] = {
    "LA": "lagos",
    "FC": "abuja",
    "OY": "ibadan",
    "IM": "owerri",
    "AK": "uyo",
}

# Breadcrumb / URL patterns for location
BREADCRUMB_RE = re.compile(r'<a href="[^"]*region,([^"]+)">([^<]+)</a>')
CATEGORY_RE = re.compile(r'<a href="[^"]*category,47[^"]*">([^<]+)</a>')

# Sitemap regexes
SITEMAP_LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.IGNORECASE)
PLAIN_URL_RE = re.compile(r"^\s*(https?://\S+)\s*$", re.MULTILINE)

# Listing card on search page - two patterns observed:
# 1. Homepage featured cards: <a class="custom-card" href="...">
# 2. Search results: <div class="item"><a href="...">
CARD_LINK_RE = re.compile(r'(?:class="custom-card"|class="item">\s*<a)\s+href="([^"]+)"')
PAGINATION_RE = re.compile(r'href="([^"]*page=(\d+)[^"]*)"')

MAX_PAGES = 20


class ApartmentsNgAdapter:
    """Apartments.ng discovery adapter - matches live site structure."""

    name = "apartments_ng"
    layer = SourceLayer.DISCOVERY
    host = "apartments.ng"
    base_url = "https://apartments.ng"
    sitemap_index = "https://apartments.ng/sitemap-p25"

    def sitemap_listing_urls(self, transport) -> list[str]:
        """Fetch listing URLs from sitemap if available."""
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

    def search_page_urls(self, state_code: str, area: Optional[str] = None) -> Iterator[str]:
        """Search result pages for short lets."""
        base = f"{self.base_url}{SHORTLET_SEARCH_PATH}"
        if area:
            # Area filter via pattern
            base = f"{self.base_url}/search/pattern,{area.strip().lower().replace(' ', '%20')}"
        yield base

        # Pagination - the site uses page parameter
        for page in range(2, MAX_PAGES + 1):
            yield f"{base}&page={page}"

    def discover(self, transport, state_code: str, area: Optional[str] = None) -> Iterator[str]:
        """Yield candidate listing URLs for a state."""
        # Try sitemap first
        listing_urls = self.sitemap_listing_urls(transport)

        slug = STATE_SLUGS.get(state_code)
        if slug:
            matched = [
                url for url in listing_urls
                if any(lp in url for lp in LISTING_PATHS) and (f"/{slug}/" in url.lower() or slug in url.lower())
            ]
            if area:
                area_lower = area.strip().lower().replace(' ', '-')
                matched = [url for url in matched if area_lower in url.lower()]
            if matched:
                yield from matched
                return

        # Fallback: search pages
        seen: set[str] = set()
        for page_url in self.search_page_urls(state_code, area):
            try:
                html = transport.fetch(page_url)
            except Exception:
                break

            for href in CARD_LINK_RE.findall(html):
                listing_url = urljoin(page_url, href).split("#")[0].split("?")[0]
                if listing_url in seen or not self._is_listing_url(listing_url):
                    continue
                seen.add(listing_url)
                yield listing_url

    def parse(self, html: str, url: str) -> Optional[DiscoveredListing]:
        """Turn a listing page into a DiscoveredListing."""
        source_url, listing_id = self._identify(html, url)

        if not self._is_listing_url(source_url):
            return None

        # Extract name from title or h1
        name = self._extract_name(html)
        if not name:
            return None

        plain = strip_tags(html)

        # Extract location from breadcrumb
        location = self._extract_location(html, source_url)

        # Extract price and basis
        price_match = self._extract_price(html)
        advertised_price = parse_price_to_kobo(price_match[0] if price_match else None)
        price_basis = price_match[1] if price_match else None

        # Extract bedrooms/bathrooms
        bedrooms = self._extract_bedrooms(html)
        bathrooms = self._extract_bathrooms(html)

        # Extract property type
        property_type = self._extract_property_type(html)

        # Extract operator/host info
        website, operator_name, operator_hint = self._extract_operator(html)

        # Extract contact
        phones = find_phones(html)
        email = find_email(html)
        instagram = find_instagram(html)

        # Extract gallery
        gallery = self._extract_gallery(html, source_url, listing_id)

        return DiscoveredListing(
            source=self.name,
            source_url=source_url,
            source_listing_id=listing_id,
            property_name=name[:200],
            property_type=property_type,
            bedrooms=bedrooms,
            bathrooms=bathrooms,
            advertised_price=advertised_price,
            price_basis=price_basis,
            currency="NGN",
            state=location.get("state"),
            city=location.get("city"),
            area=location.get("area"),
            operator_name=operator_name,
            operator_hint=operator_hint,
            phone=phones[0] if phones else None,
            email=email,
            website=website,
            instagram=instagram,
            pms_detected=detect_pms(html),
            booking_url=find_booking_url(html, source_url),
            availability_hint_url=find_availability_url(html, source_url),
            title_document=extract_title_document(plain),
            media=gallery,
            cover_image_url=cover_from(gallery),
        )

    def _extract_name(self, html: str) -> Optional[str]:
        """Extract property name from h1.pd-title or title tag."""
        # Try h1.pd-title first
        h1_match = re.search(r'<h1[^>]+class="pd-title"[^>]*>([^<]+)</h1>', html)
        if h1_match:
            return h1_match.group(1).strip()

        # Try title tag
        title_match = re.search(r'<title>([^<]+)</title>', html)
        if title_match:
            title = title_match.group(1)
            # Remove site suffix
            title = title.replace(" - Find Apartments in Nigeria.", "").strip()
            return title

        return None

    def _extract_location(self, html: str, url: str) -> dict[str, Optional[str]]:
        """Extract location from breadcrumb trail."""
        # Try breadcrumb for region/area
        breadcrumbs = BREADCRUMB_RE.findall(html)
        area = None
        city = None
        state = None

        for href, label in breadcrumbs:
            label = label.strip()
            if label.lower() in ("lagos", "abuja", "ibadan", "owerri", "uyo"):
                city = label
                state = STATE_SLUGS.get(city[:2].upper())
            elif label and label not in ("Home", "Residential Short Lets"):
                area = label

        # Fallback: try to infer from URL
        if not state:
            for code, slug in STATE_SLUGS.items():
                if f"/{slug}/" in url.lower() or url.lower().endswith(f"/{slug}"):
                    state = code
                    city = slug.capitalize()
                    break

        # Try to get area from URL path
        if not area and state:
            parts = urlparse(url).path.split("/")
            for part in parts:
                if part.lower() in ("lekki", "ikoyi", "victoria island", "ikeja", "ajah", "surulere", "yaba", "gbagada", "magodo"):
                    area = part.replace("-", " ").title()
                    break

        return {"state": state, "city": city, "area": area}

    def _extract_price(self, html: str) -> Optional[tuple[str, str]]:
        """Extract price and basis from .pd-pr element."""
        # <div class="pd-pr"><b>₦70,000</b><span>per Night</span></div>
        match = re.search(r'class="pd-pr"[^>]*><b>([^<]+)</b><span>([^<]+)</span>', html)
        if match:
            price_text = match.group(1).strip()
            basis_text = match.group(2).strip().lower()
            basis = self._parse_basis(basis_text)
            return price_text, basis
        return None

    def _parse_basis(self, text: str) -> str:
        """Parse price basis from text like 'per Night', 'per Month', etc."""
        text = text.lower()
        if "night" in text:
            return "PER_NIGHT"
        elif "month" in text:
            return "PER_MONTH"
        elif "week" in text:
            return "PER_WEEK"
        elif "year" in text or "annum" in text:
            return "PER_YEAR"
        return "UNKNOWN"

    def _extract_bedrooms(self, html: str) -> Optional[int]:
        """Extract bedrooms from .pd-fact with bed icon."""
        # <div class="pd-fact"><div class="pd-fact-i">🛏️</div><b>2</b><span>Bedrooms</span></div>
        match = re.search(r'class="pd-fact-i">[^<]*🛏️[^<]*</div><b>(\d+)</b><span>Bedrooms?', html)
        if match:
            return int(match.group(1))
        return None

    def _extract_bathrooms(self, html: str) -> Optional[int]:
        """Extract bathrooms from .pd-fact with shower icon."""
        match = re.search(r'class="pd-fact-i">[^<]*🚿[^<]*</div><b>(\d+)</b><span>Bathrooms?', html)
        if match:
            return int(match.group(1))
        return None

    def _extract_property_type(self, html: str) -> Optional[str]:
        """Extract property type from .pd-tag."""
        match = re.search(r'class="pd-tag"[^>]*>([^<]+)</span>', html)
        if match:
            tag = match.group(1).strip()
            # Map to standard types
            tag_lower = tag.lower()
            if "apartment" in tag_lower or "flat" in tag_lower:
                return "Flat / Apartment"
            elif "house" in tag_lower:
                return "House"
            elif "duplex" in tag_lower:
                return "Duplex"
            elif "studio" in tag_lower:
                return "Studio"
            return tag
        return None

    def _extract_operator(self, html: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
        """Extract host/agent info from .pd-hostcard."""
        # <a href="https://apartments.ng/user/profile/8569"><b>Abdulsatar</b></a>
        match = re.search(r'class="pd-hostcard"[^>]*>.*?<a href="([^"]+)"><b>([^<]+)</b></a>', html, re.DOTALL)
        if match:
            website = match.group(1).strip()
            name = match.group(2).strip()
            # Check if it's a landlord or agent
            if "landlord" in html.lower() or "owner" in html.lower():
                return website, name, None
            return website, None, name  # hint
        return None, None, None

    def _extract_gallery(self, html: str, page_url: str, listing_id: str) -> tuple[str, ...]:
        """Extract gallery images from .pd-g links."""
        # <a class="pd-g" href="https://apartments.ng/oc-content/uploads/14/7581.jpg" data-fancybox="images" title="...">
        #   <img src="https://apartments.ng/oc-content/uploads/14/7581.jpg" alt="...">
        # </a>
        images = []
        seen = set()

        for match in re.finditer(r'class="pd-g"[^>]*href="([^"]+)"', html):
            img_url = match.group(1).strip()
            absolute = urljoin(page_url, img_url)
            if absolute not in seen:
                seen.add(absolute)
                images.append(absolute)

        return tuple(images)

    @staticmethod
    def _listing_id(url: str) -> str:
        match = LISTING_ID_RE.search(urlparse(url).path)
        if match:
            return match.group(1)
        return urlparse(url).path.rstrip("/").rsplit("/", 1)[-1]

    def _identify(self, html: str, fetched_url: str) -> tuple[str, str]:
        """Resolve canonical URL and listing ID."""
        # Check canonical link
        canonical_match = re.search(r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"', html)
        if canonical_match:
            candidate = canonical_match.group(1).strip()
            if candidate and self._same_host(candidate):
                return candidate, self._listing_id(candidate)

        return fetched_url, self._listing_id(fetched_url)

    def _is_listing_url(self, url: str) -> bool:
        path = urlparse(url).path
        return any(lp in path for lp in LISTING_PATHS) and bool(LISTING_ID_RE.search(path))

    def _same_host(self, candidate: str) -> bool:
        expected = self.host.replace("www.", "")
        host = urlparse(candidate).netloc.replace("www.", "")
        return bool(host) and (host == expected or host.endswith(f".{expected}"))


__all__ = ["ApartmentsNgAdapter", "STATE_SLUGS"]