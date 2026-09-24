"""
Live connectivity probe for every registered source adapter.

WHAT THIS ANSWERS
-----------------
"Are the sites connected well?" is two questions, and they have to be asked
separately:

  1. Does the HOST answer, and does `discover()` find listing URLs on it? A
     DNS failure or a dead sitemap means nothing downstream matters.
  2. Does `parse()` turn those pages into usable listings? A host that answers
     200 with a homepage is still a useless source if discovery yields nothing or
     every page comes back unparsed. THIS is the failure that looks fine in a
     test suite, because the tests use saved HTML - the fixtures parse perfectly
     and the live pages may not.

Both are checked per adapter, against the live internet, and the output is a
table a human reads.

WHY THIS IS A SCRIPT AND NOT A PYTEST MODULE
--------------------------------------------
It makes real HTTP requests to third-party sites. A unit suite that hits the
network fails for reasons unrelated to the code - a site is slow, a laptop is
offline, an IP is rate-limited - and a suite that goes red for those reasons gets
ignored, which is worse than not having one. The pure logic is tested offline in
`test_acquisition.py`. This is for a deliberate run:

    python check_sources.py                    # every adapter, Lagos
    python check_sources.py --source jiji      # one
    python check_sources.py --state FC --limit 5 --browser

READ-ONLY, STRICTLY
-------------------
It fetches and parses, and writes NOTHING. No crawl, no `--publish`, no
directory rewrite. That restriction is deliberate and worth keeping: the last
accident in this repo was a run that wrote the published directory from a test
path and took the site's inventory from 260 places to 3.
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass, field
from typing import Iterator, Optional

from pipeline import build_registry
from sources.base import SourceAdapter


@dataclass
class ProbeResult:
    """What happened when one adapter was pointed at one state."""

    source: str
    host: str
    #: Did `discover()` yield any candidate listing URLs?
    discovered: int = 0
    #: How many fetched pages did we actually get HTML for?
    fetched: int = 0
    #: Of those, how many parsed into a listing?
    parsed: int = 0
    #: How many came back with the fields a card needs to be actionable.
    usable: int = 0
    error: Optional[str] = None
    seconds: float = 0.0
    #: A sample of what it found, for a human to eyeball.
    samples: list[str] = field(default_factory=list)

    @property
    def verdict(self) -> str:
        """
        One word for the table. Ordered from most to least fundamental, because a
        later stage cannot be trusted if an earlier one failed.
        """
        if self.error:
            return "ERROR"
        if self.discovered == 0:
            return "NO LISTINGS FOUND"
        if self.fetched == 0:
            return "PAGES WOULD NOT LOAD"
        if self.parsed == 0:
            return "DISCOVERY WENT NOWHERE"
        if self.usable == 0:
            return "PARSED, NOT ACTIONABLE"
        return "OK"


def probe(adapter: SourceAdapter, state_code: str, *, transport, limit: int, delay: float) -> ProbeResult:
    """
    Fetch a few real pages from one adapter and report what came back.

    Sequential and delayed on purpose: this runs against live sites that have done
    nothing to us, and hammering five domains in parallel to satisfy a
    connectivity check would be a poor way to treat them.
    """
    result = ProbeResult(source=adapter.name, host=getattr(adapter, "host", "?"))
    started = time.time()

    try:
        candidates = list(_take(adapter.discover(transport, state_code), limit * 4))
    except Exception as error:  # noqa: BLE001 - reporting the failure is the job
        result.error = f"discover() raised {type(error).__name__}: {error}"
        result.seconds = time.time() - started
        return result

    result.discovered = len(candidates)
    if not candidates:
        result.seconds = time.time() - started
        return result

    for url in _take(iter(candidates), limit):
        try:
            html = transport.fetch(url)
        except Exception as error:  # noqa: BLE001
            # One page failing is normal - a listing withdrawn mid-crawl - so it is
            # recorded on the count rather than aborting the probe.
            print(f"      fetch failed: {url[:90]} ({type(error).__name__})", flush=True)
            continue

        result.fetched += 1
        time.sleep(delay)

        try:
            listing = adapter.parse(html, url)
        except Exception as error:  # noqa: BLE001
            result.error = f"parse() raised {type(error).__name__}: {error}"
            break

        if listing is None:
            continue

        result.parsed += 1

        # "Connected well" means a guest can act on the row: the operator
        # published a rate AND a way to reach them. A parsed listing with neither
        # is a lead, not inventory, and the distinction is the whole reason this
        # probe exists rather than a simple 200 check.
        has_rate = bool(listing.advertised_price)
        has_contact = bool(listing.phone or listing.website or listing.email)
        if has_rate and has_contact:
            result.usable += 1
            if len(result.samples) < 3:
                price = (listing.advertised_price or 0) // 100
                result.samples.append(
                    f"{listing.source_listing_id}: {listing.bedrooms or '?'}bd "
                    f"{listing.area or '?'} NGN {price:,}"
                )

    result.seconds = time.time() - started
    return result


def _take(iterator: Iterator, count: int) -> Iterator:
    """The first `count` items, without pulling more than that from the source."""
    for index, item in enumerate(iterator):
        if index >= count:
            return
        yield item


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe every source adapter against the live sites.")
    parser.add_argument("--state", default="LA", help="state code to probe (default LA)")
    parser.add_argument("--source", help="probe only this adapter")
    parser.add_argument("--limit", type=int, default=3, help="pages to fetch per adapter")
    parser.add_argument("--delay", type=float, default=1.5, help="seconds between fetches")
    parser.add_argument(
        "--transport",
        default="stdlib",
        help="stdlib (free, no JavaScript) or playwright (renders JS, slower)",
    )
    args = parser.parse_args()

    from sources.providers import build_provider

    registry = build_registry()
    names = [args.source] if args.source else registry.names()

    try:
        transport = build_provider(args.transport)
    except Exception as error:  # noqa: BLE001
        print(f"could not build transport '{args.transport}': {error}", file=sys.stderr)
        return 2

    print(f"transport: {getattr(transport, 'name', args.transport)}")
    print(f"probing {len(names)} source(s) for state {args.state}, {args.limit} page(s) each\n")

    results: list[ProbeResult] = []
    for name in names:
        try:
            adapter = registry.get(name)
        except KeyError as error:
            print(f"  {name}: {error}")
            continue

        print(f"  {name} ({getattr(adapter, 'host', '?')}) ...", flush=True)
        results.append(probe(adapter, args.state, transport=transport, limit=args.limit, delay=args.delay))

    close = getattr(transport, "close", None)
    if callable(close):
        close()

    print("\n" + "=" * 80)
    print(f"{'source':<18}{'verdict':<24}{'found':>6}{'loaded':>7}{'parsed':>7}{'usable':>7}{'sec':>7}")
    print("-" * 80)
    for result in results:
        print(
            f"{result.source:<18}{result.verdict:<24}{result.discovered:>6}"
            f"{result.fetched:>7}{result.parsed:>7}{result.usable:>7}{result.seconds:>7.1f}"
        )
        if result.error:
            print(f"    error: {result.error[:160]}")
        for sample in result.samples:
            print(f"    ok: {sample}")

    working = [result for result in results if result.verdict == "OK"]
    print("-" * 80)
    print(f"{len(working)}/{len(results)} adapters returning usable listings")

    partial = [result for result in results if result.parsed and not result.usable]
    if partial:
        print(
            "\nParsed but not actionable means the site answered and the parser read "
            "a page, but the row lacked a rate or a way to contact anyone - a lead, "
            "not inventory."
        )

    return 0 if working else 1


if __name__ == "__main__":
    sys.exit(main())
