"""
Probe candidate domains and record what they actually publish.

Run this before writing an adapter:

    python compliance/probe_sources.py --out source_registry.json

It fetches `robots.txt` and records the raw evidence into the registry. It NEVER
marks a source PERMITTED: robots evidence is not a licence, and a tool that
decides permission for you is a tool that launders a legal question into a boolean.

WHAT IT RECORDS, AND WHY EACH ONE
---------------------------------
- `robots.fetch`   - FETCHED / UNREACHABLE. The distinction the whole layer rests
                     on: a timeout is not a policy.
- `sitemaps`       - a publisher that advertises one is telling crawlers where its
                     canonical pages are. For NPC that is the difference between
                     16,322 listing URLs and a guessed URL pattern.
- `disallowCount`  - how much is closed off, plus `disallowSamples` so a human can
                     see *which* paths without opening the file.
- `crawlDelay`     - a published delay is a direct instruction and overrides our
                     own interval.
- `layer`          - DISCOVERY / OPERATOR_SITE / BOOKING. A booking platform in the
                     discovery list is a category error, not a preference.

It is deliberately a script and not part of the pipeline: probing is a review
activity a human runs and reads, not something a crawl does on every start.
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from compliance.source_registry import (  # noqa: E402
    BOOKING,
    DISCOVERY,
    FETCHED,
    OPERATOR_SITE,
    UNREACHABLE,
    UNREVIEWED,
    SourceEntry,
    SourceRegistryFile,
    load_registry,
    save_registry,
)

USER_AGENT = "House3PartnerResearch/1.0 (+https://house3.ng/bot; partner-outreach)"
TIMEOUT_SECONDS = 12.0

#: Total wall-clock budget for one probe run. Nine candidates that each behave
#: must not be able to cost more than this. A run that hits the budget reports the
#: remaining candidates as NOT_ATTEMPTED, which is a fact about the run and not a
#: fact about the host.
RUN_BUDGET_SECONDS = 120.0


class ProbeTimeout(Exception):
    """A single fetch exceeded its deadline. Distinct from 'the host said no'."""



@dataclass
class Candidate:
    """A domain to check, and the layer we believe it belongs to."""

    key: str
    host: str
    display_name: str
    layer: str
    #: A note on *why* this layer, since the layer is the decision that matters.
    layer_reason: str = ""
    terms_path: str = "/terms"


#: The candidates from the live search, each with an explicit layer decision.
#:
#: `layer_reason` is not decoration. Three of these take bookings themselves, and a
#: scraper feeding DISCOVERY inventory from a booking platform would violate the one
#: rule `sources/base.py` exists to enforce.
CANDIDATES: tuple[Candidate, ...] = (
    Candidate(
        key="npc",
        host="nigeriapropertycentre.com",
        display_name="Nigeria Property Centre",
        layer=DISCOVERY,
        layer_reason="Third-party listing portal. Its listings are published by agents, not by NPC.",
        terms_path="/terms-of-use",
    ),
    Candidate(
        key="propertypro",
        host="propertypro.ng",
        display_name="PropertyPro Nigeria",
        layer=DISCOVERY,
        layer_reason="Third-party listing portal (PropertyPro/NICOM). Listings are agent-published.",
        terms_path="/terms",
    ),
    Candidate(
        key="jiji",
        host="jiji.ng",
        display_name="Jiji Nigeria",
        layer=DISCOVERY,
        layer_reason=(
            "Classifieds. Advertisers are frequently agents or resellers rather than the "
            "property owner, so a listing is evidence of a property and never of an "
            "operator identity."
        ),
        terms_path="/terms",
    ),
    Candidate(
        key="krent",
        host="krent.space",
        display_name="Krent",
        layer=DISCOVERY,
        layer_reason="Listing portal for short lets with an agent-connect booking flow.",
        terms_path="/terms",
    ),
    Candidate(
        key="apartments_ng",
        host="apartments.ng",
        display_name="Apartments.ng",
        layer=DISCOVERY,
        layer_reason="Listing portal with an editorial blog alongside its listings.",
        terms_path="/terms",
    ),
    Candidate(
        key="plistbooking",
        host="plistbooking.com",
        display_name="Plistbooking",
        layer=BOOKING,
        layer_reason=(
            "Takes bookings and quotes nightly prices directly. Belongs in the BOOKING "
            "layer behind an affiliate or partner agreement - not in sources/."
        ),
        terms_path="/terms",
    ),
    Candidate(
        key="hotels_ng",
        host="hotels.ng",
        display_name="Hotels.ng",
        layer=BOOKING,
        layer_reason=(
            "OTA. Publishes nightly rates for apartments and takes bookings, so it is a "
            "candidate BOOKING channel, not discovery inventory."
        ),
        terms_path="/terms",
    ),
    Candidate(
        key="shortlethomes",
        host="shortlethomes.com",
        display_name="Shortlet Homes",
        layer=OPERATOR_SITE,
        layer_reason=(
            "An operator's own site (e.g. 1677 Mayfair Apartments). One site is one "
            "potential partner, not a source of many properties."
        ),
        terms_path="/terms",
    ),
    Candidate(
        key="gidistays",
        host="gidistays.com",
        display_name="GidiStays",
        layer=OPERATOR_SITE,
        layer_reason="An operator's own site marketing its own apartments in Lagos.",
        terms_path="/terms",
    ),
)


def _fetch_once(url: str, timeout: float) -> tuple[Optional[str], str, str]:
    """The raw fetch, run in a worker thread so it can be abandoned on deadline."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return body, FETCHED, f"HTTP {response.status}"
    except urllib.error.HTTPError as exc:
        if exc.code in (404, 410):
            # Reachable, and it publishes nothing at this path. That is evidence.
            return "", FETCHED, f"HTTP {exc.code} (no file published)"
        return None, UNREACHABLE, f"HTTP {exc.code}"
    except Exception as exc:  # timeouts, DNS, TLS - all "no answer"
        return None, UNREACHABLE, f"{type(exc).__name__}: {exc}"


