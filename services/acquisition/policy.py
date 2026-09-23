"""
Acquisition policy: the guardrails every fetch passes through.

This module is deliberately the least interesting code in the service and the
most load-bearing. Three rules, enforced in one place so no source adapter can
forget them:

  1. ROBOTS. If a host disallows a path for us, we do not fetch it. Checked
     against the host's own robots.txt, cached per host per run.

  2. RATE LIMIT. One request at a time per host, with a floor on the interval.
     We are a guest on someone else's server; a crawler that degrades a
     competitor's site is both rude and the fastest way to get blocked.

  3. FIELD ALLOWLIST. We extract operator identity, portfolio size and advertised
     rates - nothing else. No photographs (the operator's copyright), no listing
     descriptions (their copy), no prose of any kind. What we do not fetch cannot
     leak into a database.

Point 3 is why the output of this service is a prospect list rather than
inventory. See src/domain/lead.ts for the same boundary expressed in types.
"""

from __future__ import annotations

import time
import urllib.robotparser
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlparse

USER_AGENT = "House3PartnerResearch/1.0 (+https://house3.ng/bot; partner-outreach)"

#: Minimum seconds between requests to the same host.
DEFAULT_HOST_INTERVAL_SECONDS = 5.0

#: Fields we are allowed to read out of a page. Anything not listed here is
#: dropped before it can reach a model or a database.
ALLOWED_FIELDS = frozenset(
    {
        "operator_name",
        "area",
        "state_code",
        "listing_count",
        "nightly_rate_kobo",
        "phone",
        "email",
        "website",
        "instagram",
        "title_document",
        "pms_fingerprint",
    }
)

#: Never extracted, never stored. Listed explicitly so the exclusion is a
#: decision on record rather than an oversight.
FORBIDDEN_FIELDS = frozenset(
    {"photo", "image", "gallery", "description", "body_text", "review_text", "agent_name"}
)


class PolicyViolation(RuntimeError):
    """Raised when a fetch or an extraction would breach policy."""


@dataclass
class HostThrottle:
    """Tracks when we last touched each host, so we stay a polite guest."""

    interval_seconds: float = DEFAULT_HOST_INTERVAL_SECONDS
    _last_hit: dict[str, float] = field(default_factory=dict)

    def wait(self, url: str) -> float:
        """Sleep if needed. Returns how long we waited, for the run log."""
        host = urlparse(url).netloc
        now = time.monotonic()
        previous = self._last_hit.get(host)

        waited = 0.0
        if previous is not None:
            elapsed = now - previous
            if elapsed < self.interval_seconds:
                waited = self.interval_seconds - elapsed
                time.sleep(waited)

        self._last_hit[host] = time.monotonic()
        return waited


@dataclass
class RobotsCache:
    """Per-run robots.txt cache. One fetch per host, not one per URL."""

    user_agent: str = USER_AGENT
    timeout_seconds: float = 10.0
    _parsers: dict[str, Optional[urllib.robotparser.RobotFileParser]] = field(default_factory=dict)

    def _parser_for(self, url: str):
        host = urlparse(url).netloc
        if host in self._parsers:
            return self._parsers[host]

        parser = urllib.robotparser.RobotFileParser()
        robots_url = f"{urlparse(url).scheme}://{host}/robots.txt"
        try:
            parser.set_url(robots_url)
            parser.read()
        except Exception:
            # An unreachable robots.txt is treated as "no rules published".
            # A *disallowing* robots.txt is respected, which is the case that
            # actually matters.
            parser = None

        self._parsers[host] = parser
        return parser

    def allowed(self, url: str) -> bool:
        parser = self._parser_for(url)
        if parser is None:
            return True
        try:
            return parser.can_fetch(self.user_agent, url)
        except Exception:
            return True


def assert_no_media_or_prose(record: dict) -> dict:
    """
    Reject an extracted record that contains anything on the forbidden list.

    This runs at the boundary between parsing and storage, so a parser that
    over-reaches fails loudly instead of quietly writing a photographer's work
    into our database.
    """
    for key in record:
        if key in FORBIDDEN_FIELDS:
            raise PolicyViolation(
                f"Extraction produced forbidden field '{key}'. This service collects "
                "operator identity and advertised rates only - never media or copy."
            )

    unknown = set(record) - ALLOWED_FIELDS
    if unknown:
        raise PolicyViolation(f"Extraction produced undeclared fields: {sorted(unknown)}")

    return record


def to_lead(row: dict) -> dict:
    """
    Shape a raw extraction into the OperatorLead contract that
    src/domain/lead.ts consumes. Normalisation and dedupe happen on the
    TypeScript side so there is exactly one implementation of that logic.
    """
    assert_no_media_or_prose(row)
    return {
        "displayName": row.get("operator_name", ""),
        "area": row.get("area", ""),
        "stateCode": row.get("state_code", ""),
        "listingCount": int(row.get("listing_count", 0)),
        "observedNightlyRatesKobo": [int(row["nightly_rate_kobo"])] if row.get("nightly_rate_kobo") else [],
        "contact": {
            "phone": row.get("phone"),
            "email": row.get("email"),
            "website": row.get("website"),
            "instagram": row.get("instagram"),
        },
        "claimedTitles": [row["title_document"]] if row.get("title_document") else [],
        "pmsFingerprints": [row["pms_fingerprint"]] if row.get("pms_fingerprint") else [],
    }
