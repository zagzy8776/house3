"""
Operator identity extraction.

The distinction that matters: a LISTING is a property, an OPERATOR is a business.
One operator posts many listings, often under different property names. Getting
this wrong turns one valuable partner into twelve worthless leads.

A listing page rarely states the operator cleanly, so this module tries a ladder
of signals, strongest first, and reports which one it used:

  1. JSON-LD `seller`/`provider`/`author` - publishers that emit schema.org give
     the operator name explicitly.
  2. A markup block whose class or id names an agency/agent/company/owner.
  3. The registrable domain of the operator's own website, expanded to a readable
     name ("lekkihomes.ng" -> "Lekkihomes"). **This is a hint, never identity.**
     A name taken from a domain is one weak signal, and treating it as identity
     merged unrelated businesses: every prospect in an early Lagos crawl was
     attributed to a font CDN, a stylesheet CDN, and then a sister portal. Callers
     must check `OperatorIdentity.is_identity` and route a hint to
     `DiscoveredListing.operator_hint` instead of `operator_name` - it is recorded
     and left for entity resolution to weigh, so no operator row is created until
     there is evidence for one.

Confidence is carried on the result because a name scraped from a `<h1>` and a
name taken from a schema.org field deserve different trust. Dedupe uses the
confidence to decide whether two listings are safely the same operator.
"""

from __future__ import annotations

import html as html_module
import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

from extraction.property import parse_json_ld, strip_tags

#: Elements whose class/id suggests they name the business, not the property.
AGENCY_BLOCK_RE = re.compile(
    r"<(?:div|span|p|a|h[2-4])[^>]+(?:class|id)=\"[^\"]*"
    r"(?:agent|agency|estate-?agent|company|developer|owner|advertiser|lister|provider|brand)"
    r"[^\"]*\"[^>]*>(.*?)</(?:div|span|p|a|h[2-4])>",
    re.IGNORECASE | re.DOTALL,
)

#: Words that indicate a block is describing the property, not the operator.
PROPERTY_WORDS = re.compile(
    r"\b(bedroom|bathroom|duplex|bungalow|terrace|apartment|flat|penthouse|"
    r"shortlet|short let|for rent|for sale|per night|per day|sqm|plot)\b",
    re.IGNORECASE,
)

#: A plausible business name: short, has a letter, not a sentence.
BUSINESS_NAME_RE = re.compile(r"^[A-Za-z0-9&'.,\- ]{3,60}$")

GENERIC_LABELS = {
    "agent",
    "agents",
    "estate agent",
    "property",
    "properties",
    "contact",
    "contact agent",
    "view agent",
    "company",
    "owner",
    "advertiser",
    "verified",
    "premium",
}

DOMAIN_SUFFIXES = (".ng", ".com", ".com.ng", ".org", ".net", ".africa")

#: Which rung of the ladder produced a name. Only the last one is too weak to be
#: an identity, and it is named so callers cannot mistake it for the others.
CONFIDENCE_STRUCTURED = "high"
CONFIDENCE_MARKUP = "medium"
CONFIDENCE_DOMAIN = "low"


@dataclass
class OperatorIdentity:
    """An operator name with an honest confidence level."""

    name: str
    #: "high" = structured data, "medium" = a labelled markup block,
    #: "low" = inferred from a domain.
    confidence: str
    evidence: str

    @property
    def is_identity(self) -> bool:
        """True when the name is evidence of *who* the operator is.

        A domain-derived name is a hint, not identity. It is one weak signal, and
        acting on it is what attributed an entire crawl to a font CDN and then to
        a sister portal. Callers record it as a hint and leave the operator empty
        until entity resolution has something to weigh.
        """
        return self.confidence != CONFIDENCE_DOMAIN


def _clean(value: str) -> str:
    return html_module.unescape(strip_tags(value)).strip(" ·-|\n\t")


def _looks_like_business(name: str) -> bool:
    if not name or len(name) < 3 or len(name) > 60:
        return False
    if not re.search(r"[A-Za-z]", name):
        return False
    if name.lower() in GENERIC_LABELS:
        return False
    # A block that reads like a property description is not the operator.
    if PROPERTY_WORDS.search(name):
        return False
    return bool(BUSINESS_NAME_RE.match(name))


def name_from_domain(url: str) -> Optional[str]:
    """Derive a readable hint from an operator's own domain."""
    host = urlparse(url).netloc.lower().replace("www.", "")
    if not host:
        return None
    for suffix in DOMAIN_SUFFIXES:
        if host.endswith(suffix):
            host = host[: -len(suffix)]
            break
    label = host.split(".")[0]
    if len(label) < 3:
        return None
    # "lekkihomes" -> "Lekki Homes" is a guess, so this stays low confidence.
    return label.capitalize()


def extract_operator(html: str, website: Optional[str] = None) -> Optional[OperatorIdentity]:
    """Best available operator identity, with the evidence that produced it."""

    # 1. structured data
    ld = parse_json_ld(html)
    for key in ("seller", "provider", "author", "publisher", "brand"):
        value = ld.get(key)
        if isinstance(value, dict) and isinstance(value.get("name"), str):
            candidate = _clean(value["name"])
            if _looks_like_business(candidate):
                return OperatorIdentity(candidate, CONFIDENCE_STRUCTURED, f"json-ld {key}.name")
        if isinstance(value, str):
            candidate = _clean(value)
            if _looks_like_business(candidate):
                return OperatorIdentity(candidate, CONFIDENCE_STRUCTURED, f"json-ld {key}")

    # 2. a labelled markup block
    for match in AGENCY_BLOCK_RE.finditer(html):
        candidate = _clean(match.group(1))
        # A block often contains the name plus a phone; take the first line.
        candidate = candidate.split("\n")[0].strip()
        if _looks_like_business(candidate):
            return OperatorIdentity(candidate, CONFIDENCE_MARKUP, "agency-labelled block")

    # 3. the operator's own domain - a hint for entity resolution, not identity
    if website:
        inferred = name_from_domain(website)
        if inferred:
            return OperatorIdentity(inferred, CONFIDENCE_DOMAIN, f"domain of {website}")

    return None
