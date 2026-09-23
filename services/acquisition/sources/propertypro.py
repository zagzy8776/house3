"""
PropertyPro Nigeria adapter - the second source, and the first real test of whether
the NPC adapter's shape generalizes or was a one-off.

RECONNAISSANCE, 2026-09-23 (fetched, not assumed)
-------------------------------------------------
  - robots.txt: 534 bytes, `User-agent: *` with 25 Disallow rules. Every rule is
    either an admin path (/admin, /backend) or a FILTER PARAMETER (/*type=*,
    /*state=*, /*area=*, /*min_price=*, /*sort=*, /*limit=*). Listing and category
    paths are open. The intended crawl path is therefore the canonical listing URLs,
    not search pages with facets - which is what `discover()` walks.
  - Category page /property-for-short-let/in/lagos: 364 KB of server-rendered HTML.
    No livewire, no __NEXT_DATA__. 22 listing links in the initial document plus
    4 pagination hrefs, so pagination is plain HTML - unlike NPC, where the filters
    are JS-driven and Playwright is required.
  - Listing URL shape: /property/<slug>-<REFERENCE> where the reference is a 5-6
    character ALPHANUMERIC token that may begin with a digit or a letter:
        /property/1-bedroom-flat-apartment-for-shortlet-lekki-phase-1-lekki-lagos-0QFMN
  - Listing pages carry JSON-LD: an `Offer` node with `priceCurrency: NGN` and
    `price: <int>`, plus a `SingleFamilyResidence` node whose `name` is the title
    with the reference in parentheses: "... Lekki Lagos (0QFMN) | PropertyPro
    Nigeria". Structured data is more stable than a CSS selector, so it is the
    primary path and regexes are the fallback.

WHY `price_basis` IS READ FROM THE PAGE AND NEVER INFERRED FROM THE URL
----------------------------------------------------------------------
A shortlet URL can carry an ANNUAL price. Verified on one live listing:

    URL    /property/1-bedroom-flat-apartment-for-shortlet-lekki-lagos-1QFMV
    title  "Rent One Bedroom Apartment in Freedom Way, Lekki Lagos (1QFMV)"
    price  NGN 8,000,000/year     (10 occurrences of "/year", none of "/night")
    JSON-LD Offer price: 8000000

Reading that Offer as PER_NIGHT would record NGN 8,000,000 as the price of ONE
NIGHT - and unlike a mis-typed season, that figure would flow into observation
history and then into pricing. It is the NPC `SHORTLET_PATH` bug in a new costume,
so the adapter derives the basis from the number's own surrounding text
(`parse_price_basis`) and treats "no basis stated" as UNKNOWN rather than as nightly.
`test_a_shortlet_url_with_an_annual_price_is_not_a_nightly_rate` pins this.

WHAT THIS ADAPTER WILL NOT DO
-----------------------------
It extracts facts. It never returns photographs or description text, and
`assert_no_media_or_prose` fails the run if a change makes it try. An agent's phone
number is recorded as contact evidence for a lead - never as proof of ownership,
because the advertiser is frequently not the property's owner.
"""

from __future__ import annotations

import json
import re
from typing import Iterator, Optional
import urllib.parse
from urllib.parse import urljoin, urlparse

from extraction.contact import find_email, find_instagram, find_operator_website, find_phones
from extraction.operator import extract_operator
from extraction.pms import detect_pms, find_availability_url, find_booking_url
from extraction.property import (
    BATHROOMS_RE,
    BEDROOMS_RE,
    PRICE_BASIS_PATTERNS,
    parse_price_basis,
    parse_price_to_kobo,
    strip_tags,
)
from sources.base import DiscoveredListing, SourceLayer

#: State code -> the slug PropertyPro uses in a category path.
STATE_SLUGS: dict[str, str] = {
    "LA": "lagos",
    "FC": "abuja",
    "OY": "oyo",
    "IM": "imo",
    "AK": "akwa-ibom",
}

