"""
The gate between "a domain we noticed" and "a source we may crawl".

WHY THIS FILE EXISTS
--------------------
`IMPLEMENTATION_PLAN.md` gap #8: "No `SourceRegistry` - permission lives in Python
constants and prose." That was survivable with one adapter. With nine candidate
portals it stops being survivable, because the crawl decision becomes a list of
domains copied out of a search engine, and the only thing standing between that
list and a legal complaint is a sentence in a comment.

So permission is a record. `source_registry.json` holds one entry per domain, the
entry cites the evidence it was decided on, and `require_permitted()` refuses to
hand back an adapter for a source that is not PERMITTED.

THE DECISION IS NOT AUTOMATED
-----------------------------
This module reads evidence; it does not interpret it. A robots.txt with no
`Disallow` is evidence of a permissive robots policy and evidence of *nothing
else* - it is not a licence, and it does not override terms of service. So the
loader carries `termsStatus` as a recorded human decision with a reviewer and a
date. `robots.txt` is checked separately, at request time, by
`compliance/robots.py`, because a publisher may change it tomorrow.

UNREACHABLE IS NOT ABSENT
-------------------------
A source whose `robots.txt` times out is `UNREACHABLE`, not "no rules published".
Concluding "this portal has nothing" from "this portal did not answer" is the
mistake this whole layer exists to prevent. UNREACHABLE sources stay UNREVIEWED.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

#: Where the registry lives. Beside the pipeline, so it is reviewable in a diff.
REGISTRY_PATH = Path(__file__).resolve().parent.parent / "source_registry.json"

#: Access methods a source may declare. Mirrors the Prisma `SourceAccessMethod`.
ACCESS_METHODS = ("PUBLIC_WEB", "API", "FEED", "MANUAL")

#: Review states. Mirrors the Prisma `SourceTermsStatus`.
UNREVIEWED = "UNREVIEWED"
PERMITTED = "PERMITTED"
RESTRICTED = "RESTRICTED"
PROHIBITED = "PROHIBITED"
STATUSES = (UNREVIEWED, PERMITTED, RESTRICTED, PROHIBITED)

#: The layer a source feeds. A DISCOVERY source produces prospects only.
DISCOVERY = "DISCOVERY"
OPERATOR_SITE = "OPERATOR_SITE"
BOOKING = "BOOKING"
LAYERS = (DISCOVERY, OPERATOR_SITE, BOOKING)

#: What happened when we probed it. Kept separate from the review decision, so
#: "we could not reach it" never gets read as "we looked and it was fine".
FETCHED = "FETCHED"
UNREACHABLE = "UNREACHABLE"
NOT_ATTEMPTED = "NOT_ATTEMPTED"


class SourceNotPermitted(RuntimeError):
    """Raised when a crawl is attempted against a source we may not crawl."""


@dataclass
class SourceEntry:
    """One domain, its evidence, and the decision recorded against it."""

    key: str
    host: str
    display_name: str
    layer: str
    access_method: str
    terms_status: str = UNREVIEWED
    robots_fetch: str = NOT_ATTEMPTED
    robots_url: str = ""
    robots_sitemaps: list[str] = field(default_factory=list)
    robots_disallow_count: int = 0
    robots_disallow_samples: list[str] = field(default_factory=list)
    robots_crawl_delay: Optional[float] = None
    robots_notes: str = ""
    terms_url: Optional[str] = None
    attribution_requirement: Optional[str] = None
    rate_limit_per_minute: Optional[int] = None
    reviewed_by: Optional[str] = None
    last_reviewed_at: Optional[str] = None
    notes: str = ""
    blocked_reason: str = ""

    @property
    def is_permitted(self) -> bool:
        return self.terms_status == PERMITTED

    @property
    def was_probed(self) -> bool:
        return self.robots_fetch != NOT_ATTEMPTED

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "host": self.host,
            "displayName": self.display_name,
            "layer": self.layer,
            "accessMethod": self.access_method,
            "termsStatus": self.terms_status,
            "robots": {
                "fetch": self.robots_fetch,
                "url": self.robots_url,
                "sitemaps": self.robots_sitemaps,
                "disallowCount": self.robots_disallow_count,
                "disallowSamples": self.robots_disallow_samples,
                "crawlDelay": self.robots_crawl_delay,
                "notes": self.robots_notes,
            },
            "termsUrl": self.terms_url,
            "attributionRequirement": self.attribution_requirement,
            "rateLimitPerMinute": self.rate_limit_per_minute,
            "reviewedBy": self.reviewed_by,
            "lastReviewedAt": self.last_reviewed_at,
            "notes": self.notes,
            "blockedReason": self.blocked_reason,
        }

    @classmethod
    def from_dict(cls, raw: dict) -> "SourceEntry":
        robots = raw.get("robots") or {}
        return cls(
            key=raw["key"],
            host=raw["host"],
            display_name=raw.get("displayName", raw["key"]),
            layer=raw.get("layer", DISCOVERY),
            access_method=raw.get("accessMethod", "PUBLIC_WEB"),
            terms_status=raw.get("termsStatus", UNREVIEWED),
            robots_fetch=robots.get("fetch", NOT_ATTEMPTED),
            robots_url=robots.get("url", ""),
            robots_sitemaps=list(robots.get("sitemaps") or []),
            robots_disallow_count=int(robots.get("disallowCount") or 0),
            robots_disallow_samples=list(robots.get("disallowSamples") or []),
            robots_crawl_delay=robots.get("crawlDelay"),
            robots_notes=robots.get("notes", ""),
            terms_url=raw.get("termsUrl"),
            attribution_requirement=raw.get("attributionRequirement"),
            rate_limit_per_minute=raw.get("rateLimitPerMinute"),
            reviewed_by=raw.get("reviewedBy"),
            last_reviewed_at=raw.get("lastReviewedAt"),
            notes=raw.get("notes", ""),
            blocked_reason=raw.get("blockedReason", ""),
        )


@dataclass
class SourceRegistryFile:
    """The registry as a whole: an ordered list plus lookup by key and by host."""

    entries: list[SourceEntry] = field(default_factory=list)

    def get(self, key: str) -> Optional[SourceEntry]:
        for entry in self.entries:
            if entry.key == key:
                return entry
        return None

    def by_host(self, host: str) -> Optional[SourceEntry]:
        cleaned = host.lower().split(":", 1)[0].removeprefix("www.")
        for entry in self.entries:
            if cleaned == entry.host or cleaned.endswith("." + entry.host):
                return entry
        return None

    def discovering(self) -> list[SourceEntry]:
        """Sources that feed DISCOVERY inventory. Booking sources are excluded."""
        return [entry for entry in self.entries if entry.layer == DISCOVERY]

    def permitted(self) -> list[SourceEntry]:
        return [entry for entry in self.entries if entry.is_permitted]

    def unreviewed(self) -> list[SourceEntry]:
        return [entry for entry in self.entries if entry.terms_status == UNREVIEWED]

    def require_permitted(self, key: str) -> SourceEntry:
        """
        The gate. Raises rather than returning something unusable.

        Returning None here would let a caller write `entry = load().get(k)` and
        crawl anyway on the next line. A raise cannot be ignored by accident.
        """
        entry = self.get(key)
        if entry is None:
            raise SourceNotPermitted(
                f"source '{key}' is not in the registry. Add it to "
                f"{REGISTRY_PATH.name} with evidence before crawling it."
            )
        if entry.layer != DISCOVERY:
            raise SourceNotPermitted(
                f"source '{key}' is a {entry.layer} source. sources/ is a DISCOVERY "
                "layer; bookable channels are registered in src/inventory/registry.ts."
            )
        if not entry.is_permitted:
            detail = f" ({entry.blocked_reason})" if entry.blocked_reason else ""
            raise SourceNotPermitted(
                f"source '{key}' is {entry.terms_status}, not PERMITTED{detail}. "
                "A crawl must not run against a source that has not been reviewed."
            )
        return entry


def load_registry(path: Optional[Path] = None) -> SourceRegistryFile:
    """Read the registry. A missing file is an empty registry, never a permissive one."""
    target = path or REGISTRY_PATH
    if not target.exists():
        return SourceRegistryFile()
    raw = json.loads(target.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = raw.get("sources", [])
    return SourceRegistryFile([SourceEntry.from_dict(item) for item in raw])


def save_registry(registry: SourceRegistryFile, path: Optional[Path] = None) -> Path:
    """Write the registry in a stable order so a diff shows only real changes."""
    target = path or REGISTRY_PATH
    ordered = sorted(registry.entries, key=lambda entry: entry.key)
    payload = {
        "$comment": (
            "Verified source registry. Each entry cites the evidence its decision was "
            "made on. termsStatus is a human decision with a reviewer and a date; "
            "robots.txt is checked separately at request time because a publisher may "
            "change it. A source that could not be reached is UNREACHABLE, never "
            "'permitted by default'."
        ),
        "sources": [entry.to_dict() for entry in ordered],
    }
    target.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return target
