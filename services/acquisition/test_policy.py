"""
Policy guard tests. Run:  python -m pytest services/acquisition/test_policy.py
or, without pytest:        python services/acquisition/test_policy.py

These test the one thing in this service that must never regress: that we
cannot accidentally collect media, prose, or a personal agent name.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from policy import (  # noqa: E402
    FORBIDDEN_FIELDS,
    HostThrottle,
    PolicyViolation,
    assert_no_media_or_prose,
    to_lead,
)
from pipeline import (  # noqa: E402
    DEMO_SPEC,
    FixtureTransport,
    detect_pms,
    detect_state,
    detect_title,
    extract,
    parse_rate_to_kobo,
)

FIXTURES = Path(__file__).parent / "fixtures"


def test_rejects_media_fields() -> None:
    for field in sorted(FORBIDDEN_FIELDS):
        try:
            assert_no_media_or_prose({"operator_name": "Lekki Homes", field: "anything"})
        except PolicyViolation:
            continue
        raise AssertionError(f"policy allowed forbidden field '{field}'")


def test_rejects_undeclared_fields() -> None:
    try:
        assert_no_media_or_prose({"operator_name": "Lekki Homes", "sneaky": 1})
    except PolicyViolation:
        return
    raise AssertionError("policy allowed an undeclared field")


def test_allows_the_allowlisted_shape() -> None:
    record = {
        "operator_name": "Lekki Homes Ltd",
        "area": "Lekki Phase 1",
        "state_code": "LA",
        "listing_count": 1,
        "phone": "+2348030000000",
    }
    assert assert_no_media_or_prose(record) == record


def test_to_lead_shapes_the_contract_the_typescript_side_expects() -> None:
    lead = to_lead({"operator_name": "Lekki Homes Ltd", "area": "Lekki Phase 1", "state_code": "LA"})
    assert set(lead) == {
        "displayName",
        "area",
        "stateCode",
        "listingCount",
        "observedNightlyRatesKobo",
        "contact",
        "claimedTitles",
        "pmsFingerprints",
    }
    assert set(lead["contact"]) == {"phone", "email", "website", "instagram"}


def test_parses_the_rate_forms_that_actually_appear() -> None:
    assert parse_rate_to_kobo("NGN 150,000") == 15_000_000
    assert parse_rate_to_kobo("N85,000") == 8_500_000
    assert parse_rate_to_kobo("150000") == 15_000_000
    assert parse_rate_to_kobo(None) is None


def test_ignores_a_rate_that_is_obviously_a_parse_error() -> None:
    # "3 bed" must not become a 3 naira nightly rate.
    assert parse_rate_to_kobo("3") is None


def test_detects_pms_fingerprints() -> None:
    assert detect_pms('<script src="https://app.smoobu.com/x.js">') == "smoobu"
    assert detect_pms('<a href="https://beds24.com/ical">') == "beds24"
    assert detect_pms("<html>nothing here</html>") is None


def test_detects_titles_including_the_abbreviation() -> None:
    assert detect_title("Certificate of Occupancy") == "C_OF_O"
    assert detect_title("C of O available") == "C_OF_O"
    assert detect_title("Governor's Consent") == "GOVERNORS_CONSENT"
    assert detect_title("no documents mentioned") is None


def test_detects_the_state_from_the_area() -> None:
    assert detect_state("Lekki Phase 1, Lagos") == "LA"
    assert detect_state("Maitama, Abuja") == "FC"
    assert detect_state("Somewhere else") is None


def test_extracts_the_fixture_without_media_or_prose() -> None:
    html = (FIXTURES / "sample_listing.html").read_text(encoding="utf-8")
    record = extract(html, DEMO_SPEC, "fixture://sample")

    assert record["operator_name"] == "Lekki Homes Ltd"
    assert record["area"] == "Lekki Phase 1, Lagos"
    assert record["state_code"] == "LA"
    assert record["nightly_rate_kobo"] == 15_000_000
    assert record["pms_fingerprint"] == "smoobu"
    assert record["title_document"] == "C_OF_O"
    assert record["instagram"] == "lekkihomes"

    # The website extractor must skip WhatsApp links, which are a messaging
    # channel rather than a property site.
    assert "lekkihomes.ng" in record["website"]
    assert "wa.me" not in record["website"]


def test_throttle_waits_between_hits_on_one_host() -> None:
    throttle = HostThrottle(interval_seconds=0.05)
    first = throttle.wait("https://example.ng/a")
    second = throttle.wait("https://example.ng/b")

    assert first == 0.0
    assert second > 0.0


def test_throttle_does_not_penalise_a_different_host() -> None:
    throttle = HostThrottle(interval_seconds=5.0)
    throttle.wait("https://a.example.ng/")
    assert throttle.wait("https://b.example.ng/") == 0.0


def test_fixture_transport_is_offline() -> None:
    transport = FixtureTransport(FIXTURES)
    assert "Lekki Homes" in transport.fetch("fixture://sample_listing.html")


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"  PASS {name}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"  FAIL {name}: {exc}")

    print("OK" if failures == 0 else f"{failures} failure(s)")
    raise SystemExit(1 if failures else 0)
