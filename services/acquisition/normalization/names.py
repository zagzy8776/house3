"""
Operator name normalisation.

Mirrors src/domain/lead.ts so the identities produced here and there agree. The
Python side normalises before writing JSONL; the TypeScript side normalises again
on ingest. That redundancy is deliberate: the file may be edited or merged by
hand, so the ingest path must not trust it.
"""

from __future__ import annotations

import re

#: Legal and generic suffixes that vary between portals for one business.
LEGAL_SUFFIXES = frozenset(
    {
        "limited",
        "ltd",
        "enterprises",
        "enterprise",
        "ventures",
        "venture",
        "nigeria",
        "nig",
        "and sons",
        "sons",
        "integrated",
        "services",
        "company",
        "co",
        "global",
        "group",
    }
)

PUNCTUATION_RE = re.compile(r"[.,'\"()\[\]&/-]")
WHITESPACE_RE = re.compile(r"\s+")


def normalise_operator_name(raw: str) -> str:
    """
    Collapse the variants one operator appears under.

    "Lekki Homes Ltd", "LEKKI HOMES LIMITED" and "Lekki Homes Nig. Ltd" are one
    phone call, not three.
    """
    value = PUNCTUATION_RE.sub(" ", (raw or "").lower()).strip()
    words = [word for word in WHITESPACE_RE.split(value) if word]
    stripped = [word for word in words if word not in LEGAL_SUFFIXES]

    # A name made only of suffixes must not collapse to an empty key, or every
    # such lead would merge into one.
    useful = stripped or words
    return " ".join(useful)


def operator_key(name: str, area: str, state_code: str) -> str:
    """
    Identity key: same name in the same neighbourhood is the same operator; the
    same name in another city is usually a different business.
    """
    normalised = normalise_operator_name(name).replace(" ", "-")
    area_slug = WHITESPACE_RE.sub("-", (area or "").strip().lower())
    return f"{(state_code or '').lower()}:{area_slug}:{normalised}"
