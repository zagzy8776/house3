"""
Hosts that are never an operator, and never an operator's own website.

ONE LIST, TWO CONSUMERS
-----------------------
`extraction/contact.py` asks "is this link the operator's own site?".
`normalization/dedupe.py` asks "may this domain be a match key?".

Those two questions have one answer, but they had two copies of the list, and the
copies drifted: the dedupe copy was missing every entry added while chasing the
operator-attribution bug (`googleapis.com`, `gstatic.com`, `cloudfront.net`, the
portal family). Drift here is expensive in one direction - a domain used as a
STRONG dedupe key fuses two unrelated businesses into a single call target - so
the list lives in one place and both layers import it.

COMPARED ON THE REGISTRABLE DOMAIN
----------------------------------
Not as a substring. `fonts.googleapis.com` passed a "google.com" substring test,
so the font CDN became "the operator's website", the operator name was inferred
from it, and an entire Lagos crawl turned into leads for a business called
"Fonts". Two labels is deliberate and sufficient for every entry below; it is not
a public-suffix implementation, and pretending otherwise with a shortcut would be
worse than being explicit that it is approximate.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

#: Registrable domains that never identify an operator.
NON_OPERATOR_HOSTS = frozenset(
    {
        # Portals and marketplaces: a listing we found *on* them, not the business.
        "nigeriapropertycentre.com",
        "kenyapropertycentre.com",
        "propertypro.ng",
        "jiji.ng",
        # Social and messaging.
        "facebook.com",
        "twitter.com",
        "x.com",
        "linkedin.com",
        "youtube.com",
        "whatsapp.com",
        "wa.me",
        "instagram.com",
        "apple.com",
        # Infrastructure the page depends on. Nothing here belongs to a letting
        # business, and every one of them was at some point mistaken for one.
        "google.com",
        "googleapis.com",
        "gstatic.com",
        "cloudflare.com",
        "cloudfront.net",
        "amazonaws.com",
        "jsdelivr.net",
        "unpkg.com",
        "bootstrapcdn.com",
        "fontawesome.com",
        "jquery.com",
        "w3.org",
        # Analytics, tag managers and chat widgets.
        "googletagmanager.com",
        "google-analytics.com",
        "doubleclick.net",
        "sentry.io",
        "hotjar.com",
        "mixpanel.com",
        "segment.com",
        "tawk.to",
        "livechatinc.com",
        "intercom.com",
        "zendesk.com",
        "gravatar.com",
    }
)

#: A portal is not an operator. One publisher's footer links to its portals in
#: other countries, so the operator name was inferred from a sister portal and a
#: real agency phone number was published against it. Rather than enumerate a
#: country list, the family is matched by name. Being wrong here costs a website
#: link, never a listing - the phone number is unaffected.
PORTAL_HOST_RE = re.compile(r"propertycent(?:re|er)")


def registrable_domain(host: str) -> str:
    """The last two labels of a host: 'fonts.googleapis.com' -> 'googleapis.com'."""
    labels = [label for label in host.split(".") if label]
    return ".".join(labels[-2:]) if len(labels) >= 2 else host


def is_non_operator_host(host: str) -> bool:
    """True when a host can never identify an operator or carry its website."""
    if not host:
        return False
    normalised = host.lower().split(":", 1)[0].removeprefix("www.")
    return registrable_domain(normalised) in NON_OPERATOR_HOSTS or bool(
        PORTAL_HOST_RE.search(normalised)
    )


def is_non_operator_url(url: str) -> bool:
    """True when a URL's host can never identify an operator."""
    return is_non_operator_host(urlparse(url).netloc)
