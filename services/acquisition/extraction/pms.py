"""
Booking-infrastructure detection.

The highest-value field the acquisition pipeline produces. An operator already
running a channel manager can onboard through PARTNER_API or ICAL_FEED, so their
live calendar and rates arrive without anyone retyping them. Onboarding cost
dominates CAC, which makes this the strongest predictor of a lead worth calling.

Detection is by hostname fingerprint in the page, plus explicit iCal/feed links.
"""

from __future__ import annotations

import re
from typing import Optional

#: hostname fragment -> canonical product name
PMS_FINGERPRINTS: dict[str, str] = {
    "smoobu.com": "smoobu",
    "beds24.com": "beds24",
    "hostaway.com": "hostaway",
    "lodgify.com": "lodgify",
    "guesty.com": "guesty",
    "cloudbeds.com": "cloudbeds",
    "littlehotelier.com": "littlehotelier",
    "hotelrunner.com": "hotelrunner",
    "resavenue.com": "resavenue",
    "ical.airbnb": "airbnb_ical",
    "airbnb.com/calendar": "airbnb_ical",
    "booking.com/hotel": "booking_com",
    "agoda.com": "agoda",
    "reservations.com": "reservations",
}

#: A link that hands out a calendar feed.
ICAL_RE = re.compile(r'href="([^"]+\.ics[^"]*)"', re.IGNORECASE)
#: A "check availability" style page, which implies a real booking engine.
AVAILABILITY_HINT_RE = re.compile(
    r'href="([^"]*(?:availab|booking|book-now|reserve|check-?in)[^"]*)"', re.IGNORECASE
)


def detect_pms(html: str) -> Optional[str]:
    lowered = html.lower()
    for needle, product in PMS_FINGERPRINTS.items():
        if needle in lowered:
            return product
    return None


def find_ical_feed(html: str) -> Optional[str]:
    match = ICAL_RE.search(html)
    return match.group(1) if match else None


def find_availability_url(html: str, base_url: str) -> Optional[str]:
    from urllib.parse import urljoin

    match = AVAILABILITY_HINT_RE.search(html)
    return urljoin(base_url, match.group(1)) if match else None


def find_booking_url(html: str, base_url: str) -> Optional[str]:
    """A third-party booking engine link, which is itself a PMS signal."""
    from urllib.parse import urljoin, urlparse

    for match in re.finditer(r'href="(https?://[^"]+)"', html, re.IGNORECASE):
        candidate = match.group(1)
        host = urlparse(candidate).netloc.lower()
        for needle, product in PMS_FINGERPRINTS.items():
            if needle in host:
                return candidate
    return None
