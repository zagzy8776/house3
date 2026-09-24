"""
Acquisition pipeline - orchestration and the funnel.

    discover -> fetch -> parse -> consolidate -> score -> call list

The funnel is printed at the end, because the drop-off between stages is the only
honest measure of whether a crawl is going well:

    listings discovered
      -> usable records                        (parse succeeded, facts present)
      -> unique properties                     (source_listing_id collisions removed)
      -> unique operators                      (consolidation)
      -> multi-property operators              (the ones worth a call)
      -> operators with booking infrastructure (cheapest to onboard)

Usage:
    python pipeline.py --source npc --fixture
    python pipeline.py --source npc --state LA --area lekki
    python pipeline.py --dump-html <url>        # capture a page to verify selectors
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import asdict, replace
from datetime import date
from pathlib import Path
from typing import Optional

from urllib.parse import urlparse

from compliance.allowed_fields import PolicyViolation
from compliance.rate_limit import HostThrottle
from compliance.robots import RobotsCache
from extraction.schema import exa_summary_schema
from normalization.dedupe import OperatorProfile, consolidate
from normalization.history import ListingHistory, Observation, detect_changes
from publishing import build_directory
from sources.base import AdapterRegistry, DiscoveredListing
from sources.npc import NpcAdapter
from sources.propertypro import PropertyproAdapter
from sources.providers import (
    FixtureTransport,
    GuardedProvider,
    ProviderError,
    build_discovery,
    build_provider,
    offline_guard,
)

FIXTURES = Path(__file__).parent / "fixtures"


class Transport:
    """Kept as a name for the adapters' type hints. See sources/providers.py."""

    def fetch(self, url: str) -> str:  # pragma: no cover - interface
        raise NotImplementedError


def build_registry() -> AdapterRegistry:
    registry = AdapterRegistry()
    registry.register(NpcAdapter())
    registry.register(PropertyproAdapter())
    return registry


def crawl(
    adapter,
    transport: Transport,
    state_code: str,
    area: Optional[str] = None,
    max_listings: int = 500,
    interval_seconds: float = 5.0,
    enforce_policy: bool = True,
    guard: Optional[GuardedProvider] = None,
) -> dict:
    """
    Run one adapter over one state and return the funnel.

    Every fetch passes the robots check and the throttle. A misconfigured adapter
    pointed at a host it does not own is refused rather than silently obeyed.

    `guard` exists so a multi-state run can share one robots cache and one
    throttle. Five states on one host are still one host: rebuilding the throttle
    per state would hit NPC five times faster than the interval we promised it.

    `enforce_policy=False` is fixture mode only: it swaps in a robots stub and
    drops the throttle, because the fixture provider reads files and touches no
    network. It is a named parameter rather than a consequence of the transport
    type so that a real run cannot end up here by accident.
    """
    if guard is None:
        if enforce_policy:
            guard = GuardedProvider(
                transport,
                RobotsCache(),
                HostThrottle(interval_seconds=interval_seconds),
                min_interval_seconds=interval_seconds,
            )
        else:
            guard = offline_guard(transport)

    listings: list[DiscoveredListing] = []
    stats = {
        "discovered": 0,
        "fetched": 0,
        "usable": 0,
        "skipped_robots": 0,
        "failed": 0,
        "parse_failed": 0,
    }

    for url in adapter.discover(guard, state_code, area):
        if stats["discovered"] >= max_listings:
            break
        stats["discovered"] += 1

        # An adapter pointed at a host it does not own is a bug, and a crawler
        # that follows it is a crawler someone else has to deal with.
        host_ok = urlparse(url).netloc.endswith(adapter.host.replace("www.", ""))
        if not host_ok:
            stats["skipped_robots"] += 1
            continue

        try:
            html = guard.fetch(url)
            stats["fetched"] += 1
        except PolicyViolation:
            stats["skipped_robots"] += 1
            continue
        except Exception as exc:
            stats["failed"] += 1
            print(f"  FAIL {url}: {exc}", file=sys.stderr)
            continue

        try:
            listing = adapter.parse(html, url)
        except Exception as exc:
            stats["parse_failed"] += 1
            print(f"  PARSE-FAIL {url}: {exc}", file=sys.stderr)
            continue

        if listing is None:
            stats["parse_failed"] += 1
            continue

        listings.append(listing)

    stats["usable"] = len(listings)
    return {
        "stats": stats,
        "listings": listings,
        "provider": guard.name,
        "policy_enforced": enforce_policy,
    }


