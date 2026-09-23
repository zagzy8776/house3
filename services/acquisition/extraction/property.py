"""
Property field extraction - the facts we are allowed to keep.

Price, type, bedrooms, bathrooms, area and title document. Nothing else.

Parsing is layered on purpose:
  1. JSON-LD, if the page publishes schema.org data. Structured and stable.
  2. Open Graph / meta tags.
  3. Regex over markup.

The regex layer is tuned per portal and DOES need verifying against raw HTML
before a production crawl. Run with `--dump-html <url>` to capture a page and
check the patterns; do not assume these hold.
"""

from __future__ import annotations

import html as html_module
import json
import re
from typing import Any, Optional

PRICE_RE = re.compile(r"(?:₦|&#8358;|NGN|N)\s?([\d][\d,\.]{2,})", re.IGNORECASE)
BEDROOMS_RE = re.compile(r"\b(\d+)\s*(?:bedroom|bedrooms|bed|br)\b", re.IGNORECASE)
BATHROOMS_RE = re.compile(r"\b(\d+)\s*(?:bathroom|bathrooms|bath)\b", re.IGNORECASE)
H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
JSONLD_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.IGNORECASE | re.DOTALL
)
OG_TITLE_RE = re.compile(r'property=["\']og:title["\'][^>]*content=["\']([^"\']+)', re.IGNORECASE)

PROPERTY_TYPES: dict[str, str] = {
    "short let": "SHORTLET",
    "shortlet": "SHORTLET",
    "flat": "APARTMENT",
    "apartment": "APARTMENT",
    "studio": "STUDIO",
    "duplex": "HOUSE",
    "bungalow": "HOUSE",
    "house": "HOUSE",
    "terrace": "HOUSE",
    "penthouse": "APARTMENT",
    "hostel": "HOSTEL",
    "hotel": "HOTEL",
    "room": "ROOM",
    "villa": "VILLA",
}

TITLE_PATTERNS: list[tuple[str, str]] = [
    (r"certificate of occupancy", "C_OF_O"),
    (r"\bc\s*of\s*o\b", "C_OF_O"),
    (r"governor'?s consent", "GOVERNORS_CONSENT"),
    (r"deed of assignment", "DEED_OF_ASSIGNMENT"),
    (r"excision|gazette", "EXCISION_GAZETTE"),
    (r"right of occupancy", "RIGHT_OF_OCCUPANCY"),
    (r"freehold", "FREEHOLD"),
    (r"registered deed", "REGISTERED_DEED"),
]


def strip_tags(value: str) -> str:
    return html_module.unescape(TAG_RE.sub(" ", value)).strip()


def parse_price_to_kobo(raw: Optional[str]) -> Optional[int]:
    """
    "NGN 220,000" / "₦220,000 /day" / "1,200,000" -> kobo.

    Below 1,000 naira is treated as a parse error, because the alternative is
    recording "3 bedrooms" as a 3 naira nightly rate.
    """
    if not raw:
        return None
    digits = re.sub(r"[^\d]", "", raw)
    if not digits:
        return None
    naira = int(digits)
    return None if naira < 1_000 else naira * 100


def first_int(pattern: re.Pattern[str], text: str) -> Optional[int]:
    match = pattern.search(text)
    return int(match.group(1)) if match else None


#: How a source states the unit a price is quoted in, longest phrase first so
#: "per person per night" is not read as "per night".
#:
#: "per day" maps to PER_NIGHT deliberately: for a shortlet one day's stay is one
#: night, and giving the two their own values would mean two spellings of one rate
#: that every later calculation has to reconcile. What is NOT acceptable is what
#: happened before this existed - "per day", "per night", "per annum" and "per
#: month" all arrived as UNKNOWN, so a NGN 500,000 nightly rate and a NGN 500,000
#: annual rent looked identical in the database.
PRICE_BASIS_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"per\s+person\s+per\s+night|per\s+person\s*/?\s*night", re.IGNORECASE), "PER_PERSON_NIGHT"),
    (re.compile(r"per\s+night|nightly|a\s+night|/\s*night", re.IGNORECASE), "PER_NIGHT"),
    (re.compile(r"per\s+day|daily|a\s+day|/\s*day", re.IGNORECASE), "PER_NIGHT"),
    (re.compile(r"per\s+week|weekly", re.IGNORECASE), "PER_WEEK"),
    (re.compile(r"per\s+month|monthly|per\s+calendar\s+month|p\.?c\.?m\.?", re.IGNORECASE), "PER_MONTH"),
    (re.compile(r"per\s+annum|per\s+year|yearly|annually|p\.?a\.\b", re.IGNORECASE), "PER_YEAR"),
    (re.compile(r"per\s+stay|for\s+the\s+stay", re.IGNORECASE), "PER_STAY"),
)

