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
) -> dict:
    """
    Run one adapter over one state and return the funnel.

    Every fetch passes the robots check and the throttle. A misconfigured adapter
    pointed at a host it does not own is refused rather than silently obeyed.

    `enforce_policy=False` is fixture mode only: it swaps in a robots stub and
    drops the throttle, because the fixture provider reads files and touches no
    network. It is a named parameter rather than a consequence of the transport
    type so that a real run cannot end up here by accident.
    """
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
    parser.add_argument("--state", default="LA", help="state code: LA, FC, OY, IM, AK")
    parser.add_argument("--area", help="restrict to one neighbourhood, e.g. lekki")
    parser.add_argument("--out", default="leads.jsonl", help="prospect output path")
    parser.add_argument(
        "--ledger",
        default="listing-observations.jsonl",
        help="append-only observation log; this is what makes change detection possible",
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
    args = parser.parse_args(argv)

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

    result = crawl(
        adapter,
        transport,
        args.state,
        args.area,
        args.max,
        args.interval,
        enforce_policy=not args.fixture,
    )
    report = funnel(result["listings"])

    # Change detection runs before the lead file is written, because "this
    # operator just moved their rate" changes what the call should say.
    known = load_ledger(Path(args.ledger))
    observed_on = date.today().isoformat()
    observations = to_observations(result["listings"], observed_on)
    changes = detect_changes(known, observations, today=observed_on)

    out_path = Path(args.out)
    with out_path.open("w", encoding="utf-8") as sink:
        for operator in report["operators"]:
            sink.write(json.dumps(operator.to_lead(), ensure_ascii=False) + "\n")

    append_ledger(Path(args.ledger), observations)

    print()
    print(f"  {result['stats']['discovered']:>7,} listings discovered")
    print(f"  {result['stats']['usable']:>7,} usable records")
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
    print(f"  skipped by robots: {result['stats']['skipped_robots']}, failed: {result['stats']['failed']}")
    print(f"  wrote {out_path} and appended {len(observations):,} observations to {args.ledger}")

    close = getattr(transport, "close", None)
    if callable(close):  # pragma: no cover - depends on env
        close()

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
