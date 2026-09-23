"""
Address canonicalisation.

The same neighbourhood is spelled a dozen ways across portals: "Lekki Phase 1",
"Lekki Phase1", "Lekki phase 1, Lagos", "LEKKI 1", "Lekki". Without this, dedupe
splits one operator into several and the call list fills with duplicates.

The alias table is deliberately small and explicit. Fuzzy address matching
silently merges real distinct places, which is worse than missing a match.
"""

from __future__ import annotations

import re
from typing import Optional

WHITESPACE_RE = re.compile(r"\s+")
NON_ALNUM_RE = re.compile(r"[^a-z0-9 ]")

#: Canonical neighbourhood -> the spellings seen in the wild.
AREA_ALIASES: dict[str, tuple[str, ...]] = {
    "Lekki Phase 1": ("lekki", "lekki phase 1", "lekki phase1", "lekki 1", "lekki p1", "lekki i"),
    "Lekki Phase 2": ("lekki phase 2", "lekki phase2", "lekki 2", "lekki p2", "lekki ii"),
    "Victoria Island": ("victoria island", "victoria island vi", "vi", "v i", "victoria isl"),
    "Ikoyi": ("ikoyi", "ikoyi lagos"),
    "Ajah": ("ajah", "ajah lagos"),
    "Ikeja GRA": ("ikeja gra", "ikeja g r a", "gra ikeja"),
    "Ikeja": ("ikeja",),
    "Yaba": ("yaba",),
    "Surulere": ("surulere", "surulere lagos"),
    "Gbagada": ("gbagada",),
    "Magodo": ("magodo", "magodo gra", "magodo phase 1", "magodo phase 2"),
    "Ogudu": ("ogudu", "ogudu gra"),
    "Maryland": ("maryland", "maryland lagos"),
    "Lagos Island": ("lagos island",),
    "Eko Atlantic City": ("eko atlantic", "eko atlantic city"),
    "Maitama": ("maitama",),
    "Asokoro": ("asokoro",),
    "Wuse 2": ("wuse 2", "wuse ii", "wuse2"),
    "Wuse": ("wuse",),
    "Garki": ("garki",),
    "Gwarinpa": ("gwarinpa", "gwarimpa"),
    "Jabi": ("jabi", "jabi abuja"),
    "Lugbe": ("lugbe",),
    "Guzape": ("guzape",),
    "Katampe Extension": ("katampe", "katampe extension"),
    "Bodija": ("bodija", "bodija ibadan"),
    "Jericho": ("jericho", "jericho ibadan"),
    "Ring Road": ("ring road", "ringroad", "ring road ibadan"),
    "Dugbe": ("dugbe",),
    "Oluyole Estate": ("oluyole", "oluyole estate"),
    "New Owerri": ("new owerri",),
    "Aladinma": ("aladinma",),
    "Ikenegbu": ("ikenegbu",),
    "GRA Owerri": ("gra owerri", "owerri gra"),
    "Ewet Housing Estate": ("ewet housing", "ewet housing estate", "ewet"),
    "Shelter Afrique": ("shelter afrique",),
    "Osongama": ("osongama",),
    "Oron Road": ("oron road",),
}

#: Reverse index, built once.
_LOOKUP: dict[str, str] = {}
for _canonical, _aliases in AREA_ALIASES.items():
    _LOOKUP[_canonical.lower()] = _canonical
    for _alias in _aliases:
        _LOOKUP[_alias] = _canonical


def slug(value: str) -> str:
    lowered = NON_ALNUM_RE.sub(" ", (value or "").lower())
    return WHITESPACE_RE.sub("-", lowered.strip())


def canonical_area(raw: Optional[str]) -> Optional[str]:
    """
    Map an area string to its canonical name.

    Falls back to a title-cased version of the input when unknown, because
    dropping an unrecognised area loses a real observation. The caller can tell
    the difference by comparing against AREA_ALIASES.
    """
    if not raw:
        return None

    cleaned = raw.split(",")[0].strip()
    lowered = WHITESPACE_RE.sub(" ", NON_ALNUM_RE.sub(" ", cleaned.lower())).strip()

    if lowered in _LOOKUP:
        return _LOOKUP[lowered]

    # "Lekki Phase 1, Lagos" and "lekki phase 1 lagos" both reduce to the alias.
    for alias, canonical in _LOOKUP.items():
        if lowered.startswith(alias):
            return canonical

    return cleaned.title()


def is_known_area(raw: Optional[str]) -> bool:
    if not raw:
        return False
    cleaned = raw.split(",")[0].strip()
    lowered = WHITESPACE_RE.sub(" ", NON_ALNUM_RE.sub(" ", cleaned.lower())).strip()
    return lowered in _LOOKUP


def city_for_state(state_code: str) -> Optional[str]:
    return {
        "LA": "Lagos",
        "FC": "Abuja",
        "OY": "Ibadan",
        "IM": "Owerri",
        "AK": "Uyo",
    }.get(state_code)
