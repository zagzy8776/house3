"""
Contact extraction.

Nigerian property listings publish contact in a few reliable shapes: a `tel:`
link, a `mailto:` link, a WhatsApp link, a website, and sometimes an Instagram
handle. This module reads those, and nothing else.

It does NOT try to find a named individual. `agent_name` is on the forbidden
list: we are contacting a business about a commercial proposition, and holding
the name of whichever staff member happened to post a listing is personal data we
have no need for.
"""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlparse

from compliance.non_operator_hosts import is_non_operator_host

TEL_RE = re.compile(r'href="tel:([^"]+)"', re.IGNORECASE)
MAILTO_RE = re.compile(r'href="mailto:([^"?]+)', re.IGNORECASE)
WHATSAPP_RE = re.compile(r"(?:wa\.me|api\.whatsapp\.com/send\?phone=)(\+?\d{7,15})", re.IGNORECASE)
INSTAGRAM_RE = re.compile(r"instagram\.com/([A-Za-z0-9_.]{2,30})", re.IGNORECASE)

#: The operator's own site is an anchor a visitor can click. A resource reference
#: is not - `<link rel=stylesheet>`, `<link rel=preconnect>`, `<script src>` - and
#: scanning every `href` meant the operator name was taken from whatever asset
#: host the template used. The first live Lagos ingest produced a prospect list
#: where every lead was a business called "Fonts" (from fonts.googleapis.com),
#: and the next produced "Ddo5o3z2xgpp2" (from ddo5o3z2xgpp2.cloudfront.net).
#: Per-project asset hostnames cannot be enumerated, so the tag decides.
ANCHOR_RE = re.compile(r'<a\s[^>]*href="(https?://[^"]+)"', re.IGNORECASE)

#: Extensions that mark a URL as a file rather than a site a person visits.
ASSET_EXTENSIONS = (
    ".css",
    ".js",
    ".mjs",
    ".json",
    ".map",
    ".xml",
    ".ics",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".ico",
    ".avif",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".pdf",
    ".zip",
)


def _looks_like_asset(url: str) -> bool:
    """True when a URL points at a file rather than the operator's site."""
    return urlparse(url).path.lower().endswith(ASSET_EXTENSIONS)


#: Corporate-looking contact route. A gmail address is still contactable, but we
#: record it as what it is rather than pretending it is a company address.
BUSINESS_MAIL_RE = re.compile(r"^[a-z0-9._%+-]+@(?![a-z0-9.-]*\.(?:gmail|yahoo|hotmail|outlook|icloud)\.)", re.I)


def find_phones(html: str) -> list[str]:
    """Every distinct phone number, in page order, WhatsApp first removed."""
    seen: list[str] = []
    for match in TEL_RE.finditer(html):
        value = match.group(1).strip()
        if value and value not in seen:
            seen.append(value)

    if not seen:
        for match in WHATSAPP_RE.finditer(html):
            value = match.group(1).strip()
            if value and value not in seen:
                seen.append(value)

    return seen


def find_email(html: str) -> Optional[str]:
    match = MAILTO_RE.search(html)
    return match.group(1).strip().lower() if match else None


def find_instagram(html: str) -> Optional[str]:
    match = INSTAGRAM_RE.search(html)
    if not match:
        return None
    handle = match.group(1)
    # Instagram's own plumbing, not an operator account.
    return None if handle.lower() in {"p", "explore", "reel", "reels", "accounts"} else handle


def find_operator_website(html: str, base_url: str) -> Optional[str]:
    """
    The operator's own site, if the listing links out to one.

    Excludes the portal itself, social platforms and asset hosts, because none of
    those are the operator's website and a lead scored as "has its own website" on
    the strength of a Facebook page or a stylesheet would be misleading.
    """
    for match in ANCHOR_RE.finditer(html):
        candidate = match.group(1)
        host = urlparse(candidate).netloc.lower()
        if is_non_operator_host(host):
            continue
        if _looks_like_asset(candidate):
            continue
        return candidate
    return None


def is_business_email(email: str | None) -> bool:
    return bool(email and BUSINESS_MAIL_RE.match(email))
