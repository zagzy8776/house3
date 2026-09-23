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
from pathlib import Path
from typing import Optional

from urllib.parse import urlparse

from compliance.rate_limit import HostThrottle
from compliance.robots import USER_AGENT, RobotsCache
from normalization.dedupe import OperatorProfile, consolidate
from sources.base import AdapterRegistry, DiscoveredListing
from sources.npc import NpcAdapter

FIXTURES = Path(__file__).parent / "fixtures"


class Transport:
    """Fetch a URL and return its text. One method, so it is trivially stubbable."""

    def fetch(self, url: str) -> str:  # pragma: no cover - interface
        raise NotImplementedError


class StdlibTransport(Transport):
    """Default transport. No third-party dependencies."""

    def __init__(self, timeout_seconds: float = 20.0) -> None:
        self.timeout_seconds = timeout_seconds

    def fetch(self, url: str) -> str:
        from urllib.request import Request, urlopen

        request = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en-NG,en"})
        with urlopen(request, timeout=self.timeout_seconds) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")


class PlaywrightTransport(Transport):
    """
    For JavaScript-rendered pages. NPC is Livewire/Alpine, so filtering and
    pagination need a real browser - exactly what the spec asked for.

    Lazy import so the service still runs in CI and fixture mode with nothing
    installed. It sits behind the same robots cache and throttle as everything
    else: a real browser is not an exemption from policy.
    """

    def __init__(self, timeout_ms: int = 30_000) -> None:
        try:
            from playwright.sync_api import sync_playwright  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on env
            raise RuntimeError(
                "PlaywrightTransport needs `pip install playwright` and "
                "`playwright install chromium`."
            ) from exc

        self._playwright = sync_playwright().start()
        self._browser = self._playwright.chromium.launch(headless=True)
        self.timeout_ms = timeout_ms

    def fetch(self, url: str) -> str:
        page = self._browser.new_page(user_agent=USER_AGENT)
        try:
            page.goto(url, timeout=self.timeout_ms, wait_until="domcontentloaded")
            return page.content()
        finally:
            page.close()

    def close(self) -> None:  # pragma: no cover - depends on env
        self._browser.close()
        self._playwright.stop()


class FixtureTransport(Transport):
    """Serves bundled HTML, so the pipeline runs and is testable offline."""

    def __init__(self, fixtures_dir: Path = FIXTURES, sequence: bool = True) -> None:
        self.fixtures_dir = fixtures_dir
        self.sequence = sequence
        self._cursor = 0

    def fetch(self, url: str) -> str:
        if self.sequence:
            # Fixture mode walks a small set of pages representing one operator's
            # units, so a run demonstrates real consolidation instead of
            # returning the same page repeatedly.
            names = sorted(p.name for p in self.fixtures_dir.glob("npc-listing-*.html"))
            if not names:
                raise FileNotFoundError("no npc-listing-*.html fixtures")
            name = names[self._cursor % len(names)]
            self._cursor += 1
            return (self.fixtures_dir / name).read_text(encoding="utf-8")

        name = url.rsplit("/", 1)[-1] or "npc-listing-1.html"
        path = self.fixtures_dir / name
        if not path.exists():
            raise FileNotFoundError(f"no fixture named {name}")
        return path.read_text(encoding="utf-8")


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
) -> dict:
    """
    Run one adapter over one state and return the funnel.

    Every fetch passes the robots check and the throttle. A misconfigured adapter
    pointed at a host it does not own is refused rather than silently obeyed.
    """
    robots = RobotsCache()
    throttle = HostThrottle(interval_seconds=interval_seconds)

    listings: list[DiscoveredListing] = []
    stats = {
        "discovered": 0,
        "fetched": 0,
        "usable": 0,
        "skipped_robots": 0,
        "failed": 0,
        "parse_failed": 0,
    }

    for url in adapter.discover(transport, state_code, area):
        if stats["discovered"] >= max_listings:
            break
        stats["discovered"] += 1

        host_ok = urlparse(url).netloc.endswith(adapter.host.replace("www.", ""))
        if not host_ok or not robots.allowed(url):
            stats["skipped_robots"] += 1
            continue

        delay = robots.crawl_delay(url)
        throttle.wait(url, override_interval=delay)

        try:
            html = transport.fetch(url)
            stats["fetched"] += 1
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
    return {"stats": stats, "listings": listings}


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
    args = parser.parse_args(argv)

    if args.dump_html:
        body = (FixtureTransport() if args.fixture else StdlibTransport()).fetch(args.dump_html)
        Path("dumped.html").write_text(body, encoding="utf-8")
        print(f"wrote dumped.html ({len(body)} bytes) - verify the regexes in extraction/ against it")
        return 0

    registry = build_registry()
    adapter = registry.get(args.source)

    if args.fixture:
        transport: Transport = FixtureTransport()
    else:
        transport = PlaywrightTransport() if args.transport == "playwright" else StdlibTransport()

    print(
        f"acquisition: source={adapter.name} layer={adapter.layer} "
        f"state={args.state} transport={type(transport).__name__}",
        file=sys.stderr,
    )

    result = crawl(adapter, transport, args.state, args.area, args.max, args.interval)
    report = funnel(result["listings"])

    out_path = Path(args.out)
    with out_path.open("w", encoding="utf-8") as sink:
        for operator in report["operators"]:
            sink.write(json.dumps(operator.to_lead(), ensure_ascii=False) + "\n")

    print()
    print(f"  {result['stats']['discovered']:>7,} listings discovered")
    print(f"  {result['stats']['usable']:>7,} usable records")
    print(f"  {report['unique_properties']:>7,} unique properties")
    print(f"  {report['unique_operators']:>7,} unique operators")
    print(f"  {report['multi_property_operators']:>7,} multi-property operators")
    print(f"  {report['operators_with_booking_infrastructure']:>7,} with detectable booking/PMS infrastructure")
    print()
    print(f"  skipped by robots: {result['stats']['skipped_robots']}, failed: {result['stats']['failed']}")
    print(f"  wrote {out_path}")

    if isinstance(transport, PlaywrightTransport):  # pragma: no cover - depends on env
        transport.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
