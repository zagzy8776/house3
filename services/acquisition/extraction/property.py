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