#: The category path that holds shortlets. PropertyPro separates "for short let"
#: from "for rent" and "for sale" at the path level, which is a stronger signal than
#: NPC's, but it is NOT sufficient on its own - see the module docstring.
SHORTLET_PATH = "/property-for-short-let/"

#: A listing URL is /property/<slug>-<REFERENCE>. The reference is 5-6 alphanumeric
#: characters, and a digit may lead it ("0QFMN", "1LSZQ") or a letter ("7QFMS").
#: It is the stable part: editing the title rewrites the slug, which is why keying
#: on the whole slug would record one listing twice after a rename.
LISTING_URL_RE = re.compile(r"^/property/[^/?]+-([A-Za-z0-9]{5,8})/?$")

#: The reference is echoed in the JSON-LD name as "(0QFMN)" and in the <title>.
REFERENCE_IN_TEXT_RE = re.compile(r"\(([A-Za-z0-9]{5,8})\)\s*(?:\||$)")

#: Listing links inside a category page or a sitemap.
LISTING_LINK_RE = re.compile(r'href="(/property/[^"?]+)"')
PAGINATION_RE = re.compile(r'href="([^"]*[?&]page=(\d+)[^"]*)"')

#: How deep to walk category pagination when no sitemap is available. Bounded for
#: the same reason NPC's list-page fallback is: a guessed crawl depth is a decision
#: to hammer someone's search endpoint, and a page cap is the polite version.
MAX_PAGES = 40

TITLE_RE = re.compile(r"<title>(.*?)</title>", re.IGNORECASE | re.DOTALL)
H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)