#: Every value the PriceBasis enum accepts. Kept beside the patterns that emit
#: them, and compared against prisma/schema.prisma by a test, so a new enum value
#: cannot be added to the database without the reader learning to produce it.
PRICE_BASES = frozenset(
    {
        "PER_NIGHT",
        "PER_WEEK",
        "PER_MONTH",
        "PER_YEAR",
        "PER_STAY",
        "PER_PERSON_NIGHT",
        "UNKNOWN",
    }
)

#: How far either side of the price the unit is allowed to be stated.
PRICE_BASIS_WINDOW = 60


def parse_price_basis(text: str, price_match: Optional[re.Match[str]] = None) -> Optional[str]:
    """
    The unit a price is quoted in, taken from the words around it.

    Scoped to the neighbourhood of the price on purpose: scanning the whole page
    would pick up "Annual Rent" from a payment-terms block or a sibling listing in
    a sidebar, and attaching the wrong basis is worse than leaving it unknown.

    Returns None when nothing is stated, which becomes UNKNOWN. Unknown stays
    unknown; the point is that a *stated* basis must not.
    """
    if price_match is not None:
        after = text[price_match.end() : price_match.end() + PRICE_BASIS_WINDOW]
        before = text[max(0, price_match.start() - PRICE_BASIS_WINDOW) : price_match.start()]
        windows = (after, before)
    else:
        windows = (text,)

    for window in windows:
        for pattern, basis in PRICE_BASIS_PATTERNS:
            if pattern.search(window):
                return basis
    return None


def parse_json_ld(html: str) -> dict[str, Any]:
    """Flatten any schema.org blocks the page publishes."""
    merged: dict[str, Any] = {}
    for block in JSONLD_RE.findall(html):
        try:
            payload = json.loads(block.strip())
        except json.JSONDecodeError:
            continue

        items = payload if isinstance(payload, list) else [payload]
        for item in items:
            if not isinstance(item, dict):
                continue
            for key, value in item.items():
                merged.setdefault(key, value)
    return merged


def extract_property_name(html: str) -> Optional[str]:
    og = OG_TITLE_RE.search(html)
    if og:
        return html_module.unescape(og.group(1)).strip()

    ld = parse_json_ld(html)
    if isinstance(ld.get("name"), str):
        return ld["name"].strip()

    h1 = H1_RE.search(html)
    if h1:
        text = strip_tags(h1.group(1))
        if text:
            return html_module.unescape(text)

    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    if title_match:
        # Portals suffix page titles with the portal name; drop that.
        return strip_tags(title_match.group(1)).split("|")[0].strip() or None
    return None


def extract_property_type(html: str) -> Optional[str]:
    ld = parse_json_ld(html)
    for key in ("@type", "category", "propertyType"):
        value = ld.get(key)
        if isinstance(value, str):
            lowered = value.lower()
            for needle, canonical in PROPERTY_TYPES.items():
                if needle in lowered:
                    return canonical

    # Fall back to a type label rendered near the listing.
    text = strip_tags(html).lower()
    for needle, canonical in PROPERTY_TYPES.items():
        if needle in text:
            return canonical
    return None


def extract_title_document(text: str) -> Optional[str]:
    lowered = text.lower()
    for pattern, value in TITLE_PATTERNS:
        if re.search(pattern, lowered):
            return value
    return None
