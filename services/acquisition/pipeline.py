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
from dataclasses import asdict
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
    parser.add_argument("--max", type=int, default=500, help="cap on listings walked")
    parser.add_argument("--interval", type=float, default=5.0, help="seconds between hits on one host")
    parser.add_argument(
        "--transport",
        choices=["stdlib", "playwright"],
        default="stdlib",
        help="playwright is needed for NPC's JS-driven filters and pagination",
    )
    parser.add_argument("--fixture", action="store_true", help="run offline against bundled HTML")
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