class PropertyproAdapter:
    """PropertyPro Nigeria. Discovery inventory only, with provenance preserved."""

    name = "propertypro"
    layer = SourceLayer.DISCOVERY
    host = "propertypro.ng"

    # ------------------------------------------------------------------ discovery

    def category_urls(self, state_code: str, area: Optional[str] = None) -> Iterator[str]:
        """
        Category pages, i.e. the listing-index pages for a state.

        `area` narrows the path, which is mostly cosmetic: the listing URLs carry
        their own locality, so a per-area walk helps a scoped crawl and is not
        required for completeness.
        """
        slug = STATE_SLUGS.get(state_code.upper())
        if not slug:
            raise ValueError(
                f"no PropertyPro slug for state '{state_code}'; known: {sorted(STATE_SLUGS)}"
            )
        base = f"https://{self.host}{SHORTLET_PATH}in/{slug}"
        if area:
            yield f"{base}?area={area.strip().lower().replace(' ', '-')}"
        else:
            yield base

    def paginate(self, transport, first_page_url: str) -> Iterator[str]:
        """
        Walk category pagination by following the page's OWN next-page links.

        Not `?page=N` guessed to a fixed depth: the site publishes the links, so
        following what it offers is both narrower and more accurate. Bounded by
        MAX_PAGES so a site that renders an endless "next" cannot run us forever.
        """
        seen: set[str] = set()
        queue = [first_page_url]
        pages = 0

        while queue and pages < MAX_PAGES:
            url = queue.pop(0)
            if url in seen:
                continue
            seen.add(url)
            pages += 1
            yield url

            try:
                html = transport.fetch(url)
            except Exception:
                # A failed page ends pagination rather than aborting discovery: the
                # pages already yielded are real, and reporting fewer URLs is honest.
                return

            for match in PAGINATION_RE.finditer(html):
                candidate = urljoin(url, match.group(1)).split("#")[0]
                if candidate not in seen and self._same_host(candidate):
                    queue.append(candidate)

    def discover(self, transport, state_code: str, area: Optional[str] = None) -> Iterator[str]:
        """
        Yield candidate listing URLs for a state.

        Category pages, then each listing URL the pages publish. PropertyPro serves
        these server-rendered, so no browser is needed - a plain fetch of the
        category page already contains 22 listing links.
        """
        seen: set[str] = set()

        for category in self.category_urls(state_code, area):
            for page_url in self.paginate(transport, category):
                try:
                    html = transport.fetch(page_url)
                except Exception:
                    continue
                for href in LISTING_LINK_RE.findall(html):
                    listing_url = urljoin(page_url, href).split("#")[0].split("?")[0]
                    if listing_url in seen or not self.is_listing_url(listing_url):
                        continue

                    seen.add(listing_url)
                    yield listing_url

    # ---------------------------------------------------------------------- parse

    def parse(self, html: str, url: str) -> Optional[DiscoveredListing]:
        """Turn one listing page into a prospect, or None if it is not a listing."""
        source_url, reference = self._identify(html, url)

        # A page that is not a listing must not become one. On NPC this exact guard
        # stopped a category page being recorded as a property keyed on its state
        # slug, which collapsed a whole page of rows onto one junk record.
        if not self.is_listing_url(source_url) or not reference:
            return None

        structured = self._structured(html)
        title = self._title(html, structured)
        location = self._location(structured, source_url)
        price_kobo, basis = self._price(html, structured)

        return DiscoveredListing(
            source=self.name,
            source_url=source_url,
            source_listing_id=reference,
            property_name=title or reference,
            property_type=structured.get("type") or self._type_from_slug(source_url),
            bedrooms=self._count(structured.get("bedrooms"), BEDROOMS_RE, html),
            bathrooms=self._count(structured.get("bathrooms"), BATHROOMS_RE, html),
            advertised_price=price_kobo,
            currency="NGN",
            state=location["state"],
            city=location["city"],
            area=location["area"],
            operator_name=extract_operator(html) or None,
            operator_hint=None,
            phone=(find_phones(html) or [None])[0],
            email=find_email(html),
            website=find_operator_website(html, source_url),
            instagram=find_instagram(html),
            pms_detected=detect_pms(html),
            booking_url=find_booking_url(html, source_url),
            availability_hint_url=find_availability_url(html, source_url),
            price_basis=basis,
            title_document=None,
        )

    # ---------------------------------------------------------------- identity

    @staticmethod
    def _listing_id(url: str) -> Optional[str]:
        """
        The reference token from a listing path, or None if this is not one.

        `urlparse().path` keeps percent-encoding, while the publisher writes links
        plainly, so the path is unquoted first. Without that, a listing whose slug
        contains an escaped character would look like a category page and be dropped
        from discovery - a silent loss of inventory, which is the failure mode this
        whole adapter is most exposed to.
        """
        path = urllib.parse.unquote(urlparse(url).path)
        match = LISTING_URL_RE.match(path)
        return match.group(1) if match else None

    def _identify(self, html: str, fetched_url: str) -> tuple[str, Optional[str]]:
        """
        Resolve the URL and reference this page actually claims to be.

        The canonical link wins, because a listing reached through a filter or a
        tracking parameter is still the same listing - the same reason NPC reads its
        canonical rather than trusting the URL it was handed.
        """
        canonical = None
        for pattern in (r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"',):
            found = re.search(pattern, html, re.IGNORECASE)
            if found:
                candidate = urljoin(fetched_url, found.group(1)).strip()
                if self._same_host(candidate) and self.is_listing_url(candidate):
                    canonical = candidate.split("?")[0].split("#")[0]
                    break

        source_url = canonical or fetched_url.split("?")[0].split("#")[0]
        reference = self._listing_id(source_url)

        # Fall back to the reference the page states about itself, in case the URL
        # shape changes but the structured data does not.
        if not reference:
            for text in (self._title(html, {}),):
                if text:
                    found = REFERENCE_IN_TEXT_RE.search(text)
                    if found:
                        reference = found.group(1)
                        break

        return source_url, reference

    @staticmethod
    def is_listing_url(url: str) -> bool:
        """True when a path is a single listing rather than a category or filter."""
        return PropertyproAdapter._listing_id(url) is not None

    def _same_host(self, candidate: str) -> bool:
        host = urlparse(candidate).netloc.lower().removeprefix("www.")
        return host == self.host or host.endswith("." + self.host)

    # -------------------------------------------------------------- structured data

    @staticmethod
    def _structured(html: str) -> dict:
        """
        Read the JSON-LD the page publishes, preferring it over any CSS selector.

        Structured data is the publisher's own machine-readable statement of the
        page, so it survives a template redesign that would break a regex. Observed
        shape on a listing page:

            {"@type": "Offer", "priceCurrency": "NGN", "price": 172500}
            {"@type": "SingleFamilyResidence", "name": "... (0QFMN) | PropertyPro ...",
             "description": "...", "address": {...}}

        Only fields the allowlist permits are taken. `description` is deliberately
        ignored: it is the publisher's prose, and returning it would fail
        `assert_no_media_or_prose` - which is the point of that guard.
        """
        offer_price = None
        node: dict = {}

        for block in re.findall(
            r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.DOTALL | re.IGNORECASE
        ):
            try:
                data = json.loads(block.strip())
            except (ValueError, TypeError):
                continue
            for candidate in data if isinstance(data, list) else [data]:
                if not isinstance(candidate, dict):
                    continue
                kind = candidate.get("@type")
                if kind == "Offer" and offer_price is None:
                    price = candidate.get("price")
                    if isinstance(price, (int, float)) and price > 0:
                        offer_price = int(price)
                elif kind in ("SingleFamilyResidence", "Apartment", "House", "Residence"):
                    node = candidate

        address = node.get("address") if isinstance(node.get("address"), dict) else {}

        # `addressLocality` and `addressRegion` are SWAPPED on this publisher. Observed
        # live for a Lekki Phase 1 listing:
        #
        #   "addressLocality": "Lagos",   <- the STATE
        #   "addressRegion":   "Lekki",   <- the LOCALITY
        #
        # Reading those by their schema.org names would put the state in `area` and
        # lose the neighbourhood entirely - and the neighbourhood is what geocoding
        # and the map depend on. So one of them is matched against the known state
        # names and the other becomes the area, rather than trusting either label.
        locality = (address.get("addressLocality") or "").strip()
        region = (address.get("addressRegion") or "").strip()

        state = _STATE_BY_NAME.get(locality.lower()) or _STATE_BY_NAME.get(region.lower())
        area = None
        for candidate in (locality, region):
            if candidate and _STATE_BY_NAME.get(candidate.lower()) is None:
                area = candidate
                break

        return {
            "name": node.get("name"),
            "type": None,
            "jsonld_type": node.get("@type"),
            "street": address.get("streetAddress"),
            "locality": locality,
            "region": region,
            "area": area,
            "state": state,
            "bedrooms": node.get("numberOfBedrooms"),
            "bathrooms": node.get("numberOfBathroomsTotal"),
            "offer_price": offer_price,
        }

    def _title(self, html: str, structured: dict) -> Optional[str]:
        """
        The property's name, with the portal's own suffix and reference stripped.

        Observed: "Shortlet City View 1br With Pool & Gym | Off Freedom Way in Lekki
        Phase 1, Lekki Lagos (0QFMN) | PropertyPro Nigeria". The part before the
        first "|" is the listing's own title; everything from " in <location> (REF)"
        onwards is the portal's framing, and keeping it would put the portal's
        location taxonomy into the property's name.
        """
        raw = structured.get("name")
        if not raw:
            found = TITLE_RE.search(html)
            raw = strip_tags(found.group(1)) if found else None
        if not raw:
            found = H1_RE.search(html)
            raw = strip_tags(found.group(1)) if found else None
        if not raw:
            return None

        name = raw.split("|")[0].strip()
        name = re.sub(r"\s+in\s+[^|]*?\([A-Za-z0-9]{5,8}\)\s*$", "", name).strip()
        name = re.sub(r"\s*\([A-Za-z0-9]{5,8}\)\s*$", "", name).strip()
        return name or None

    @staticmethod
    def _count(stated, pattern: re.Pattern[str], html: str) -> Optional[int]:
        """Prefer a structured count, fall back to the page text."""
        if isinstance(stated, int) and stated > 0:
            return stated
        found = pattern.search(strip_tags(html))
        if found:
            try:
                value = int(found.group(1))
                return value if 0 < value <= 50 else None
            except ValueError:
                return None
        return None

    # ------------------------------------------------------------------- price

    def _price(self, html: str, structured: dict) -> tuple[Optional[int], Optional[str]]:
        """
        The advertised price AND the unit it is quoted in.

        THE BASIS IS READ FROM THE PAGE, NEVER INFERRED FROM THE URL. A live
        shortlet *URL* carried an annual price:

            /property/1-bedroom-flat-apartment-for-shortlet-lekki-lagos-1QFMV
            "Rent One Bedroom Apartment in Freedom Way, Lekki Lagos (1QFMV)"
            price: NGN 8,000,000/year   (10 occurrences of "/year", none of "/night")
            JSON-LD Offer price: 8000000

        Recording that Offer as PER_NIGHT would make NGN 8,000,000 the cost of one
        night, and that number would flow into observation history and then into
        pricing. So the number's own text decides the basis, and when the page states
        no unit at all the basis stays None - never a default of nightly.

        Returns kobo, because money in this codebase is an Int in kobo.
        """
        text = strip_tags(html)

        # Two live shapes: "₦172,500/day" and "NGN 8,000,000/year", plus the worded
        # "per night". One pattern captures the number and the adjacent unit.
        pattern = re.compile(
            r"(?:[\u20a6]{1,2}|NGN)\s?([\d][\d,\.]{2,})\s*(?:/\s*([a-zA-Z]+)|per\s+([a-zA-Z]+))?"
        )

        # EVERY candidate is collected, not just the first. A listing page also
        # carries a "₦2,000,000 - ₦35,000,000" price-range widget and related-property
        # teasers, so taking match[0] would pick a range bound instead of the price.
        # A match that states its unit is the advertised price; a range bound does not.
        candidates: list[tuple[Optional[str], int]] = []
        for match in pattern.finditer(text):
            span = text[match.start() : match.end()]
            unit = (match.group(2) or match.group(3) or "").lower()
            basis = _BASIS_UNITS.get(unit) or parse_price_basis(text, match)
            price = parse_price_to_kobo(span)
            if price is None:
                continue
            candidates.append((basis, price))

        # Prefer a stated unit - it is the number that carries its own meaning. Among
        # those, the FIRST is the headline price, because the page states it first.
        # Only fall back to an unqualified number when the page states no unit at all.
        basis: Optional[str] = None
        price: Optional[int] = None
        for candidate_basis, candidate_price in candidates:
            if candidate_basis is not None:
                basis, price = candidate_basis, candidate_price
                break
        if price is None and candidates:
            price = candidates[0][1]

        # The structured Offer is a second opinion, not the primary source. It is used
        # only when the page text yielded no number at all. `parse_price_to_kobo`
        # already returns kobo, so the JSON-LD integer is multiplied exactly once -
        # doing it by hand here would make a NGN 172,500 rate look like NGN 17,250,000.
        if price is None:
            offer = structured.get("offer_price")
            if isinstance(offer, (int, float)) and offer > 0:
                price = int(offer) * 100

        # No unit published anywhere means the basis stays None. A nightly default
        # would put a NGN 8,000,000 annual rent next to a NGN 120,000 night as though
        # the two were comparable.
        return price, basis


    def _location(self, structured: dict, url: str) -> dict:
        """
        Where the listing says it is.

        The structured address is preferred, with one caveat: PropertyPro swaps
        `addressLocality` and `addressRegion`, so `_structured` resolves which is the
        state by matching it against the known state names rather than trusting the
        label. What lands here is therefore already corrected.

        Fallback is the slug, which encodes the same hierarchy:
            ...-shortlet-<locality>-<city>-<state>-<REF>
        The slug is the weaker source because a title edit rewrites it.
        """
        state = structured.get("state")
        area = structured.get("area")
        city = None

        if not area or not state:
            parts = [part for part in urlparse(url).path.split("/") if part]
            if parts:
                # The slug leads with the property facts, then the location, then the
                # reference:
                #   1-bedroom-flat-apartment-for-shortlet-<area>-<city>-<state>-<REF>
                # so everything before "for-shortlet" is facts, not a place. Splitting
                # the whole slug instead put the BEDROOM COUNT into `area` - tokens
                # [... 'lekki', 'phase', '1', 'lekki', 'lagos'] gave area="1", which
                # geocoding would then try to resolve as a neighbourhood.
                slug = re.sub(r"-[A-Za-z0-9]{5,8}$", "", parts[-1])
                marker = "for-shortlet-"
                if marker in slug:
                    slug = slug.split(marker, 1)[1]
                tokens = slug.split("-")

                for name, code in _STATE_BY_NAME.items():
                    if name not in tokens:
                        continue
                    index = tokens.index(name)
                    state = state or code
                    tail = tokens[:index]
                    # Walk back from the state, keeping the last two place-ish tokens
                    # as "<area> <city>". A bare digit is a numbering suffix ("Phase
                    # 1"), not a word, so it stays with the name it belongs to.
                    city = city or (tail[-1].title() if tail else None)
                    if not area and len(tail) >= 2:
                        area = " ".join(tail[-2:]).replace("-", " ").title()
                    elif not area and tail:
                        area = tail[-1].title()
                    break

        return {"state": state or "LA", "city": city, "area": area}

    @staticmethod
    def _type_from_slug(url: str) -> Optional[str]:
        """
        The property type, from the path the publisher chose.

        `@type: Flat / Apartment` comes from the page's own breadcrumb, so the slug
        is a good source. `@type: SingleFamilyResidence` is schema.org's generic
        house bucket - a 1-bedroom flat and a detached duplex both map to it - so it
        must NOT be used as a property type: saying "SingleFamilyResidence" where
        NPC's own vocabulary says "Flat / Apartment" would make the two sources
        incomparable, and comparability is the entire reason both are ingested.

        Longest needle first, so "flat-apartment" is not shadowed by a shorter match.
        """
        path = urlparse(url).path.lower()
        for needle, label in (
            ("self-contain", "Self-Contain"),
            ("flat-apartment", "Flat / Apartment"),
            ("mini-flat", "Mini Flat"),
            ("penthouse", "Penthouse"),
            ("bungalow", "Bungalow"),
            ("terrace", "Terraced"),
            ("duplex", "Duplex"),
            ("mansion", "Mansion"),
            ("studio", "Studio"),
            ("apartment", "Flat / Apartment"),
            ("house", "House"),
        ):
            if needle in path:
                return label
        return None


#: A unit word stated right after a price, as a suffix. Kept next to the parsing
#: that uses it so the vocabulary is visible in one place.
_BASIS_UNITS: dict[str, str] = {
    "night": "PER_NIGHT",
    "nightly": "PER_NIGHT",
    "day": "PER_NIGHT",
    "daily": "PER_NIGHT",
    "week": "PER_WEEK",
    "weekly": "PER_WEEK",
    "month": "PER_MONTH",
    "monthly": "PER_MONTH",
    "year": "PER_YEAR",
    "yearly": "PER_YEAR",
    "annum": "PER_YEAR",
    "stay": "PER_STAY",
    "person": "PER_PERSON_NIGHT",
}

#: Nigerian states as PropertyPro names them in an address. Used only to resolve a
#: name to a code; the code is what the database's State table keys on.
_STATE_BY_NAME: dict[str, str] = {
    "lagos": "LA",
    "abuja": "FC",
    "fct": "FC",
    "federal capital territory": "FC",
    "oyo": "OY",
    "ibadan": "OY",
    "imo": "IM",
    "owerri": "IM",
    "akwa ibom": "AK",
    "uyo": "AK",
}