def fetch(url: str, timeout: float = TIMEOUT_SECONDS, deadline: Optional[float] = None):
    """
    Fetch one URL. Returns (body, fetch_state, note).

    A HARD DEADLINE, BECAUSE urlopen's timeout IS NOT ONE
    -----------------------------------------------------
    `urlopen(timeout=N)` bounds socket reads. It does not bound a TLS handshake
    that makes progress and then stalls, and it does not bound a DNS lookup on some
    platforms. Observed live: `shortlethomes.com` accepted TCP on 443 and answered
    plain HTTP in under a second, but its TLS handshake never completed and
    `urlopen` sat there **indefinitely** - the 12s timeout never fired, and a probe
    of nine hosts hung forever on host number eight.

    That is the exact failure the rollout brief warns about: a timeout that does not
    time out turns a bounded crawl into an unbounded one. So the fetch runs on a
    worker thread and this function abandons it at the deadline. The thread is a
    daemon, so an abandoned handshake cannot keep the process alive either.

    `fetch_state` distinguishes "the server said no" from "the network said
    nothing". A 404 is a reachable host with no robots.txt - a fact about the host.
    A stall is no fact at all, and must not be recorded as one.
    """
    result: list[tuple[Optional[str], str, str]] = []

    def worker() -> None:
        try:
            result.append(_fetch_once(url, timeout))
        except BaseException as exc:  # never let a worker thread die silently
            result.append((None, UNREACHABLE, f"{type(exc).__name__}: {exc}"))

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    # The outer allowance is the inner timeout plus a small grace, so a fetch that
    # honours its own timeout still reports its own error message.
    allowance = timeout + 2.0
    if deadline is not None:
        allowance = min(allowance, max(0.0, deadline))

    thread.join(allowance)

    if thread.is_alive():
        # No `Thread.kill` exists: the abandoned thread is a daemon and will die
        # with the process. Reporting a timeout is the honest outcome, and the
        # caller records it as UNREACHABLE rather than as a policy.
        return None, UNREACHABLE, f"ProbeTimeout: no response within {allowance:.0f}s (TLS/socket stall)"

    if not result:
        return None, UNREACHABLE, "fetch produced no result"

    return result[0]



