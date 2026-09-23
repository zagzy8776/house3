"""
Nigerian phone normalisation.

Listings publish numbers every which way: 0803..., +234 803..., 234803..., and
with spaces, dashes or nothing between. All of those are one number, and treating
them as three is how a dedupe fails.
"""

from __future__ import annotations

import re
from typing import Optional

NON_DIGIT_RE = re.compile(r"[^\d+]")

#: Nigerian mobile prefixes, for a sanity check that a number is plausible.
NG_MOBILE_PREFIXES = (
    "0703", "0704", "0705", "0706", "0707", "0708", "0709",
    "0802", "0803", "0804", "0805", "0806", "0807", "0808", "0809",
    "0810", "0811", "0812", "0813", "0814", "0815", "0816", "0817", "0818", "0819",
    "0902", "0903", "0904", "0905", "0906", "0907", "0908", "0909",
    "0912", "0913", "0915", "0916",
)

#: Landline area codes that a business number may legitimately start with.
NG_LANDLINE_PREFIXES = ("01", "02", "07")


def normalise_phone(raw: Optional[str]) -> Optional[str]:
    """
    To `+234XXXXXXXXXX` where recognisable, otherwise the original string.

    An unrecognised shape is returned unchanged rather than guessed at: a
    corrupted number costs a wasted call, a silently wrong one loses a partner.
    """
    if not raw:
        return None

    bare = NON_DIGIT_RE.sub("", raw).lstrip("+")

    if re.fullmatch(r"234\d{10}", bare):
        return f"+{bare}"
    if re.fullmatch(r"0\d{10}", bare):
        return f"+234{bare[1:]}"
    if re.fullmatch(r"\d{10}", bare):
        return f"+234{bare}"

    return raw.strip()


def is_plausible_nigerian_mobile(phone: Optional[str]) -> bool:
    """True for a number shaped like a Nigerian mobile."""
    if not phone or not phone.startswith("+234"):
        return False
    national = f"0{phone[4:]}"
    return national.startswith(NG_MOBILE_PREFIXES)


def phone_dedupe_key(phone: Optional[str]) -> Optional[str]:
    """Last 9 digits, so a number with a mistyped country code still matches."""
    if not phone:
        return None
    digits = NON_DIGIT_RE.sub("", phone)
    return digits[-9:] if len(digits) >= 9 else None