def to_observations(listings: list[DiscoveredListing], observed_on: str) -> list[Observation]:
    """
    Reduce a crawl to the facts worth keeping over time.

    Only fields that can plausibly change while a listing stays up: price, size,
    area. The operator's phone number is a fact about the operator, not about
    this listing's week, and belongs in the lead record instead.
    """
    return [
        Observation(
            source=listing.source,
            source_listing_id=listing.source_listing_id,
            observed_on=observed_on,
            advertised_price=listing.advertised_price,
            currency=listing.currency,
            bedrooms=listing.bedrooms,
            area=listing.area,
        )
        for listing in listings
    ]


def load_ledger(path: Path) -> list[ListingHistory]:
    """
    Replay an append-only observation ledger into per-listing histories.

    A ledger file rather than a table, deliberately: this is the step that must
    work before there is a database, and a JSONL file is one you can inspect,
    diff and hand to a colleague. The Postgres ingest reads the same file.
    """
    if not path.exists():
        return []

    grouped: dict[tuple[str, str], list[Observation]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        record = json.loads(line)
        observation = Observation(
            source=record["source"],
            source_listing_id=str(record["source_listing_id"]),
            observed_on=record["observed_on"],
            advertised_price=record.get("advertised_price"),
            currency=record.get("currency") or "NGN",
            bedrooms=record.get("bedrooms"),
            area=record.get("area"),
        )
        grouped.setdefault(observation.key, []).append(observation)

    histories: list[ListingHistory] = []
    for key, observations in grouped.items():
        history = ListingHistory(source=key[0], source_listing_id=key[1])
        # Sorted, so a ledger that was written out of order still replays into
        # a correct price history rather than a scrambled one.
        for observation in sorted(observations, key=lambda o: o.observed_on):
            history.add(observation)
        histories.append(history)
    return histories


def append_ledger(path: Path, observations: list[Observation]) -> int:
    """Append this run to the ledger. Append-only, so history is never lost."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as sink:
        for observation in observations:
            sink.write(json.dumps(observation.to_dict(), ensure_ascii=False) + "\n")
    return len(observations)


def funnel(listings: list[DiscoveredListing]) -> dict:
    """
    The counts that actually tell you whether the crawl worked.

    'Unique properties' and 'unique operators' are different numbers on purpose:
    the gap between them is the value consolidation delivers. If they are equal,
    consolidation is not working.
    """
    unique_properties = {listing.source_listing_id for listing in listings}
    operators = consolidate(listings)
    multi = [operator for operator in operators if operator.listing_count >= 2]
    bookable_ready = [operator for operator in multi if operator.has_direct_booking]

    return {
        "listings_discovered": len(listings),
        "unique_properties": len(unique_properties),
        "unique_operators": len(operators),
        "multi_property_operators": len(multi),
        "operators_with_booking_infrastructure": len(bookable_ready),
        "operators": operators,
    }


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="House3 partner acquisition pipeline")
    parser.add_argument("--source", default="npc", help="adapter name (see sources/)")
    parser.add_argument(
        "--state",
        help="one state code; overrides --states when set (LA, FC, OY, IM, AK)",
    )
    parser.add_argument(
        "--states",
        default="LA,FC,OY,IM,AK",
        help="comma-separated state codes to crawl",
    )
    parser.add_argument("--area", help="restrict to one neighbourhood, e.g. lekki")
    parser.add_argument("--out", default="leads.jsonl", help="prospect output path")
    parser.add_argument(
        "--publish",
        default="directory.json",
        help="publishable place rows for the public site; '-' to skip",
    )
    parser.add_argument(
        "--publish-from",
        help=(
            "publish from an existing records file (JSON array or JSONL of "
            "DiscoveredListing records) without crawling. Used to re-publish a "
            "frozen crawl stage - e.g. after publishing changed - without "
            "re-fetching thousands of pages. Writes --publish and exits."
        ),
    )
    parser.add_argument(
        "--verify-photos",
        action="store_true",
        help=(
            "with --publish-from, fetch each listing's candidate photographs and "
            "keep only the ones with no watermark in the pixels. Makes real HTTP "
            "requests per image, so it is opt-in."
        ),
    )

    parser.add_argument(
        "--attribution",
        default="Nigeria Property Centre",
        help="the source we name on every published row",
    )
    parser.add_argument(
        "--ledger",
        default="listing-observations.jsonl",
        help=(
            "append-only observation log for runs with no database; when --ingest db is "
            "used the observation tables are the ledger instead"
        ),
    )
    parser.add_argument(
        "--observed-on",
        help=(
            "ISO date to stamp on published rows. Defaults to today. Setting it "
            "explicitly makes re-publishing a frozen stage byte-identical."
        ),
    )
    parser.add_argument("--max", type=int, default=500, help="cap on listings walked")

    parser.add_argument("--interval", type=float, default=5.0, help="seconds between hits on one host")
    parser.add_argument(
        "--transport",
        choices=["stdlib", "playwright"],
        default="stdlib",
        help="playwright is needed for NPC's JS-driven filters and pagination",
    )
    parser.add_argument("--fixture", action="store_true", help="run offline against bundled HTML")
    parser.add_argument(
        "--ingest-file",
        metavar="PATH",
        help=(
            "ingest already-parsed DiscoveredListing records from JSON. Used by the "
            "staged rollout so a long crawl can be resumed without re-fetching, and so "
            "the database is written by this same code path."
        ),
    )
    parser.add_argument(
        "--ingest-max-seconds",
        type=float,
        default=900.0,
        help=(
            "wall-clock budget for one ingest; on expiry the transaction is rolled "
            "back and the run reports how far it got (default 900)"
        ),
    )
    parser.add_argument("--dump-html", metavar="URL", help="save a page so selectors can be verified")
    parser.add_argument(
        "--discover",
        choices=["exa"],
        help="also ask a search API for operators our sitemap walk cannot see",
    )
    parser.add_argument(
        "--discover-domain",
        action="append",
        default=[],
        help="domain to include in Exa discovery; repeatable",
    )
    parser.add_argument(
        "--ingest",
        choices=["db"],
        help="also write normalized discovery records to PostgreSQL; never creates bookable units",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="validate database-ingest records and write the ingest report without database writes",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="limit records sent to the database ingest stage (does not limit crawling; use --max for that)",
    )
    parser.add_argument(
        "--ingest-report",
        default="ingest-report.json",
        help="JSON report path for database ingest counts and rejected records",
    )
    args = parser.parse_args(argv)

    if args.dry_run and args.ingest != "db":
        parser.error("--dry-run requires --ingest db")

    # One guard for the whole run, so --dump-html and a real crawl are subject
    # to exactly the same robots and throttle rules.
    def guarded(transport_name: str) -> GuardedProvider:
        return GuardedProvider(
            build_provider(transport_name, fixtures_dir=FIXTURES),
            RobotsCache(),
            HostThrottle(interval_seconds=args.interval),
            min_interval_seconds=args.interval,
        )

    if args.dump_html:
        transport_name = "fixture" if args.fixture else args.transport
        body = guarded(transport_name).fetch(args.dump_html)
        Path("dumped.html").write_text(body, encoding="utf-8")
        print(f"wrote dumped.html ({len(body)} bytes) - verify the regexes in extraction/ against it")
        return 0

    registry = build_registry()
    adapter = registry.get(args.source)

    # Publish-only mode: re-project records a previous stage already parsed, with
    # no crawl and no network. Placed before the permission gate because it fetches
    # nothing, so requiring a crawl review to re-run a projection would be asking
    # for the wrong permission.
    if args.publish_from:
        return _run_publish_from(args)

    # Ingest-only mode: records already parsed by a previous stage. This exists so a
    # long staged crawl can be ingested, re-ingested and inspected without fetching
    # anything again - and so the database is written by this same code path rather
    # than by a second, parallel implementation that could drift from it.
    if args.ingest_file:
        return _run_ingest_file(args, adapter)


    # The permission gate. A source must have a recorded review before an adapter
    # runs against it, so the crawl decision is a reviewable record rather than a
    # list of domains someone pasted into a constant.
    #
    # Skipped in fixture mode, which reads bundled files and touches no network:
    # requiring a legal review to read a local fixture would train everyone to keep
    # the registry permissive, which is the opposite of the point.
    if not args.fixture:
        from compliance.source_registry import SourceNotPermitted, load_registry

        source_file = load_registry()
        try:
            source_file.require_permitted(args.source)
        except SourceNotPermitted as exc:
            entry = source_file.get(args.source)
            print(f"refusing to crawl '{args.source}': {exc}", file=sys.stderr)
            if entry is not None:
                print(f"  host   : {entry.host}", file=sys.stderr)
                print(f"  layer  : {entry.layer}", file=sys.stderr)
                print(f"  robots : {entry.robots_fetch} - {entry.robots_notes}", file=sys.stderr)
                print(f"  terms  : {entry.terms_url}", file=sys.stderr)
            print(
                "  a crawl is not permitted until SourceRegistry.termsStatus is PERMITTED "
                "with a reviewer and a date",
                file=sys.stderr,
            )
            return 3

    if args.fixture:
        transport = FixtureTransport(FIXTURES)
    else:
        transport = build_provider(args.transport, fixtures_dir=FIXTURES)

    print(
        f"acquisition: source={adapter.name} layer={adapter.layer} "
        f"state={args.state} transport={transport.name}",
        file=sys.stderr,
    )

    if args.discover == "exa":
        _run_exa_discovery(args, adapter)

    states = (
        [args.state.strip().upper()]
        if args.state
        else [code.strip().upper() for code in args.states.split(",") if code.strip()]
    )
    if not states:
        print("no states to crawl", file=sys.stderr)
        return 2

    # One guard for the whole run: same host across every state, so the throttle
    # and the robots cache have to outlive the individual state loop.
    guard = (
        offline_guard(transport)
        if args.fixture
        else GuardedProvider(
            transport,
            RobotsCache(),
            HostThrottle(interval_seconds=args.interval),
            min_interval_seconds=args.interval,
        )
    )

    listings: list[DiscoveredListing] = []
    per_state: list[tuple[str, dict]] = []
    for code in states:
        result = crawl(
            adapter,
            transport,
            code,
            args.area,
            args.max,
            args.interval,
            enforce_policy=not args.fixture,
            guard=guard,
        )
        per_state.append((code, result["stats"]))
        listings.extend(result["listings"])
        print(
            f"  {code}: {result['stats']['usable']:,} usable "
            f"({result['stats']['skipped_robots']:,} skipped, {result['stats']['failed']:,} failed)",
            file=sys.stderr,
        )

    # The funnel runs over every state at once: consolidation across a state
    # boundary is still consolidation, and an operator active in Lagos and Abuja
    # is one relationship, not two.
    report = funnel(listings)
    stats = _combined_stats(per_state, listings)

    ingest_report = None
    connection = None
    uses_database_ledger = False
    if args.ingest == "db":
        from ingest.postgres import PostgresIngestor, dsn_for_psycopg, write_report

        if not args.dry_run:
            database_url = os.environ.get("DATABASE_URL")
            if not database_url:
                parser.error("--ingest db requires DATABASE_URL (or use --dry-run)")
            try:
                import psycopg  # type: ignore[import-not-found]
            except ImportError as exc:
                parser.error("--ingest db requires psycopg; install it in the acquisition environment")
                raise AssertionError from exc
            # Prisma's URL is not a libpq URL (`?schema=public` is Prisma-only),
            # and the two stages share one environment variable.
            connection = psycopg.connect(dsn_for_psycopg(database_url))
            uses_database_ledger = True

    observed_on = date.today().isoformat()
    observations = to_observations(listings, observed_on)

    # The database is the ledger whenever one is reachable, so that concurrent
    # crawlers in different states share one history instead of each keeping a
    # private file and reporting the same listings as new every time. The JSONL
    # ledger remains for runs with no database at all.
    if uses_database_ledger:
        from ingest.ledger import PostgresLedger

        known = PostgresLedger(connection).load()
        ledger_label = "database (SourceObservation + PriceObservation)"
    else:
        known = load_ledger(Path(args.ledger))
        ledger_label = str(args.ledger)

    # Change detection runs before the lead file is written, because "this
    # operator just moved their rate" changes what the call should say.
    changes = detect_changes(known, observations, today=observed_on)

    if args.ingest == "db":
        try:
            ingest_report = PostgresIngestor(connection).ingest(
                listings,
                observed_at=observed_on,
                dry_run=args.dry_run,
                limit=args.limit,
            )
            write_report(ingest_report, args.ingest_report)
        finally:
            if connection is not None:
                connection.close()

    out_path = Path(args.out)
    with out_path.open("w", encoding="utf-8") as sink:
        for operator in report["operators"]:
            sink.write(json.dumps(operator.to_lead(), ensure_ascii=False) + "\n")

    # The ingest above already appended the observations when the database is the
    # ledger. Writing the file as well would create two histories that drift, so
    # exactly one of them is written.
    if not uses_database_ledger:
        append_ledger(Path(args.ledger), observations)

    published = None
    if args.publish and args.publish != "-":
        published = publish_directory(
            Path(args.publish), listings, observed_on, attribution=args.attribution
        )

    print()
    print(f"  states crawled: {', '.join(code for code, _ in per_state)}")
    print(f"  {stats['discovered']:>7,} listings discovered")
    print(f"  {stats['usable']:>7,} usable records")
    print(f"  {report['unique_properties']:>7,} unique properties")
    print(f"  {report['unique_operators']:>7,} unique operators")
    print(f"  {report['multi_property_operators']:>7,} multi-property operators")
    print(f"  {report['operators_with_booking_infrastructure']:>7,} with detectable booking/PMS infrastructure")
    print()
    print(f"  since last run, across {len(known):,} listings already known:")
    print(f"    {len(changes.new_listings):>5,} newly listed")
    print(f"    {len(changes.price_changes):>5,} changed price")
    print(f"    {len(changes.delisted):>5,} gone (absent beyond the grace period)")
    print(f"    {len(changes.unchanged):>5,} unchanged")
    print()
    print(f"  skipped by robots: {stats['skipped_robots']}, failed: {stats['failed']}")
    if uses_database_ledger:
        print(f"  wrote {out_path}; observation ledger is {ledger_label}")
    else:
        print(f"  wrote {out_path} and appended {len(observations):,} observations to {args.ledger}")
    if ingest_report is not None:
        mode = "dry-run" if ingest_report.dry_run else "database"
        print(
            f"  {mode} ingest: {ingest_report.written:,} written, "
            f"{ingest_report.rejected_count:,} rejected; report={args.ingest_report}"
        )
    if published:
        print(
            f"  published {published['counts']['places']:,} places "
            f"({published['counts']['contactable']:,} contactable) to {args.publish}"
        )

    close = getattr(transport, "close", None)
    if callable(close):  # pragma: no cover - depends on env
        close()

    return 0


def _combined_stats(per_state: list[tuple[str, dict]], listings: list) -> dict:
    """
    Totals across every state in the run.

    Summed from the per-state counters rather than recomputed, so the summary
    cannot disagree with what each state actually did. An earlier version
    hardcoded the skip and failure counts to zero, which reported a clean run
    regardless of what had happened.
    """
    return {
        "discovered": sum(stats["discovered"] for _, stats in per_state),
        "usable": len(listings),
        "states": len(per_state),
        "skipped_robots": sum(stats["skipped_robots"] for _, stats in per_state),
        "failed": sum(stats["failed"] for _, stats in per_state),
        "parse_failed": sum(stats["parse_failed"] for _, stats in per_state),
    }


def publish_directory(path: Path, listings: list, observed_on: str, *, attribution: str) -> dict:
    """
    Write the public place rows.

    Separate file from the lead list on purpose. A lead has a score, an outreach
    status and a retention clock; a published row has a rate, a location and an
    attribution. Mixing them would mean the site could serve a field that only
    exists for sales.
    """
    directory = build_directory(listings, observed_on, attribution=attribution)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(directory, ensure_ascii=False, indent=2), encoding="utf-8")
    return directory


def load_listing_records(path: Path) -> tuple[list[DiscoveredListing], int, int]:
    """
    Read `DiscoveredListing` records from a JSON array, a JSONL file, or a
    published directory document.

    Returns (listings, unusable, total). Extracted from `_run_ingest_file` so the
    publish path and the ingest path cannot drift: both must reconstruct records
    the same way, including the `to_record()` allowlist check that a re-load
    would otherwise bypass.

    Three accepted shapes, and the third is why this is not a two-line function:

      1. A JSON array - a hand-assembled or already-de-duplicated record set.
      2. JSONL - the format the crawl stages write, because a stage that dies
         mid-run still leaves every completed record behind.
      3. A published directory document (`{"places": [...]}`). This is what
         `--publish` writes, and it is the natural thing to re-publish: a
         directory that needs a projection change can be re-derived from its own
         output without touching the crawl. Accepting it here keeps that a
         one-command operation rather than a reason to write a second parser.
    """
    raw: list[dict] = []
    text = path.read_text(encoding="utf-8").strip()

    if text.startswith("["):
        raw = json.loads(text)
    elif text.startswith("{"):
        # Either a published directory document or a single record. Told apart by
        # whether it has a `places` key, not by guessing from the filename.
        document = json.loads(text)
        if isinstance(document.get("places"), list):
            raw = document["places"]
        else:
            raw = [document]
    else:
        # JSONL: one record per line.
        for line, entry in enumerate(text.splitlines(), 1):
            entry = entry.strip()
            if not entry:
                continue
            try:
                raw.append(json.loads(entry))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path.name}: malformed JSON on line {line}: {exc}") from exc

    fields = set(DiscoveredListing.__dataclass_fields__)
    listings: list[DiscoveredListing] = []
    unusable = 0
    for item in raw:
        # A published row names the source and the listing in its `id`
        # (`npc:3690360`) but carries no `source` or `source_listing_id` field, so
        # both are recovered here. Without them every re-published row would read
        # as identity-less and be dropped.
        if isinstance(item.get("id"), str) and ":" in item["id"]:
            prefix, listing_id = item["id"].split(":", 1)
            item = {
                **item,
                "source": item.get("source", prefix),
                "source_listing_id": item.get("source_listing_id", listing_id)
            }

        known = {key: value for key, value in item.items() if key in fields}
        # Records with no identity cannot be used: (source, sourceListingId) is the
        # uniqueness key, so a missing id would collide with every other record that
        # is also missing one.
        if not known.get("source_listing_id") or not known.get("source_url"):
            unusable += 1
            continue
        # `media` arrives as a JSON list and is stored as a tuple, so this is the
        # one field that needs coercing. A record written before media existed
        # simply has no key and falls back to the dataclass default of ().
        if isinstance(known.get("media"), list):
            known["media"] = tuple(known["media"])

        # A published row deliberately carries no `property_name` - it is the
        # operator's marketing copy and stays internal (see `publishing.py`). The
        # dataclass requires one, so a factual description is rebuilt from the
        # fields the row does publish. It is never published again, so this is not
        # a back door for the title: round-tripping a directory produces the same
        # directory.
        if not known.get("property_name"):
            known["property_name"] = describe_factually(known)

        listings.append(DiscoveredListing(**known))

    return listings, unusable, len(raw)


def describe_factually(fields: dict) -> str:
    """
    A factual descriptor for a row that has no stored title.

    "3-bedroom shortlet, Ikeja" - the same construction the UI uses
    (`placeDescriptor` in src/domain/directory.ts), because a row reloaded from
    disk should look like the row that produced it rather than like a record that
    lost its name.
    """
    parts: list[str] = []
    bedrooms = fields.get("bedrooms")
    if isinstance(bedrooms, int) and bedrooms > 0:
        parts.append(f"{bedrooms}-bedroom")
    property_type = fields.get("property_type")
    if isinstance(property_type, str) and property_type:
        parts.append(property_type.lower().replace("_", " "))
    descriptor = " ".join(parts) if parts else "Shortlet"
    area = fields.get("area") or fields.get("city")
    return f"{descriptor}, {area}" if isinstance(area, str) and area else descriptor


def _run_publish_from(args) -> int:
    """
    Publish a directory from an existing records file, with no crawl.

    WHY THIS EXISTS
    ---------------
    The published projection changes more often than the crawl does. Adding
    photographs to it, for instance, does not make the 583 pages already fetched
    stale - but without this flag the only way to get the new projection was to
    re-fetch all 583 of them at one request every five seconds.

    It also makes the publish step reproducible: the same records file produces
    the same directory.json, so a diff on that file is a diff on the projection
    rather than on whatever the network happened to return that day.

    `--dry-run` reports the funnel without writing anything.
    """
    from datetime import date

    path = Path(args.publish_from)
    if not path.exists():
        print(f"--publish-from: {path} does not exist", file=sys.stderr)
        return 2

    listings, unusable, total = load_listing_records(path)
    print(
        f"publish-from: {total} records, {len(listings)} usable, "
        f"{unusable} without an identity",
        file=sys.stderr,
    )

    if not listings:
        print("publish-from: nothing to publish", file=sys.stderr)
        return 2

    observed_on = args.observed_on or date.today().isoformat()

    if args.dry_run:
        report = funnel(listings)
        print(json.dumps(report, indent=2), file=sys.stderr)
        print("dry-run: no files written", file=sys.stderr)
        return 0

    if not args.publish or args.publish == "-":
        print("publish-from needs a --publish path to write to", file=sys.stderr)
        return 2

    # BYTE-LEVEL PHOTOGRAPH VERIFICATION
    #
    # The URL filter refuses every image from a publisher that names itself in the
    # URL, which is correct for NPC and useless for a portal that watermarks over
    # `/img/8821.jpg`. It also refuses clean images from a source that cannot prove
    # they are clean. This pass fetches the candidates and looks at them, which is
    # the only way a photograph gets onto a card from a source we have not cleared
    # by URL.
    #
    # Opt-in, because it makes real HTTP requests per image and a re-publish is
    # often run offline. `--verify-photos` says to do it.
    if getattr(args, "verify_photos", False):
        listings, kept_photos, refused_photos = _verify_listing_photos(listings, args)
        print(
            f"photo verification: {kept_photos:,} kept, {refused_photos:,} refused",
            file=sys.stderr,
        )

    published = publish_directory(
        Path(args.publish), listings, observed_on, attribution=args.attribution
    )

    with_media = sum(1 for entry in published["places"] if entry.get("cover_image_url"))
    print(
        f"published {published['counts']['places']:,} places "
        f"({published['counts']['contactable']:,} contactable, "
        f"{with_media:,} with photographs) to {args.publish}",
        file=sys.stderr,
    )
    return 0


def _verify_listing_photos(listings: list, args) -> tuple[list, int, int]:
    """
    Fetch each listing's candidate photographs and keep only the clean ones.

    Reports per-listing when every candidate was refused, because "this listing
    has no photographs" and "this listing's photographs were all watermarked" are
    different facts and a run should not collapse them.
    """
    from publishing import publishable_media, verify_media
    from urllib.request import Request, urlopen

    user_agent = getattr(args, "user_agent", None) or "House3Bot/1.0 (+https://house3.ng/bot)"

    def fetch(url: str):
        """Bytes, or None. Never raises - a failure is a refusal, not a crash."""
        try:
            request = Request(url, headers={"User-Agent": user_agent})
            with urlopen(request, timeout=20) as response:  # noqa: S310 - allowlisted by caller
                if response.status != 200:
                    return None
                # Cap the read: a malicious or mistaken URL should not be able to
                # pull an unbounded stream into memory during a publish.
                return response.read(8 * 1024 * 1024)
        except Exception:
            return None

    kept_count = 0
    refused_count = 0
    result: list = []

    for listing in listings:
        # The URL filter runs first because it is free, then the pixels decide.
        candidates = publishable_media(listing.media)
        if not candidates:
            # Nothing survived the URL filter. This is the NPC case and it is
            # final: re-checking pixels we already refused on the URL would be
            # re-litigating a decision that did not depend on them.
            result.append(listing)
            continue

        kept, rejections = verify_media(candidates, fetch=fetch)
        kept_count += len(kept)
        refused_count += len(rejections)

        if not kept and candidates:
            print(
                f"  {listing.source}:{listing.source_listing_id} - all "
                f"{len(candidates)} candidate photograph(s) refused: "
                f"{rejections[0]['reason'] if rejections else 'unknown'}",
                file=sys.stderr,
            )

        result.append(
            replace(
                listing,
                media=tuple(kept),
                cover_image_url=kept[0] if kept else None,
            )
        )

    return result, kept_count, refused_count


def _run_ingest_file(args, adapter) -> int:
    """
    Ingest DiscoveredListing records from a JSON file written by a crawl stage.

    The records are reconstructed into the same `DiscoveredListing` the adapter
    produced, so the ingestor sees exactly what a live crawl would have given it -
    including the allowlist check, which runs in `to_record()` and therefore also
    guards anything loaded from disk.
    """
    from datetime import date

    from ingest.postgres import IngestAborted, PostgresIngestor, dsn_for_psycopg, write_report

    path = Path(args.ingest_file)
    if not path.exists():
        parser_error = f"--ingest-file: {path} does not exist"
        print(parser_error, file=sys.stderr)
        return 2

    # Shared with `--publish-from`, so the two paths cannot reconstruct records
    # differently - including the `to_record()` allowlist check.
    listings, unusable, total = load_listing_records(path)

    print(
        f"ingest-file: {total} records, {len(listings)} ingestable, "
        f"{unusable} without an identity",
        file=sys.stderr,
    )

    database_url = os.environ.get("DATABASE_URL")
    if not database_url and not args.dry_run:
        print("--ingest-file requires DATABASE_URL (or use --dry-run)", file=sys.stderr)
        return 2

    connection = None
    if not args.dry_run:
        try:
            import psycopg  # type: ignore[import-not-found]
        except ImportError:
            print("--ingest-file requires psycopg", file=sys.stderr)
            return 2
        # A connect timeout so an unreachable host fails fast, and a statement timeout
        # so no single statement can outlive the run. Neither replaces progress
        # reporting: they bound failure, they do not make progress visible.
        connection = psycopg.connect(
            dsn_for_psycopg(database_url),
            connect_timeout=20,
        )
        with connection.cursor() as setup:
            setup.execute("SET statement_timeout = '300000'")

    started = time.monotonic()

    def progress(done: int, total: int) -> None:
        elapsed = time.monotonic() - started
        rate = done / elapsed if elapsed else 0
        remaining = (total - done) / rate if rate else 0
        print(
            f"ingest {done}/{total}  elapsed={elapsed:.0f}s  "
            f"eta={remaining:.0f}s",
            file=sys.stderr,
            flush=True,
        )

    aborted = False
    try:
        ingestor = PostgresIngestor(
            connection,
            parser_version=f"rollout-{adapter.name}",
        )
        report = ingestor.ingest(
            listings,
            observed_at=date.today(),
            dry_run=args.dry_run,
            progress=None if args.dry_run else progress,
            progress_every=max(1, min(100, max(1, len(listings) // 20))),
            max_seconds=None if args.dry_run else args.ingest_max_seconds,
        )
    except IngestAborted as exc:
        print(f"ingest ABORTED: {exc}", file=sys.stderr)
        report = None
        aborted = True
    finally:
        if connection is not None:
            connection.close()

    if aborted:
        return 4

    print(
        f"database ingest: {report.written} written, {report.rejected_count} rejected, "
        f"elapsed={report.elapsed_seconds:.0f}s",
        file=sys.stderr,
    )

    if args.ingest_report:
        write_report(report, args.ingest_report)
        print(f"report={args.ingest_report}", file=sys.stderr)
    for rejected in report.rejected[:10]:
        print(f"  rejected: {rejected.to_dict()}", file=sys.stderr)
    return 0


def _run_exa_discovery(args, adapter) -> None:
    """
    Print operators the sitemap walk structurally cannot reach.

    Kept separate from the crawl on purpose: discovery results are candidates,
    not listings. Nothing found here reaches the lead file until the operator's
    own page has been fetched and parsed like any other.
    """
    domains = args.discover_domain or [adapter.host.replace("www.", "")]
    discovery = build_discovery("exa")
    schema = exa_summary_schema()

    # Domain-scoped and area-specific, because a generic query returns the
    # portals we already crawl plus aggregator spam we do not want.
    query = (
        f"shortlet apartment for rent in {args.area or args.state}, Nigeria, "
        "listed directly by the operator or the agency that manages it"
    )
    try:
        candidates = discovery.discover(query, domains, schema)
    except ProviderError as exc:
        print(f"  discovery skipped: {exc}", file=sys.stderr)
        return

    print(f"  exa discovery: {len(candidates)} candidate pages", file=sys.stderr)
    for candidate in candidates:
        fields = candidate.get("fields") or {}
        published = candidate.get("published_at") or "undated"
        print(
            f"    {published:>12}  {fields.get('operator_name') or '?':<28} "
            f"{candidate['source_url']}",
            file=sys.stderr,
        )


if __name__ == "__main__":
    raise SystemExit(main())