def parse_robots(body: str) -> dict:
    """Extract the parts of robots.txt a review actually needs to see."""
    groups: list[tuple[str, list[str], list[str]]] = []
    current_agent: Optional[str] = None
    current_disallow: list[str] = []
    current_allow: list[str] = []
    sitemaps: list[str] = []
    crawl_delay: Optional[float] = None

    for raw_line in body.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        field_name, _, value = line.partition(":")
        field_name = field_name.strip().lower()
        value = value.strip()

        if field_name == "user-agent":
            if current_agent is not None:
                groups.append((current_agent, current_disallow, current_allow))
            current_agent, current_disallow, current_allow = value, [], []
        elif field_name == "disallow":
            current_disallow.append(value)
        elif field_name == "allow":
            current_allow.append(value)
        elif field_name == "crawl-delay":
            try:
                crawl_delay = float(value)
            except ValueError:
                crawl_delay = None
        elif field_name == "sitemap":
            sitemaps.append(value)

    if current_agent is not None:
        groups.append((current_agent, current_disallow, current_allow))

    # Only the wildcard group governs us; a named-agent group is someone else's.
    wildcard_disallow: list[str] = []
    for agent, disallow, _allow in groups:
        if agent == "*":
            wildcard_disallow = disallow

    return {
        "sitemaps": sitemaps,
        "crawl_delay": crawl_delay,
        # An empty entry means "Disallow:" with no path - i.e. allow everything.
        "disallow": [entry for entry in wildcard_disallow if entry],
        "groups": len(groups),
    }


def summarise_robots_notes(parsed: dict, state: str, note: str) -> str:
    """
    A one-line human summary: what a reviewer reads before deciding.

    Deliberately blunt about what robots.txt does *not* mean, because the failure
    mode this guards against is a reviewer reading "no Disallow" as "permitted"
    and stopping there.
    """
    if state == UNREACHABLE:
        return (
            f"UNREACHABLE ({note}). No policy observed - this is NOT a permissive "
            "result and does not support a PERMITTED decision."
        )
    parts = [f"Reached ({note})."]
    rules = len(parsed["disallow"])
    parts.append(f"{rules} wildcard Disallow rule(s)." if rules else "No wildcard Disallow rules.")
    if parsed["sitemaps"]:
        parts.append(f"{len(parsed['sitemaps'])} Sitemap directive(s) - a published crawl path.")
    if parsed["crawl_delay"] is not None:
        parts.append(f"Published Crawl-delay {parsed['crawl_delay']}s.")
    parts.append("robots.txt is not a licence: terms of service still govern.")
    return " ".join(parts)


