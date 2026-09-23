"""
Acquisition tests. Run:  python test_acquisition.py     (or pytest)

The important one is `test_transitive_operator_consolidation`, which encodes the
example from the spec: three listings, no two of which share every signal, that
must still resolve to ONE operator.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from compliance.allowed_fields import (
    FORBIDDEN_FIELDS,
    PolicyViolation,
    assert_no_media_or_prose,
    image_urls_in,
    strip_media,
)
from compliance.non_operator_hosts import is_non_operator_host
from extraction.contact import find_operator_website
from extraction.operator import extract_operator, name_from_domain
from extraction.pms import find_availability_url
from extraction.property import (
    PRICE_BASES,
    PRICE_BASIS_PATTERNS,
    PRICE_RE,
    extract_property_name,
    parse_price_basis,
    parse_price_to_kobo,
)
from extraction.schema import (
    EXA_SUMMARY_FIELDS,
    assert_schema_is_clean,
    exa_summary_schema,
)
from normalization.addresses import canonical_area, is_known_area
from normalization.dedupe import consolidate, domain_of, strong_keys
from normalization.history import Observation, detect_changes
from normalization.names import normalise_operator_name, operator_key
from normalization.phones import is_plausible_nigerian_mobile, normalise_phone, phone_dedupe_key
from ingest.postgres import PostgresIngestor, dsn_for_psycopg
from pipeline import FixtureTransport, build_registry, funnel
from publishing import (
    assert_publishable,
    build_directory,
    contact_route,
    to_affiliate_row,
    to_place_row,
)
from sources.base import AdapterRegistry, DiscoveredListing, SourceLayer
from sources.npc import LAGOS_LOCALITIES, NpcAdapter
from sources.providers import GuardedProvider, ProviderError, build_provider, offline_guard

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


class RecordingCursor:
    def __init__(self) -> None:
        self.statements: list[tuple[str, tuple]] = []
        self._last = ""

    def execute(self, operation: str, parameters: tuple = ()) -> None:
        self._last = operation
        self.statements.append((operation, parameters))

    def fetchone(self):
        if '"SourceRegistry"' in self._last:
            return ("src_fixture",)
        if '"Operator"' in self._last:
            return ("op_fixture",)
        if '"Location"' in self._last:
            return ("loc_fixture",)
        if '"ProspectListing"' in self._last:
            return ("listing_fixture",)
        return None

    def fetchall(self):
        if 'SELECT "code" FROM "State"' in self._last:
            return [("LA",)]
        return []

    def close(self) -> None:
        pass


class RecordingConnection:
    def __init__(self) -> None:
        self.cursor_instance = RecordingCursor()
        self.commits = 0

    def cursor(self):
        return self.cursor_instance

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        pass


def test_database_ingest_dry_run_needs_no_connection() -> None:
    report = PostgresIngestor(None).ingest(
        [listing(source_listing_id="dry-run")], observed_at="2026-09-23", dry_run=True
    )

    assert report.received == 1
    assert report.written == 1
    assert report.rejected_count == 0


def test_database_ingest_rejects_invalid_source_url() -> None:
    report = PostgresIngestor(None).ingest(
        [listing(source_url="not-a-url")], observed_at="2026-09-23", dry_run=True
    )

    assert report.written == 0
    assert report.rejected_count == 1
    assert report.rejected[0].reason == "source_url must be an absolute HTTP(S) URL"


def test_database_ingest_writes_catalogue_observations_not_bookable_units() -> None:
    connection = RecordingConnection()
    report = PostgresIngestor(connection).ingest(
        [listing(source_listing_id="db-write", advertised_price=12_000_000)],
        observed_at="2026-09-23",
    )
    sql = "\n".join(statement for statement, _ in connection.cursor_instance.statements)

    assert report.written == 1
    assert connection.commits == 1
    assert 'INSERT INTO "ProspectListing"' in sql
    assert 'INSERT INTO "ProspectObservation"' in sql
    assert 'INSERT INTO "PriceObservation"' in sql
    assert '"Unit"' not in sql


def test_every_ingest_statement_binds_exactly_the_parameters_it_declares() -> None:
    """A placeholder/parameter mismatch is invisible to a recording cursor.

    The first live run against PostGIS failed with `the query has 23 placeholders
    but 22 parameters were passed` on the ProspectListing upsert: a stray `%s`
    left behind when `propertyId` was taken out of the column list. Mocking cannot
    catch that, so the arity is asserted here for every prepared statement.
    """
    connection = RecordingConnection()
    PostgresIngestor(connection).ingest(
        [listing(source_listing_id="arity", advertised_price=12_000_000)],
        observed_at="2026-09-23",
    )

    statements = connection.cursor_instance.statements
    assert statements

    for statement, parameters in statements:
        assert statement.count("%s") == len(parameters), statement.strip()[:120]


def test_property_linkage_is_left_for_entity_resolution_to_decide() -> None:
    """Ingest must not populate `propertyId`, in the INSERT or the UPDATE.

    A crawl observes a listing; only geocoding/entity resolution may declare that
    several listings are one physical property. Writing a `propertyId` here - or
    overwriting one on re-crawl - would let the crawl invent that decision.
    """
    connection = RecordingConnection()
    PostgresIngestor(connection).ingest(
        [listing(source_listing_id="linkage")], observed_at="2026-09-23"
    )

    listing_sql = next(
        statement
        for statement, _ in connection.cursor_instance.statements
        if 'INSERT INTO "ProspectListing"' in statement
    )

    assert '"propertyId"' not in listing_sql


def test_a_hint_does_not_create_an_operator_row() -> None:
    """The hint is stored on the listing; no Operator row is invented from it.

    `operatorId` stays NULL and rawFacts carries the guess, which is the shape the
    entity-resolution step needs: evidence to weigh, and nothing already asserted.
    """
    connection = RecordingConnection()
    PostgresIngestor(connection).ingest(
        [listing(source_listing_id="hint", operator_hint="Adeniyijones")],
        observed_at="2026-09-23",
    )
    statements = connection.cursor_instance.statements
    sql = "\n".join(statement for statement, _ in statements)
    listing_params = next(
        params for statement, params in statements if 'INSERT INTO "ProspectListing"' in statement
    )

    assert 'INSERT INTO "Operator"' not in sql
    assert any("operator_hint" in str(value) for value in listing_params)


def test_price_basis_is_read_from_the_words_around_the_figure() -> None:
    """Decision: a stated unit of price must not be collapsed into UNKNOWN.

    The enum had no value for per-annum or per-month, and the reader never looked,
    so a NGN 500,000 night and a NGN 500,000 annual rent were stored identically.
    Those are the two most misleading prices on a Nigerian portal, and the
    database could not tell them apart.
    """
    for phrase, expected in (
        ("NGN 500,000 per day", "PER_NIGHT"),
        ("NGN 500,000 per night", "PER_NIGHT"),
        ("NGN 190,000/day", "PER_NIGHT"),
        ("NGN 120,000 per week", "PER_WEEK"),
        ("NGN 2,500,000 per month", "PER_MONTH"),
        ("NGN 2,500,000 monthly", "PER_MONTH"),
        ("NGN 45,000,000 per annum", "PER_YEAR"),
        ("NGN 30,000,000 per year", "PER_YEAR"),
        ("NGN 90,000 per person per night", "PER_PERSON_NIGHT"),
        ("NGN 700,000 for the stay", "PER_STAY"),
    ):
        match = PRICE_RE.search(phrase)
        assert match is not None, phrase
        assert parse_price_basis(phrase, match) == expected, phrase


def test_an_unstated_price_basis_stays_unknown() -> None:
    """Unknown stays unknown - the fix is for *stated* units, not for guesses."""
    bare = "NGN 500,000"

    assert parse_price_basis(bare, PRICE_RE.search(bare)) is None


def test_the_price_bases_match_the_database_enum() -> None:
    """Two files, one set of values, and this is what stops them drifting.

    A basis the enum does not accept would fail as a PostgreSQL error part-way
    through a crawl, after some rows had already been written.
    """
    schema_path = Path(__file__).resolve().parents[2] / "prisma" / "schema.prisma"
    schema = schema_path.read_text(encoding="utf-8")
    block = re.search(r"enum PriceBasis \{([^}]*)\}", schema)

    assert block is not None, "PriceBasis enum not found in prisma/schema.prisma"
    declared = set(block.group(1).split())

    assert declared == set(PRICE_BASES)
    # Every basis the reader can emit must be one the database has a value for.
    assert {basis for _, basis in PRICE_BASIS_PATTERNS} <= declared


def test_an_availability_link_on_the_portal_is_not_an_availability_signal() -> None:
    """Regression: a "similar properties" row read as a calendar.

    An ingested Lagos listing carried an availability URL pointing at a *different
    listing on the same portal*. Nothing validated the host, so Phase 6 would have
    treated a cross-sell link as an availability endpoint.
    """
    listing_url = "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/lekki/3690285-x"
    same_host = (
        '<a href="https://nigeriapropertycentre.com/for-rent/short-let/lagos/lekki/'
        '3664854-sophisticated-2-bedroom-apartment-available">Similar</a>'
    )
    external = '<a href="https://booking.lekkihomes.ng/check-availability">Check</a>'

    assert find_availability_url(same_host, listing_url) is None
    assert (
        find_availability_url(external, listing_url)
        == "https://booking.lekkihomes.ng/check-availability"
    )


def test_both_layers_refuse_the_same_hosts() -> None:
    """One list, two consumers. Drift here fuses two businesses into one call.

    `extraction/contact.py` decides whether a link is the operator's own site;
    `normalization/dedupe.py` decides whether a domain may be a STRONG match key.
    They were separate copies, and the dedupe copy was missing every host added
    while fixing the operator-attribution bug - so a portal or a font CDN could
    have been used as an operator match key.
    """
    for host in (
        "fonts.googleapis.com",
        "ddo5o3z2xgpp2.cloudfront.net",
        "kenyapropertycentre.com",
        "www.instagram.com",
    ):
        assert is_non_operator_host(host), host
        assert domain_of(f"https://{host}/x") is None, host

    assert not is_non_operator_host("lekkihomes.ng")
    assert domain_of("https://lekkihomes.ng/x") == "lekkihomes.ng"


def test_a_profile_with_no_stated_name_is_marked_unidentified() -> None:
    """Decision: a property-derived label is never read as a canonical operator.

    When no source states a name, the label is the listing's own title. Marking it
    is what stops a later step - or a human reading the call list - from treating
    marketing copy as a business, and from creating an `Operator` row for it.
    """
    unidentified = consolidate([listing(source_listing_id="a", phone="08030000000")])[0]
    lead = unidentified.to_lead()

    assert unidentified.identity_status == "UNIDENTIFIED"
    assert lead["identityStatus"] == "UNIDENTIFIED"
    assert lead["canonicalOperatorId"] is None
    # The label is still useful for outreach, and is still not an operator name.
    assert lead["displayName"] == unidentified.display_name

    identified = consolidate([listing(source_listing_id="b", operator_name="Lekki Homes Ltd")])[0]
    assert identified.identity_status == "IDENTIFIED"
    assert identified.to_lead()["identityStatus"] == "IDENTIFIED"


def test_database_ingest_records_the_price_basis() -> None:
    """The basis reaches both the listing and the price observation."""
    connection = RecordingConnection()
    PostgresIngestor(connection).ingest(
        [
            listing(
                source_listing_id="months",
                advertised_price=250_000_000,
                price_basis="PER_MONTH",
            ),
            listing(source_listing_id="bogus", advertised_price=100, price_basis="PER_FORTNIGHT"),
        ],
        observed_at="2026-09-23",
    )

    listing_params = [
        params
        for statement, params in connection.cursor_instance.statements
        if 'INSERT INTO "ProspectListing"' in statement
    ]
    price_params = [
        params
        for statement, params in connection.cursor_instance.statements
        if 'INSERT INTO "PriceObservation"' in statement
    ]

    assert "PER_MONTH" in listing_params[0]
    assert "PER_MONTH" in price_params[0]
    # A value the enum does not have means "not stated", not a database error.
    assert "PER_FORTNIGHT" not in listing_params[1]
    assert "UNKNOWN" in listing_params[1]


def test_the_prisma_connection_string_is_translated_before_psycopg_sees_it() -> None:
    """The exact URL in .env/.env.example, which psycopg rejects unmodified.

    psycopg raises `invalid URI query parameter: "schema"` on it, so the pipeline
    has to translate rather than pass the variable straight through.
    """
    translated = dsn_for_psycopg("postgresql://house3:house3@localhost:5433/house3?schema=public")

    assert translated == "postgresql://house3:house3@localhost:5433/house3"
    assert "schema" not in translated


def test_libpq_parameters_survive_the_translation() -> None:
    translated = dsn_for_psycopg(
        "postgresql://u:p@db.example.com:5432/house3?schema=public&sslmode=require"
        "&connection_limit=5&sslrootcert=ca.pem"
    )

    assert translated == (
        "postgresql://u:p@db.example.com:5432/house3?sslmode=require&sslrootcert=ca.pem"
    )


def test_a_plain_libpq_url_is_returned_byte_for_byte() -> None:
    url = "postgresql://u:p@db.example.com:5432/house3?sslmode=require"

    assert dsn_for_psycopg(url) == url
    assert dsn_for_psycopg("postgresql://house3:house3@localhost:5433/house3") == (
        "postgresql://house3:house3@localhost:5433/house3"
    )


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


class _SitemapTransport:
    """Serves canned sitemap bodies by URL, so discovery can be tested offline."""

    def __init__(self, pages: dict[str, str]) -> None:
        self.pages = pages
        self.fetched: list[str] = []

    def fetch(self, url: str) -> str:
        self.fetched.append(url)
        if url not in self.pages:
            raise AssertionError(f"unexpected fetch: {url}")
        return self.pages[url]


def test_discovery_is_short_lets_only() -> None:
    """Regression: a "Lagos" crawl came back as land and for-sale duplexes.

    The published sitemap carries every property type - 172,186 URLs, of which
    16,322 are short-let. Filtering on the state slug alone matched for-sale
    terraced duplexes advertised at NGN 290,000,000, joint-venture land at
    NGN 2,000,000,000, and flats quoted "per annum" - the wrong inventory at the
    wrong price basis, and the land figure then overflowed the advertised-price
    column and aborted the run. Only /for-rent/short-let/ paths are prospects.
    """
    index = "https://nigeriapropertycentre.com/sitemaps/index.xml"
    shard = "https://nigeriapropertycentre.com/sitemaps/sitemap_listings_1.txt"
    transport = _SitemapTransport(
        {
            index: f"<loc>{shard}</loc>",
            shard: "\n".join(
                [
                    "https://nigeriapropertycentre.com/for-rent/short-let/flats-apartments"
                    "/lagos/lekki/3690285-newly-lunched-3-bedroom-apartment",
                    "https://nigeriapropertycentre.com/for-rent/short-let/houses"
                    "/detached-duplexes/lagos/lekki/lekki-phase-1/3690360-full-duplex",
                    "https://nigeriapropertycentre.com/for-sale/houses/terraced-duplexes"
                    "/lagos/lekki/ikate-elegushi/3690643-distress-sale-4-bedroom",
                    "https://nigeriapropertycentre.com/joint-venture/land/residential-land"
                    "/lagos/lekki/lekki-phase-1/3690640-residential-land",
                    "https://nigeriapropertycentre.com/for-rent/flats-apartments"
                    "/lagos/oniru/3690639-2-bedroom-apartment",
                    "https://nigeriapropertycentre.com/for-rent/short-let/flats-apartments"
                    "/abuja/wuse/zone-6/3690617-furnished-self-contain",
                ]
            ),
        }
    )

    discovered = list(NPC.discover(transport, "LA"))

    assert len(discovered) == 2
    assert all("/for-rent/short-let/" in url for url in discovered)
    assert all("/lagos/" in url for url in discovered)


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

    # The page's canonical wins over the URL we happened to fetch, which is the
    # documented preference order. `7654321` was the URL's id; the fixture
    # declares its own, and the fixture is the more authoritative statement.
    assert parsed.source_listing_id == "1043552"
    assert parsed.source_url.endswith("-1043552")

    # booking infrastructure - the highest-value field
    assert parsed.pms_detected == "smoobu"
    assert parsed.availability_hint_url is not None

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


def test_a_font_cdn_is_not_the_operators_website() -> None:
    """Regression from the first live Lagos ingest into PostGIS.

    NPC pages preconnect to fonts.googleapis.com. The blocklist was compared as
    substrings, and "google.com" is not a substring of "googleapis.com", so the
    font CDN was accepted as the operator's own website. The operator name was
    then inferred from that domain, and all 25 ingested prospects turned out to
    belong to a business called "Fonts" - five different phone numbers collapsed
    into five "Fonts" operators, one per neighbourhood, with unrelated agencies
    merged together. The bundled fixtures contain no such link, which is exactly
    why this survived until a real page was crawled.
    """
    html = (
        '<link rel="preconnect" href="https://fonts.googleapis.com" />'
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />'
        '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/x/x.css" />'
        '<script src="https://www.googletagmanager.com/gtag/js"></script>'
    )
    listing_url = "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/lekki/3690285-x"

    assert find_operator_website(html, listing_url) is None

    # No website, so there is no domain to invent a name from. No name is the
    # honest answer here; "Fonts" was not.
    assert extract_operator(html, None) is None


def test_an_asset_link_is_not_the_operators_website() -> None:
    """The other half of the same bug: the template's own asset host.

    Scanning every `href` meant the operator name came from whichever CDN the
    template used: fonts.googleapis.com gave "Fonts", and the page's stylesheet on
    ddo5o3z2xgpp2.cloudfront.net gave "Ddo5o3z2xgpp2". A per-project hostname is
    not enumerable, so only `<a href>` counts, and a file extension disqualifies
    the rest.
    """
    html = (
        '<link rel="stylesheet" href="https://ddo5o3z2xgpp2.cloudfront.net/e2f6/build/app.css" />'
        '<link rel="preconnect" href="https://fonts.gstatic.com" />'
        "<script src=\"https://app.smoobu.com/js/booking-widget.js\"></script>"
        '<a href="https://ddo5o3z2xgpp2.cloudfront.net/build/app.css">Terms</a>'
    )
    url = "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/lekki/3690285-x"

    assert find_operator_website(html, url) is None
    assert extract_operator(html, None) is None


def test_a_sister_portal_is_not_the_operators_website() -> None:
    """Third variant of the same bug, and the reason the family is matched.

    NPC's footer links to its own portals in other countries, so the operator name
    was inferred from kenyapropertycentre.com - which put a real Nigerian agency's
    phone number on the directory attributed to "Kenyapropertycentre". A portal is
    never the operator, whichever country it serves.
    """
    html = '<a href="https://kenyapropertycentre.com/for-rent/short-let">Kenya Property Centre</a>'
    url = "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/lekki/3690360-x"

    assert find_operator_website(html, url) is None
    assert extract_operator(html, None) is None


def test_a_domain_derived_name_is_a_hint_not_an_operator() -> None:
    """Decision: a domain is a hint for entity resolution, never an identity.

    The ladder's last rung *guesses* a business name from a domain. Acting on it
    attributed a whole Lagos crawl to a font CDN, then a stylesheet CDN, then a
    sister portal, and merged fourteen unrelated properties in one neighbourhood
    into a single operator. The guess is now recorded as a hint, and the listing
    carries no operator until something actually establishes one.
    """
    html = (
        "<html><head><title>3 bedroom flat</title></head><body>"
        "<h1>Luxury 3 Bedrooms Flats with City View</h1>"
        '<p class="price">₦220,000</p>'
        '<a href="https://adeniyijones.ng/availability">Check availability</a>'
        "</body></html>"
    )
    url = "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/ikeja/7654321"

    parsed = NPC.parse(html, url)

    assert parsed is not None
    assert parsed.operator_name is None
    assert parsed.operator_hint == "Adeniyijones"

    # It reaches the database as a fact, and not as an identity.
    assert parsed.to_record()["operator_hint"] == "Adeniyijones"
    assert "operator_name" not in parsed.to_record()


def test_a_stated_operator_name_is_still_an_identity() -> None:
    """The hint rule must not discard a name the source actually publishes."""
    html = (
        '<script type="application/ld+json">{"seller":{"name":"Lekki Homes Ltd"}}</script>'
        "<h1>Luxury 3 Bedrooms Flats with City View</h1>"
        '<a href="https://adeniyijones.ng/availability">Check availability</a>'
    )
    url = "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/ikeja/7654321"

    parsed = NPC.parse(html, url)

    assert parsed is not None
    assert parsed.operator_name == "Lekki Homes Ltd"
    assert parsed.operator_hint is None


def test_only_a_stated_name_counts_as_an_identity() -> None:
    """Each rung of the ladder reports itself, and only two of three are evidence."""
    structured = extract_operator(
        '<script type="application/ld+json">{"seller":{"name":"Lekki Homes Ltd"}}</script>'
    )
    markup = extract_operator('<div class="agency-name">Lekki Homes Ltd</div>')
    inferred = extract_operator("<h1>Somewhere</h1>", "https://lekkihomes.ng")

    assert structured is not None and structured.is_identity
    assert markup is not None and markup.is_identity
    assert inferred is not None and not inferred.is_identity
    assert inferred.confidence == "low"


def test_a_real_operator_site_survives_the_blocklist() -> None:
    """The blocklist must not be so eager that it drops genuine operator sites."""
    html = (
        '<link rel="preconnect" href="https://fonts.googleapis.com" />'
        '<a href="https://www.lekkihomes.ng/contact">Visit our website</a>'
    )
    url = "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/lekki/3690285-x"

    assert find_operator_website(html, url) == "https://www.lekkihomes.ng/contact"
    assert name_from_domain("https://www.lekkihomes.ng") == "Lekkihomes"


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


# ---------------------------------------------------------------------------
# page identity: canonical URL beats the URL we fetched
# ---------------------------------------------------------------------------


def test_list_page_url_does_not_become_the_listing_id() -> None:
    """
    Regression test for a real bug the fixture run surfaced.

    Discovery yields list pages as a fallback when the sitemap is unavailable.
    Every row on /for-rent/short-let/lagos was therefore keyed by the *state
    slug*, collapsing a whole page of listings into one record - which silently
    broke both the funnel's "unique properties" count and change detection,
    because every observation shared a key.
    """
    html = (FIXTURES / "npc-listing-1.html").read_text(encoding="utf-8")
    list_page = "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos"
    parsed = NPC.parse(html, list_page)

    assert parsed is not None
    assert parsed.source_listing_id != "lagos"
    assert parsed.source_listing_id == "1043552"


def test_the_reference_id_survives_a_title_change() -> None:
    """The listing's number is the key, not the words the operator can edit.

    A live Lagos run produced source_listing_id values such as
    '3690285-newly-lunched-3-bedroom-apartment-with-perfect-aesthetics' - the
    listing's *title*. NPC rewrites that slug when a title is edited, so the same
    listing would be ingested as a second record on the next crawl, which breaks
    the one-listing-one-record invariant the ingest is supposed to guarantee.
    """
    lead = (
        "https://nigeriapropertycentre.com/for-rent/short-let/flats-apartments/"
        "lagos/lekki/3690285-"
    )

    assert NPC._listing_id(f"{lead}newly-lunched-3-bedroom-apartment") == "3690285"
    assert NPC._listing_id(f"{lead}a-totally-different-title-after-an-edit") == "3690285"


def test_every_observed_reference_id_shape_is_read() -> None:
    """The publisher puts the reference first, last, or alone. All three are live."""
    base = "https://www.nigeriapropertycentre.com/for-rent/short-let"

    # reference last - the bundled fixture and the older path shape
    assert NPC._listing_id(f"{base}/lagos/ikeja/luxury-3-bedrooms-flats-1043552") == "1043552"
    # reference first - the shape the current sitemap publishes
    assert (
        NPC._listing_id(
            f"{base}/houses/detached-duplexes/lagos/lekki/lekki-phase-1/3690360-full-duplex"
        )
        == "3690360"
    )
    # bare reference
    assert NPC._listing_id(f"{base}/lagos/ikeja/7654321") == "7654321"


def test_a_canonical_without_a_listing_reference_is_not_adopted() -> None:
    """Regression: a template that publishes its breadcrumb toggle as canonical.

    A live Lagos page identified as 'showtype', because that is the last segment
    of the URL its <link rel="canonical"> pointed at. Every page on that template
    would then share one (source, sourceListingId) key - the uniqueness key - and
    each would overwrite the previous one's source_url, silently merging distinct
    properties. The fetched URL is the safe answer: it is the page we read.
    """
    html = (
        "<html><head>"
        '<link rel="canonical" '
        'href="https://www.nigeriapropertycentre.com/for-rent/short-let/houses/showtype" />'
        "</head><body></body></html>"
    )
    fetched = (
        "https://www.nigeriapropertycentre.com/for-rent/short-let/houses/"
        "detached-duplexes/lagos/lekki/lekki-phase-1/3690360-full-duplex"
    )

    source_url, source_listing_id = NPC._identify(html, fetched)

    assert source_url == fetched
    assert source_listing_id == "3690360"


def test_canonical_on_another_host_is_ignored() -> None:
    """
    A canonical pointing off-host is a syndicated copy or a publisher mistake.
    Adopting it would make our provenance point at someone else's page.
    """
    html = (
        "<html><head>"
        '<link rel="canonical" href="https://scraper.example/listing/9999999" />'
        '<meta property="og:title" content="Somewhere Else Apartments" />'
        "</head><body><h1>Somewhere Else Apartments</h1>"
        '<p class="price">₦150,000</p></body></html>'
    )
    url = "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/ikeja/7654321"
    parsed = NPC.parse(html, url)

    assert parsed is not None
    assert parsed.source_listing_id == "7654321"
    assert parsed.source_url == url


def test_each_fixture_is_a_distinct_property_from_one_operator() -> None:
    """
    Fixture mode exists to demonstrate consolidation through real parsing. If it
    ever collapses to one property again, this fails.
    """
    registry = build_registry()
    adapter = registry.get("npc")

    listings = [
        adapter.parse((FIXTURES / name).read_text(encoding="utf-8"), url)
        for name, url in (
            ("npc-listing-1.html", "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos"),
            ("npc-listing-2.html", "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos"),
            ("npc-listing-3.html", "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos"),
        )
    ]
    usable = [listing for listing in listings if listing is not None]

    report = funnel(usable)
    assert report["unique_properties"] == 3
    # One operator across three units is exactly the acquisition signal we want.
    assert report["unique_operators"] == 1
    assert report["unique_properties"] != report["unique_operators"]


# ---------------------------------------------------------------------------
# media stripping
# ---------------------------------------------------------------------------


def test_strip_media_removes_every_route_to_a_photograph() -> None:
    """
    The guard has to hold for any way a developer can reference a file, not just
    the <img> tag we thought of first.
    """
    html = """
    <div class="gallery">
      <img src="https://cdn.nigeriapropertycentre.com/listing/1043552/1.jpg" alt="Living room" />
      <picture><source srcset="https://cdn.x/2.webp 1x, https://cdn.x/3.webp 2x" /></picture>
      <figure><img data-lazy-src="/media/4.JPEG" /><figcaption>Ensuite</figcaption></figure>
      <div style="background-image: url('/media/5.png')"></div>
      <a href="https://cdn.x/6.gif?w=800">gallery</a>
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" />
      <script>var photos = ["https://cdn.x/7.avif"];</script>
    </div>
    <p class="price">₦240,000 /day</p>
    <a href="tel:+2348030000000">Call agent</a>
    """

    stripped = strip_media(html)

    # Every image extension is gone, including the uppercase one and the
    # one buried in a JSON blob.
    for leftover in (".jpg", ".jpeg", ".JPEG", ".webp", ".png", ".gif", ".avif"):
        assert leftover.lower() not in stripped.lower()

    # Container elements go whole, so no orphaned caption survives to suggest
    # there was a photograph.
    assert "<img" not in stripped
    assert "<picture" not in stripped
    assert "<figure" not in stripped
    assert "Living room" not in stripped
    assert "Ensuite" not in stripped

    # The operator's own alt text is prose about the property, so it leaves too.
    assert "alt=" not in stripped

    # Facts we are allowed to keep are untouched. This is the important half:
    # a guard that ate the price would be worse than no guard.
    assert "₦240,000" in stripped
    assert "+2348030000000" in stripped


def test_image_urls_in_reports_what_would_be_removed() -> None:
    html = '<img src="https://cdn.x/a.jpg"><img src="/b.png">'
    assert len(image_urls_in(html)) == 2


def test_strip_media_is_safe_on_ordinary_markup() -> None:
    html = "<html><body><h1>Flat</h1></body></html>"
    assert strip_media(html) == html


# ---------------------------------------------------------------------------
# structured-output schema is derived from the allowlist
# ---------------------------------------------------------------------------


def test_exa_schema_only_requests_allowlisted_fields() -> None:
    from compliance.allowed_fields import ALLOWED_FIELDS

    schema = exa_summary_schema()
    requested = set(schema["properties"])
    assert requested == set(EXA_SUMMARY_FIELDS)
    assert requested <= ALLOWED_FIELDS


def test_exa_schema_cannot_be_built_with_a_forbidden_field() -> None:
    """
    The dangerous hole in a vendor API is that you can ask it for arbitrary
    text. Asking for a description or an image would launder collection through
    a third party, so it raises instead.
    """
    for forbidden in ("description", "images", "agent_name"):
        try:
            exa_summary_schema(frozenset({"operator_name", forbidden}))
        except PolicyViolation as exc:
            assert forbidden in str(exc)
        else:
            raise AssertionError(f"schema accepted forbidden field {forbidden!r}")


def test_exa_schema_rejects_undeclared_fields() -> None:
    try:
        exa_summary_schema(frozenset({"operator_name", "carpet_colour"}))
    except PolicyViolation as exc:
        assert "carpet_colour" in str(exc)
    else:
        raise AssertionError("schema accepted an undeclared field")


def test_assert_schema_is_clean_checks_a_hand_built_schema() -> None:
    ok = {"properties": {"operator_name": {"type": "string"}}}
    assert assert_schema_is_clean(ok) is ok

    dirty = {"properties": {"operator_name": {"type": "string"}, "photos": {"type": "array"}}}
    try:
        assert_schema_is_clean(dirty)
    except PolicyViolation:
        pass
    else:
        raise AssertionError("dirty schema passed")


# ---------------------------------------------------------------------------
# listing history and change detection
# ---------------------------------------------------------------------------


def _observation(listing_id: str, day: str, price: int | None = 200_000) -> Observation:
    return Observation(
        source="npc",
        source_listing_id=listing_id,
        observed_on=day,
        advertised_price=price,
        bedrooms=3,
        area="Lekki Phase 1",
    )


def _history(previous: list[tuple[str, str, int]]) -> list:
    """Build histories from (listing_id, day, price) tuples."""
    from normalization.history import ListingHistory

    histories: dict[str, ListingHistory] = {}
    for listing_id, day, price in previous:
        history = histories.setdefault(
            listing_id, ListingHistory(source="npc", source_listing_id=listing_id)
        )
        history.add(_observation(listing_id, day, price))
    return list(histories.values())


def test_first_run_reports_everything_as_new() -> None:
    changes = detect_changes([], [_observation("1", "2026-09-01")], today="2026-09-01")
    assert len(changes.new_listings) == 1
    assert changes.price_changes == []
    assert changes.delisted == []


def test_unchanged_listing_is_not_reported_as_new() -> None:
    known = _history([("1", "2026-09-01", 200_000)])
    changes = detect_changes(known, [_observation("1", "2026-09-02", 200_000)], today="2026-09-02")

    assert changes.new_listings == []
    assert len(changes.unchanged) == 1
    assert changes.price_changes == []


def test_price_change_is_detected_with_direction_and_percent() -> None:
    known = _history([("1", "2026-09-01", 200_000)])
    changes = detect_changes(known, [_observation("1", "2026-09-08", 170_000)], today="2026-09-08")

    assert len(changes.price_changes) == 1
    change = changes.price_changes[0]
    assert change.previous == 200_000
    assert change.current == 170_000
    assert change.delta == -30_000
    assert change.direction == "cut"
    assert change.percent() == -15.0


def test_price_rise_is_labelled_a_rise() -> None:
    known = _history([("1", "2026-09-01", 100_000)])
    changes = detect_changes(known, [_observation("1", "2026-09-05", 125_000)], today="2026-09-05")
    assert changes.price_changes[0].direction == "rise"
    assert changes.price_changes[0].percent() == 25.0


def test_same_day_rerun_does_not_invent_a_price_change() -> None:
    """
    A crawl re-run inside a day must not look like new inventory or a rate
    movement. Without this, running twice in an afternoon would inflate both.
    """
    known = _history([("1", "2026-09-01", 200_000)])
    changes = detect_changes(known, [_observation("1", "2026-09-01", 200_000)], today="2026-09-01")

    assert changes.new_listings == []
    assert changes.price_changes == []
    assert len(changes.unchanged) == 1


def test_delisting_waits_for_the_grace_period() -> None:
    """
    Portals reorder, and a crawl that stopped early looks exactly like a listing
    being withdrawn. A single miss is not evidence.
    """
    known = _history([("1", "2026-09-01", 200_000)])

    inside = detect_changes(known, [], today="2026-09-04")
    assert inside.delisted == []

    outside = detect_changes(known, [], today="2026-09-20")
    assert len(outside.delisted) == 1
    assert outside.delisted[0].source_listing_id == "1"


def test_days_on_market_is_a_floor_not_an_exact_age() -> None:
    from normalization.history import ListingHistory

    history = ListingHistory(source="npc", source_listing_id="1")
    history.add(_observation("1", "2026-09-01"))
    history.add(_observation("1", "2026-09-11"))

    assert history.first_seen == "2026-09-01"
    assert history.last_seen == "2026-09-11"
    assert history.days_on_market(today="2026-09-21") == 20


def test_a_listing_with_no_price_reports_no_price_change() -> None:
    known = _history([("1", "2026-09-01", None)])
    changes = detect_changes(known, [_observation("1", "2026-09-05", 200_000)], today="2026-09-05")

    assert changes.price_changes == []
    assert len(changes.unchanged) == 1


# ---------------------------------------------------------------------------
# providers
# ---------------------------------------------------------------------------


class _RecordingProvider:
    """A provider that returns fixed HTML and counts how often it was called."""

    name = "recording"

    def __init__(self, html: str) -> None:
        self.html = html
        self.calls: list[str] = []

    def fetch(self, url: str) -> str:
        self.calls.append(url)
        return self.html


class _DenyAll:
    def allowed(self, url: str) -> bool:
        return False

    def crawl_delay(self, url: str) -> float | None:
        return None

    def sitemaps(self, url: str) -> list[str]:
        return []


class _AllowAll:
    def __init__(self, delay: float | None = None) -> None:
        self.delay = delay

    def allowed(self, url: str) -> bool:
        return True

    def crawl_delay(self, url: str) -> float | None:
        return self.delay

    def sitemaps(self, url: str) -> list[str]:
        return []


def test_guard_refuses_to_fetch_when_robots_disallows() -> None:
    """
    The whole point of the wrapper: a disallowed URL is never requested, however
    it reached the pipeline. This is what a paid crawl provider cannot be
    trusted to enforce for us.
    """
    from compliance.rate_limit import HostThrottle

    inner = _RecordingProvider("<html></html>")
    guard = GuardedProvider(inner, _DenyAll(), HostThrottle(interval_seconds=0.0), 0.0)

    try:
        guard.fetch("https://example.com/secret")
    except PolicyViolation:
        pass
    else:
        raise AssertionError("guard fetched a disallowed URL")

    assert inner.calls == [], "the inner provider was called despite a robots refusal"


def test_guard_strips_media_from_provider_output() -> None:
    """
    Media stripping runs on whatever a provider returns, so swapping the stdlib
    transport for a managed service does not open the door to photographs.
    """
    from compliance.rate_limit import HostThrottle

    inner = _RecordingProvider('<html><img src="https://cdn.x/a.jpg"><p>₦200,000</p></html>')
    guard = GuardedProvider(inner, _AllowAll(), HostThrottle(interval_seconds=0.0), 0.0)

    stripped = guard.fetch("https://example.com/listing")
    assert ".jpg" not in stripped
    assert "₦200,000" in stripped


def test_guard_uses_a_published_crawl_delay_over_our_own_interval() -> None:
    from compliance.rate_limit import HostThrottle

    throttle = HostThrottle(interval_seconds=0.0)
    guard = GuardedProvider(
        _RecordingProvider("<html></html>"),
        _AllowAll(delay=0.0),
        throttle,
        0.0,
    )
    guard.fetch("https://example.com/one")
    guard.fetch("https://example.com/two")
    assert len(throttle._last_hit) == 1


def test_offline_guard_needs_no_network() -> None:
    guard = offline_guard(FixtureTransport(FIXTURES))
    assert "Luxury 3 Bedrooms" in guard.fetch("https://www.nigeriapropertycentre.com/anything")


def test_unknown_transport_is_rejected_by_name() -> None:
    try:
        build_provider("telepathy")
    except ProviderError as exc:
        assert "telepathy" in str(exc)
    else:
        raise AssertionError("unknown transport was accepted")


def test_paid_provider_without_a_key_explains_how_to_run_instead() -> None:
    """A missing key is a config mistake, so the error should name the fix."""
    try:
        build_provider("firecrawl")
    except ProviderError as exc:
        assert "FIRECRAWL_API_KEY" in str(exc)
    else:
        raise AssertionError("firecrawl built without a key")


# ---------------------------------------------------------------------------
# the publishable projection
# ---------------------------------------------------------------------------


def _listing(**overrides) -> DiscoveredListing:
    base = {
        "source": "npc",
        "source_url": "https://www.nigeriapropertycentre.com/for-rent/short-let/lagos/ikeja/x-1043552",
        "source_listing_id": "1043552",
        "property_name": "Luxury 3 Bedrooms Flats with City View",
        "property_type": "SHORTLET",
        "bedrooms": 3,
        "bathrooms": 3,
        "advertised_price": 20_000_000,
        "state": "LA",
        "city": "Lagos",
        "area": "Ikeja",
        "operator_name": "Adeniyi Jones Residences Ltd",
        "phone": "0803 000 0000",
    }
    base.update(overrides)
    return DiscoveredListing(**base)


def test_published_row_carries_only_facts() -> None:
    row = to_place_row(_listing(), "2026-09-23")

    assert row["operator_name"] == "Adeniyi Jones Residences Ltd"
    assert row["advertised_price"] == 20_000_000
    assert row["bedrooms"] == 3


def test_published_row_never_carries_the_operators_listing_title() -> None:
    """
    A listing title is the operator's marketing copy, not a fact about the
    property, so it stays internal for dedupe and never reaches a public page.
    """
    row = to_place_row(_listing(), "2026-09-23")

    assert "property_name" not in row
    assert not any(
        isinstance(value, str) and "Luxury" in value for value in row.values()
    ), row


def test_publish_guard_rejects_media_and_prose() -> None:
    for leaked in ({"photos": ["a.jpg"]}, {"description": "A lovely home"}, {"image": "x.jpg"}):
        try:
            assert_publishable({**{"operator_name": "X"}, **leaked})
        except PolicyViolation as exc:
            assert list(leaked)[0] in str(exc)
        else:
            raise AssertionError(f"publish guard allowed {leaked}")


def test_publish_guard_rejects_undeclared_fields() -> None:
    try:
        assert_publishable({"operator_name": "X", "internal_score": 9})
    except PolicyViolation as exc:
        assert "internal_score" in str(exc)
    else:
        raise AssertionError("publish guard allowed an undeclared field")


def test_contact_route_ignores_an_unauthorized_crawl_booking_url() -> None:
    """A crawled booking link is research, not a route we may send a guest down."""
    assert contact_route(_listing(booking_url="https://x/book"))["kind"] == "PHONE"
    assert contact_route(_listing(phone=None, booking_url="https://x/book")) is None
    assert contact_route(_listing(phone="0803 000 0000"))["kind"] == "PHONE"
    assert contact_route(_listing(phone=None, website="https://x"))["kind"] == "WEBSITE"
    assert contact_route(_listing(phone=None, email="a@b.ng"))["kind"] == "EMAIL"
    assert contact_route(_listing(phone=None)) is None


def test_phone_route_is_a_tel_link_without_spaces() -> None:
    route = contact_route(_listing())
    assert route["href"] == "tel:08030000000"


def test_crawled_rows_are_directory_rows_and_never_expose_booking_urls() -> None:
    directory = build_directory(
        [_listing(booking_url="https://x/book")],
        "2026-09-23",
        attribution="Nigeria Property Centre",
    )

    row = directory["places"][0]
    assert row["distribution"] == "DIRECTORY"
    assert "booking_url" not in row
    assert "affiliate_url" not in row
    assert row["contact_route"]["kind"] != "AFFILIATE_URL"


def _affiliate_args(**overrides) -> dict:
    args = {
        "id": "partner:unit-1",
        "operator_name": "Example Operator Ltd",
        "phone": None,
        "email": None,
        "website": "https://example.com",
        "property_type": "SHORTLET",
        "bedrooms": 2,
        "bathrooms": 2,
        "state": "LA",
        "city": "Lagos",
        "area": "Ikeja",
        "advertised_price": 15_000_000,
        "currency": "NGN",
        "source": "affiliate_feed",
        "source_url": "https://example.com/feed/unit-1",
        "attribution": "Example Partner Feed",
        "first_seen_at": "2026-09-23",
        "last_seen_at": "2026-09-23",
        "affiliate_partner": "Example Partner",
        "affiliate_url": "https://example.com/aff?ref=house3",
        "affiliate_disclosure": "We may earn a commission.",
    }
    args.update(overrides)
    return args


def test_to_affiliate_row_requires_authorization_metadata() -> None:
    row = to_affiliate_row(**_affiliate_args())

    assert row["distribution"] == "AFFILIATE"
    assert row["affiliate_partner"] == "Example Partner"
    assert row["affiliate_url"] == "https://example.com/aff?ref=house3"
    assert row["affiliate_disclosure"] == "We may earn a commission."
    assert row["contact_route"] == {
        "kind": "AFFILIATE_URL",
        "href": "https://example.com/aff?ref=house3",
    }
    assert_publishable(row)


def test_to_affiliate_row_rejects_invalid_authorization_metadata() -> None:
    invalid = (
        {"affiliate_partner": ""},
        {"affiliate_disclosure": ""},
        {"affiliate_url": "not-a-url"},
        {"affiliate_url": "javascript:alert(1)"},
        {"affiliate_url": "http://"},
        {"first_seen_at": ""},
        {"last_seen_at": None},
        {"attribution": ""},
    )
    for overrides in invalid:
        try:
            to_affiliate_row(**_affiliate_args(**overrides))
        except PolicyViolation:
            continue
        raise AssertionError(f"affiliate row accepted invalid metadata: {overrides}")


def test_directory_declares_media_as_absent_rather_than_omitting_it() -> None:
    """
    A guest should be able to tell "no photographs we may show" from "the page
    failed to load them". Declaring it null is what makes that possible.
    """
    directory = build_directory([_listing()], "2026-09-23", attribution="Nigeria Property Centre")

    assert directory["media"] is None


def test_directory_deduplicates_a_place_seen_twice() -> None:
    """A sitemap walk and a list page both see the same listing."""
    directory = build_directory(
        [_listing(), _listing(property_name="Same place, seen again")],
        "2026-09-23",
        attribution="Nigeria Property Centre",
    )

    assert directory["counts"]["places"] == 1


def test_directory_counts_how_many_places_we_can_actually_reach() -> None:
    contactable = _listing()
    unreachable = _listing(source_listing_id="999", phone=None)

    directory = build_directory([contactable, unreachable], "2026-09-23", attribution="Source")

    assert directory["counts"]["places"] == 2
    assert directory["counts"]["contactable"] == 1


def test_places_we_cannot_reach_are_listed_after_ones_we_can() -> None:
    unreachable = _listing(source_listing_id="999", phone=None)
    contactable = _listing(source_listing_id="111")

    directory = build_directory([unreachable, contactable], "2026-09-23", attribution="Source")

    assert directory["places"][0]["contact_route"]["kind"] != "NONE"
    assert directory["places"][-1]["contact_route"]["kind"] == "NONE"


def test_every_published_row_carries_its_attribution() -> None:
    directory = build_directory(
        [_listing(), _listing(source_listing_id="2")], "2026-09-23", attribution="Nuclear Portal"
    )

    assert all(place["attribution"] == "Nuclear Portal" for place in directory["places"])


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
