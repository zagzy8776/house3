"""
Acquisition tests. Run:  python test_acquisition.py     (or pytest)

The important one is `test_transitive_operator_consolidation`, which encodes the
example from the spec: three listings, no two of which share every signal, that
must still resolve to ONE operator.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from compliance.allowed_fields import FORBIDDEN_FIELDS, PolicyViolation, assert_no_media_or_prose
from extraction.operator import extract_operator, name_from_domain
from extraction.property import extract_property_name, parse_price_to_kobo
from normalization.addresses import canonical_area, is_known_area
from normalization.dedupe import consolidate, domain_of, strong_keys
from normalization.names import normalise_operator_name, operator_key
from normalization.phones import is_plausible_nigerian_mobile, normalise_phone, phone_dedupe_key
from pipeline import FixtureTransport, build_registry, funnel
from sources.base import AdapterRegistry, DiscoveredListing, SourceLayer
from sources.npc import LAGOS_LOCALITIES, NpcAdapter

FIXTURES = Path(__file__).parent / "fixtures"
NPC = NpcAdapter()


def listing(**overrides) -> DiscoveredListing:
    base = dict(
        source="npc",
        source_url="https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/lekki/1",
        source_listing_id="1",
        property_name="Lekki Luxury Apartment",
        state="LA",
        area="Lekki Phase 1",
    )
    base.update(overrides)
    return DiscoveredListing(**base)


# ---------------------------------------------------------------------------
# the architecture contract
# ---------------------------------------------------------------------------


def test_registry_refuses_a_booking_layer_source() -> None:
    class PretendPartnerApi:
        name = "partner"
        layer = SourceLayer.BOOKING
        host = "example.ng"

        def discover(self, transport, state_code, area=None):
            return iter(())

        def parse(self, html, url):
            return None

    try:
        AdapterRegistry().register(PretendPartnerApi())
    except ValueError as exc:
        assert "DISCOVERY layer" in str(exc)
        return
    raise AssertionError("registry accepted a BOOKING-layer source into the discovery layer")


def test_npc_adapter_is_registered_as_a_discovery_source() -> None:
    registry = build_registry()
    assert registry.names() == ["npc"]
    assert registry.get("npc").layer == SourceLayer.DISCOVERY


def test_npc_list_page_urls_follow_the_observed_pattern() -> None:
    urls = list(NPC.list_page_urls("LA", "lekki"))
    assert urls[0] == "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/lekki"
    assert urls[1].endswith("?page=2")


def test_npc_rejects_a_state_it_has_no_slug_for() -> None:
    try:
        list(NPC.list_page_urls("ZZ"))
    except ValueError as exc:
        assert "no slug" in str(exc)
        return
    raise AssertionError("adapter produced URLs for an unknown state")


def test_npc_locality_seed_covers_the_launch_neighbourhoods() -> None:
    for wanted in ("lekki", "ikoyi", "victoria-island-vi", "ikeja", "ajah"):
        assert wanted in LAGOS_LOCALITIES


# ---------------------------------------------------------------------------
# extraction against the fixture
# ---------------------------------------------------------------------------


def test_parses_the_npc_fixture() -> None:
    html = (FIXTURES / "npc-listing-1.html").read_text(encoding="utf-8")
    url = "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/ikeja/7654321"
    parsed = NPC.parse(html, url)

    assert parsed is not None
    assert parsed.property_name == "Luxury 3 Bedrooms Flats with City View"
    assert parsed.advertised_price == 22_000_000  # NGN 220,000
    assert parsed.bedrooms == 3
    assert parsed.bathrooms == 3
    assert parsed.state == "LA"
    assert parsed.city == "Lagos"
    assert parsed.area == "Ikeja"
    assert parsed.source_listing_id == "7654321"

    # booking infrastructure - the highest-value field
    assert parsed.pms_detected == "smoobu"
    assert parsed.availability_url is not None

    # operator identity and contact
    assert parsed.operator_name is not None and "Adeniyi" in parsed.operator_name
    assert parsed.phone is not None
    assert parsed.email == "stay@adeniyijones.ng"
    assert parsed.title_document == "C_OF_O"

    # the website extractor must skip WhatsApp and the portal itself
    assert parsed.website is not None
    assert "wa.me" not in parsed.website
    assert "nigeriapropertycentre" not in parsed.website


def test_parse_returns_none_for_a_non_listing_page() -> None:
    assert NPC.parse("<html><body>no heading here</body></html>", "https://x/1") is None


# ---------------------------------------------------------------------------
# THE test: transitive consolidation
# ---------------------------------------------------------------------------


def test_transitive_operator_consolidation() -> None:
    """
    Three listings where no pair shares every signal, but all three are one
    operator. Listing B is the bridge: it shares a phone with A and an email
    domain with C.

        A  phone 0803 000 0000
        B  phone +234 803 000 0000   +   email bookings@lekkihomes.com
        C  website https://lekkihomes.com

    A pairwise dedupe returns three operators here. Connected components
    return one, which is the whole point.
    """
    a = listing(source_listing_id="A", property_name="Lekki Luxury Apartment #1", phone="0803 000 0000")
    b = listing(
        source_listing_id="B",
        property_name="Lekki Luxury Apartment #2",
        phone="+234 803 000 0000",
        email="bookings@lekkihomes.com",
        pms_detected="smoobu",
    )
    c = listing(source_listing_id="C", property_name="Lekki 3BR Shortlet", website="https://lekkihomes.com/availability")

    profiles = consolidate([a, b, c])

    assert len(profiles) == 1, f"expected 1 operator, got {len(profiles)}"
    operator = profiles[0]

    assert sorted(operator.listing_ids) == ["A", "B", "C"]
    assert operator.listing_count == 3
    assert "+2348030000000" in operator.phones
    assert "bookings@lekkihomes.com" in operator.emails
    assert operator.pms_detected == ["smoobu"]

    # The merge is explainable, not a black box.
    signals = {entry.signal for entry in operator.evidence}
    assert "phone" in signals
    assert "domain" in signals


def test_distinct_operators_stay_distinct() -> None:
    one = listing(source_listing_id="1", operator_name="Lekki Homes", phone="08030000001")
    two = listing(source_listing_id="2", operator_name="Island Suites", phone="08030000002")

    assert len(consolidate([one, two])) == 2


def test_same_name_in_different_cities_does_not_merge() -> None:
    lagos = listing(source_listing_id="1", operator_name="Prime Suites", state="LA", area="Lekki Phase 1")
    abuja = listing(source_listing_id="2", operator_name="Prime Suites", state="FC", area="Maitama")

    assert len(consolidate([lagos, abuja])) == 2


def test_listing_with_no_operator_signal_still_produces_a_profile() -> None:
    profiles = consolidate([listing(source_listing_id="solo")])
    assert len(profiles) == 1
    assert profiles[0].listing_count == 1


def test_consolidation_keeps_every_contact_channel_it_saw() -> None:
    """One operator, reachable two ways: keep both, the caller picks."""
    profiles = consolidate(
        [
            listing(source_listing_id="1", phone="08030000001"),
            listing(source_listing_id="2", phone="08030000001", email="bookings@lh.com"),
            listing(source_listing_id="3", phone="08030000001", website="https://lh.com"),
        ]
    )

    assert len(profiles) == 1
    operator = profiles[0]
    assert operator.listing_count == 3
    assert operator.phones == ["+2348030000001"]
    assert "bookings@lh.com" in operator.emails
    assert "https://lh.com" in operator.websites


# ---------------------------------------------------------------------------
# the funnel
# ---------------------------------------------------------------------------


def test_funnel_reports_the_drop_off_between_stages() -> None:
    listings = [
        listing(source_listing_id="A", phone="0803 000 0000"),
        listing(source_listing_id="B", phone="+2348030000000", email="x@lh.com", website="https://lh.com"),
        listing(source_listing_id="C", website="https://lh.com"),
        listing(source_listing_id="D", operator_name="Solo Stays", phone="08120000000"),
    ]

    report = funnel(listings)

    assert report["listings_discovered"] == 4
    assert report["unique_properties"] == 4
    assert report["unique_operators"] == 2
    assert report["multi_property_operators"] == 1
    assert report["operators_with_booking_infrastructure"] == 1


def test_fixture_transport_is_offline() -> None:
    html = FixtureTransport().fetch("fixture://npc-listing-1.html")
    assert "Nigeria Property Centre" in html


def test_operator_profile_shapes_the_lead_contract() -> None:
    operator = consolidate([listing(source_listing_id="1", phone="08030000000", pms_detected="smoobu")])[0]
    lead = operator.to_lead()

    assert set(lead["contact"]) == {"phone", "email", "website", "instagram"}
    assert lead["listingCount"] == 1
    assert lead["pmsFingerprints"] == ["smoobu"]


# ---------------------------------------------------------------------------
# normalisation
# ---------------------------------------------------------------------------


def test_operator_names_collapse_across_portals() -> None:
    variants = ["Lekki Homes Ltd", "LEKKI HOMES LIMITED", "Lekki Homes Nig. Ltd"]
    assert len({normalise_operator_name(v) for v in variants}) == 1


def test_operator_name_is_not_used_when_it_is_only_suffixes() -> None:
    assert normalise_operator_name("Ltd") != ""


def test_operator_key_is_stable() -> None:
    one = operator_key("Lekki Homes Ltd", "Lekki Phase 1", "LA")
    two = operator_key("LEKKI HOMES LIMITED", "lekki phase 1", "LA")
    assert one == two


def test_phones_normalise_to_one_form() -> None:
    for raw in ("0803 000 0000", "+234 803 000 0000", "2348030000000", "8030000000"):
        assert normalise_phone(raw) == "+2348030000000"


def test_unrecognised_phone_is_left_alone() -> None:
    assert normalise_phone("+44 20 7946 0000") == "+44 20 7946 0000"


def test_phone_dedupe_key_matches_across_country_code_typos() -> None:
    assert phone_dedupe_key("+2348030000000") == phone_dedupe_key("08030000000")


def test_plausible_nigerian_mobile_check() -> None:
    assert is_plausible_nigerian_mobile("+2348030000000")
    assert not is_plausible_nigerian_mobile("+442079460000")


def test_area_aliases_collapse_to_one_canonical_name() -> None:
    for raw in ("Lekki Phase 1", "lekki 1", "Lekki phase1", "Lekki Phase 1, Lagos", "LEKKI P1"):
        assert canonical_area(raw) == "Lekki Phase 1"
    assert is_known_area("Lekki 1")
    assert not is_known_area("Somewhere New")


def test_unknown_area_is_kept_rather_than_dropped() -> None:
    assert canonical_area("Brand New Estate") == "Brand New Estate"


def test_prices_parse_and_reject_nonsense() -> None:
    assert parse_price_to_kobo("NGN 220,000") == 22_000_000
    assert parse_price_to_kobo("N150,000 /day") == 15_000_000
    assert parse_price_to_kobo("3") is None


def test_operator_name_from_domain() -> None:
    assert name_from_domain("https://lekkihomes.com") == "Lekkihomes"
    assert name_from_domain("not a url") is None


def test_extract_operator_prefers_structured_data() -> None:
    html = '<script type="application/ld+json">{"seller":{"name":"Lekki Homes Ltd"}}</script>'
    identity = extract_operator(html)
    assert identity is not None
    assert identity.name == "Lekki Homes Ltd"
    assert identity.confidence == "high"


def test_extract_operator_rejects_a_property_description_as_a_name() -> None:
    html = '<div class="agent-name">3 Bedroom Flat For Rent In Lekki</div>'
    identity = extract_operator(html)
    assert identity is None or "Bedroom" not in identity.name


def test_domain_of_ignores_platforms() -> None:
    assert domain_of("https://lekkihomes.ng/x") == "lekkihomes.ng"
    assert domain_of("https://wa.me/2348030000000") is None
    assert domain_of("https://facebook.com/lh") is None


def test_strong_keys_include_the_email_domain() -> None:
    keys = strong_keys(listing(email="bookings@lekkihomes.com"))
    assert "domain:lekkihomes.com" in keys


def test_extract_property_name_reads_og_title_first() -> None:
    html = '<meta property="og:title" content="Nice Flat" /><h1>Other</h1>'
    assert extract_property_name(html) == "Nice Flat"


# ---------------------------------------------------------------------------
# end to end through real parsing
# ---------------------------------------------------------------------------


def test_three_real_fixture_pages_consolidate_to_one_operator() -> None:
    """
    The funnel doing its actual job, through real parsing rather than hand-built
    objects. Three pages, three distinct listing ids, one operator - and no two
    of the three share every signal:

        1  phone 0803 000 0000  +  email stay@adeniyijones.ng
        2  phone 0803 000 0000                          (bridges 1 and 3)
        3  email bookings@adeniyijones.ng + website adeniyijones.ng

    Listing 1 and 3 meet through the shared domain adeniyijones.ng; listing 2
    meets 1 through the phone. A pairwise dedupe would report three operators.
    """
    pages = {
        "npc-listing-1.html": ".../for-rent/short-let/lagos/ikeja/7654321",
        "npc-listing-2.html": ".../for-rent/short-let/lagos/ikeja/7654322",
        "npc-listing-3.html": ".../for-rent/short-let/lagos/ikeja/7654323",
    }

    parsed = []
    for name in sorted(pages):
        html = (FIXTURES / name).read_text(encoding="utf-8")
        result = NPC.parse(html, pages[name])
        assert result is not None, f"{name} did not parse"
        parsed.append(result)

    report = funnel(parsed)

    assert report["listings_discovered"] == 3
    assert report["unique_properties"] == 3
    assert report["unique_operators"] == 1, "three units of one operator must be one lead"
    assert report["multi_property_operators"] == 1
    assert report["operators_with_booking_infrastructure"] == 1

    operator = report["operators"][0]
    assert operator.listing_count == 3
    assert operator.pms_detected == ["smoobu"]
    assert "+2348030000000" in operator.phones
    assert any("adeniyijones" in email for email in operator.emails)
    assert any("adeniyijones" in site for site in operator.websites)


# ---------------------------------------------------------------------------
# the guard
# ---------------------------------------------------------------------------


def test_media_and_prose_are_refused() -> None:
    for field in sorted(FORBIDDEN_FIELDS):
        try:
            assert_no_media_or_prose({"property_name": "x", field: "y"})
        except PolicyViolation:
            continue
        raise AssertionError(f"guard allowed forbidden field '{field}'")


def test_undeclared_fields_are_refused() -> None:
    try:
        assert_no_media_or_prose({"property_name": "x", "something_new": 1})
    except PolicyViolation:
        return
    raise AssertionError("guard allowed an undeclared field")


if __name__ == "__main__":
    import traceback

    failures = 0
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS {name}")
        except Exception:  # noqa: BLE001
            failures += 1
            print(f"  FAIL {name}")
            print("       " + traceback.format_exc().replace("\n", "\n       ").strip())

    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    raise SystemExit(1 if failures else 0)