def probe(
    candidate: Candidate,
    previous: Optional[SourceEntry] = None,
    deadline: Optional[float] = None,
) -> SourceEntry:
    """Fetch and record the evidence for one candidate. Never decides PERMITTED."""
    robots_body, robots_state, robots_note = fetch(
        f"https://{candidate.host}/robots.txt", deadline=deadline
    )

    entry = SourceEntry(
        key=candidate.key,
        host=candidate.host,
        display_name=candidate.display_name,
        layer=candidate.layer,
        access_method="PUBLIC_WEB",
        robots_fetch=robots_state,
        robots_url=f"https://{candidate.host}/robots.txt",
        terms_url=f"https://{candidate.host}{candidate.terms_path}",
        notes=candidate.layer_reason,
    )

    if robots_state == FETCHED:
        parsed = parse_robots(robots_body or "")
        entry.robots_sitemaps = parsed["sitemaps"]
        entry.robots_disallow_count = len(parsed["disallow"])
        entry.robots_disallow_samples = parsed["disallow"][:12]
        entry.robots_crawl_delay = parsed["crawl_delay"]
    else:
        parsed = {"sitemaps": [], "disallow": [], "crawl_delay": None}

    entry.robots_notes = summarise_robots_notes(parsed, robots_state, robots_note)

    # A published Crawl-delay is an instruction: honour it over our own default.
    if entry.robots_crawl_delay:
        entry.rate_limit_per_minute = int(60 / entry.robots_crawl_delay)

    # Carry forward a prior human decision. Re-probing is routine; re-deciding is
    # not, and silently resetting a review to UNREVIEWED would stop a crawl a
    # reviewer already approved without saying why.
    if previous is not None:
        entry.terms_status = previous.terms_status
        entry.reviewed_by = previous.reviewed_by
        entry.last_reviewed_at = previous.last_reviewed_at
        entry.attribution_requirement = previous.attribution_requirement
        entry.blocked_reason = previous.blocked_reason
    else:
        entry.terms_status = UNREVIEWED

    if entry.terms_status == UNREVIEWED and not entry.blocked_reason:
        entry.blocked_reason = "No human review recorded."

    return entry


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Probe candidate sources and record evidence")
    parser.add_argument("--out", default="source_registry.json", help="registry file to write")
    parser.add_argument("--key", action="append", help="probe only these keys (repeatable)")
    parser.add_argument(
        "--budget",
        type=float,
        default=RUN_BUDGET_SECONDS,
        help=f"total wall-clock budget for the run in seconds (default {RUN_BUDGET_SECONDS:.0f})",
    )
    args = parser.parse_args(argv)

    out_path = Path(args.out)
    existing = load_registry(out_path)

    selected = [
        candidate for candidate in CANDIDATES if not args.key or candidate.key in args.key
    ]

    started = time.monotonic()
    entries: list[SourceEntry] = []
    skipped: list[str] = []

    for index, candidate in enumerate(selected):
        remaining = args.budget - (time.monotonic() - started)
        # Give each remaining candidate a fair share of what is left, so one slow
        # host cannot consume the budget the others were going to use. A candidate
        # with no time left is NOT_ATTEMPTED, which is a fact about this run.
        fair_share = remaining / max(1, len(selected) - index)
        if fair_share <= 1.0:
            skipped.append(candidate.key)
            print(f"skipping {candidate.key}: run budget exhausted")
            continue

        print(f"probing {candidate.host} ...", flush=True)
        entry = probe(candidate, existing.get(candidate.key), deadline=fair_share)
        entries.append(entry)
        print(f"  robots : {entry.robots_fetch} - {entry.robots_notes}")
        print(f"  layer  : {entry.layer}")
        print(f"  status : {entry.terms_status}")
        print()

    elapsed = time.monotonic() - started
    print(f"probe wall clock: {elapsed:.1f}s of {args.budget:.0f}s budget")
    if skipped:
        print(f"NOT ATTEMPTED this run (budget, not policy): {', '.join(skipped)}")

    # Merge: probed entries replace, untouched entries survive.
    merged = SourceRegistryFile(entries)
    for old in existing.entries:
        if merged.get(old.key) is None:
            merged.entries.append(old)

    path = save_registry(merged, out_path)
    print(f"wrote {path} ({len(merged.entries)} sources)")


    reachable = [entry for entry in merged.entries if entry.robots_fetch == FETCHED]
    unreachable = [entry for entry in merged.entries if entry.robots_fetch == UNREACHABLE]
    print(f"reachable: {len(reachable)}   unreachable: {len(unreachable)}")
    if unreachable:
        print("unreachable sources stay UNREVIEWED - no answer is not permission:")
        for entry in unreachable:
            print(f"  {entry.key}: {entry.robots_notes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
