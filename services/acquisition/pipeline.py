"""
Partner acquisition pipeline.

INPUT:  public listing pages and operator sites across the launch states.
OUTPUT: JSONL of operator PROSPECTS - who to call, where, how big, at what rate.

It does not output inventory, and it cannot: there is no calendar here and no
agreement. That happens later, after a human signs the operator, who then
onboards through the same authorised channels as any other partner.

Transport is pluggable. `StdlibTransport` needs nothing installed and is the
default for fixture runs and CI. `PlaywrightTransport` slots in behind the same
one-method interface for JavaScript-rendered pages.

Run:
    python pipeline.py --fixture          # offline, parses the bundled sample
    python pipeline.py --targets targets.jsonl --out leads.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from urllib.request import Request, urlopen

from policy import (
    HostThrottle,
    PolicyViolation,
    RobotsCache,
    USER_AGENT,
    assert_no_media_or_prose,
    to_lead,
)


class Transport:
    """Fetch a URL and return its text. One method, so it is trivially stubbable."""

    def fetch(self, url: str) -> str:  # pragma: no cover - interface
        raise NotImplementedError


class StdlibTransport(Transport):
    """Default transport. No third-party dependencies."""

    def __init__(self, timeout_seconds: float = 20.0) -> None:
        self.timeout_seconds = timeout_seconds

    def fetch(self, url: str) -> str:
        request = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en-NG,en"})
        with urlopen(request, timeout=self.timeout_seconds) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")


class PlaywrightTransport(Transport):
    """
    For JavaScript-rendered listing pages.

    Deliberately optional: imported lazily so the service runs in CI and in
    fixture mode with nothing installed. Only the crawling environment needs
    `pip install playwright && playwright install chromium`.

    It still sits behind RobotsCache and HostThrottle in the pipeline - a real
    browser does not exempt us from the policy.
    """

    def __init__(self, timeout_ms: int = 30_000) -> None:
        try:
            from playwright.sync_api import sync_playwright  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on env
            raise RuntimeError(
                "PlaywrightTransport requires `pip install playwright` and "
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


@dataclass(frozen=True)
class SourceSpec:
    """
    Per-source extraction rules.

    Portals differ in markup, so these regexes are meant to be tuned per site.
    Keeping them as data means adding a source is a config change; keeping them
    as regexes rather than a model reading prose is what stops the extractor
    wandering into someone else's copyright.
    """

    name: str
    operator_pattern: str
    area_pattern: str
    phone_pattern: str
    rate_pattern: str
    email_pattern: Optional[str] = None
    website_pattern: Optional[str] = None
    instagram_pattern: Optional[str] = None


#: Booking systems we recognise. A hit means the operator can onboard via API or
#: iCal instead of retyping rates into our dashboard - the biggest lever on
#: onboarding cost, and therefore on CAC.
PMS_FINGERPRINTS: dict[str, str] = {
    "smoobu.com": "smoobu",
    "beds24.com": "beds24",
    "hostaway.com": "hostaway",
    "lodgify.com": "lodgify",
    "guesty.com": "guesty",
    "ical.airbnb": "airbnb_ical",
}

#: Ordered: the first match wins, so put the strongest title first.
TITLE_PATTERNS: list[tuple[str, str]] = [
    (r"certificate of occupancy", "C_OF_O"),
    (r"c\s*of\s*o\b", "C_OF_O"),
    (r"governor'?s consent", "GOVERNORS_CONSENT"),
    (r"deed of assignment", "DEED_OF_ASSIGNMENT"),
    (r"excision|gazette", "EXCISION_GAZETTE"),
    (r"right of occupancy", "RIGHT_OF_OCCUPANCY"),
    (r"freehold", "FREEHOLD"),
    (r"registered deed", "REGISTERED_DEED"),
]

STATE_HINTS: dict[str, str] = {
    "lagos": "LA",
    "lekki": "LA",
    "ikoyi": "LA",
    "victoria island": "LA",
    "ajah": "LA",
    "ikeja": "LA",
    "abuja": "FC",
    "maitama": "FC",
    "asokoro": "FC",
    "wuse": "FC",
    "gwarinpa": "FC",
    "ibadan": "OY",
    "bodija": "OY",
    "owerri": "IM",
    "uyo": "AK",
    "akwa ibom": "AK",
}


def _first(pattern: Optional[str], text: str) -> Optional[str]:
    if not pattern:
        return None
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else None


def detect_pms(html: str) -> Optional[str]:
    lowered = html.lower()
    for needle, name in PMS_FINGERPRINTS.items():
        if needle in lowered:
            return name
    return None


def detect_title(text: str) -> Optional[str]:
    lowered = text.lower()
    for pattern, value in TITLE_PATTERNS:
        if re.search(pattern, lowered):
            return value
    return None


def detect_state(text: str) -> Optional[str]:
    lowered = text.lower()
    for hint, code in STATE_HINTS.items():
        if hint in lowered:
            return code
    return None


def parse_rate_to_kobo(raw: Optional[str]) -> Optional[int]:
    """
    "NGN 150,000" / "N150,000" / "150000" -> 15_000_000 kobo.

    Rates are the one number we take from another company's page, and only ever
    aggregated into a neighbourhood benchmark. We never resell at their price.
    """
    if not raw:
        return None
    digits = re.sub(r"[^0-9]", "", raw)
    if not digits:
        return None
    naira = int(digits)
    # A nightly rate under 1,000 naira is almost certainly a parse error.
    if naira < 1_000:
        return None
    return naira * 100


def extract(html: str, spec: SourceSpec, source_url: str) -> dict:
    """Pull only the allowlisted fields out of one page."""
    operator = _first(spec.operator_pattern, html)
    if not operator:
        raise ValueError(f"{spec.name}: no operator name matched at {source_url}")

    area = _first(spec.area_pattern, html) or ""
    text = f"{operator} {area}"

    record: dict = {
        "operator_name": operator,
        "area": area,
        "state_code": detect_state(text) or detect_state(html) or "",
        "listing_count": 1,
        "phone": _first(spec.phone_pattern, html),
        "email": _first(spec.email_pattern, html),
        "website": _first(spec.website_pattern, html),
        "instagram": _first(spec.instagram_pattern, html),
    }

    rate = parse_rate_to_kobo(_first(spec.rate_pattern, html))
    if rate:
        record["nightly_rate_kobo"] = rate

    title = detect_title(text) or detect_title(html)
    if title:
        record["title_document"] = title

    pms = detect_pms(html)
    if pms:
        record["pms_fingerprint"] = pms

    # Drop keys we could not read, so the allowlist check sees only real fields.
    record = {key: value for key, value in record.items() if value not in (None, "")}

    return assert_no_media_or_prose(record)


#: Starter spec. Real deployments add one per source; keeping the demo one here
#: means the pipeline is runnable and testable before any site is configured.
DEMO_SPEC = SourceSpec(
    name="demo",
    operator_pattern=r'<h1[^>]*class="[^"]*operator[^"]*"[^>]*>([^<]+)</h1>',
    area_pattern=r'<span[^>]*class="[^"]*area[^"]*"[^>]*>([^<]+)</span>',
    phone_pattern=r'tel:(\+?[0-9\s\-]{7,20})',
    rate_pattern=r"(?:NGN|N|&#8358;|₦)\s?([0-9][0-9,\.]{2,})",
    email_pattern=r'href="mailto:([^"?]+)',
    website_pattern=r'href="(https?://(?!wa\.me|api\.whatsapp)[^"]+)"',
    instagram_pattern=r"instagram\.com/([A-Za-z0-9_.]+)",
)


def run(
    targets: list[str],
    transport: Transport,
    spec: SourceSpec,
    out_path: Path,
    interval_seconds: float = 5.0,
) -> dict:
    """
    Crawl the targets and write one JSONL prospect per operator.

    Returns run statistics. Nothing here writes to Postgres: the pipeline hands
    a file to the TypeScript side, which owns normalisation, dedupe and scoring,
    so there is exactly one implementation of that logic.
    """
    robots = RobotsCache()
    throttle = HostThrottle(interval_seconds=interval_seconds)

    stats = {"targets": len(targets), "fetched": 0, "skipped_robots": 0, "failed": 0, "leads": 0}

    with out_path.open("w", encoding="utf-8") as sink:
        for url in targets:
            if not robots.allowed(url):
                stats["skipped_robots"] += 1
                print(f"  SKIP (robots) {url}", file=sys.stderr)
                continue

            throttle.wait(url)

            try:
                html = transport.fetch(url)
                stats["fetched"] += 1
            except Exception as exc:
                stats["failed"] += 1
                print(f"  FAIL {url}: {exc}", file=sys.stderr)
                continue

            try:
                record = extract(html, spec, url)
            except (ValueError, PolicyViolation) as exc:
                stats["failed"] += 1
                print(f"  SKIP (extract) {url}: {exc}", file=sys.stderr)
                continue

            lead = to_lead(record)
            lead["sources"] = [
                {
                    "kind": "PUBLIC_LISTING_TITLE",
                    "reference": url,
                    "observedAt": _now_iso(),
                    "robotPermitted": True,
                }
            ]

            if not lead["contact"]["phone"] and not lead["contact"]["email"] and not lead["contact"]["website"]:
                # A lead nobody can contact is noise in the call list.
                stats["failed"] += 1
                print(f"  SKIP (no contact channel) {url}", file=sys.stderr)
                continue

            sink.write(json.dumps(lead, ensure_ascii=False) + "\n")
            stats["leads"] += 1
            print(f"  OK {lead['displayName']} ({lead['area']})", file=sys.stderr)

    return stats


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class FixtureTransport(Transport):
    """Serves bundled HTML, so the pipeline is runnable and testable offline."""

    def __init__(self, fixtures_dir: Path) -> None:
        self.fixtures_dir = fixtures_dir

    def fetch(self, url: str) -> str:
        name = url.rsplit("/", 1)[-1] or "sample_listing.html"
        path = self.fixtures_dir / name
        if not path.exists():
            raise FileNotFoundError(f"no fixture named {name}")
        return path.read_text(encoding="utf-8")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="House3 partner acquisition pipeline")
    parser.add_argument("--targets", help="file of URLs, one per line")
    parser.add_argument("--out", default="leads.jsonl", help="output JSONL path")
    parser.add_argument("--interval", type=float, default=5.0, help="seconds between hits on one host")
    parser.add_argument(
        "--transport",
        choices=["stdlib", "playwright"],
        default="stdlib",
        help="playwright is only needed for JavaScript-rendered pages",
    )
    parser.add_argument("--fixture", action="store_true", help="run offline against bundled HTML")
    args = parser.parse_args(argv)

    out_path = Path(args.out)
    fixtures_dir = Path(__file__).parent / "fixtures"

    if args.fixture:
        targets = ["fixture://sample_listing.html"]
        transport: Transport = FixtureTransport(fixtures_dir)
    else:
        if not args.targets:
            parser.error("--targets is required unless --fixture is used")
        targets = [
            line.strip()
            for line in Path(args.targets).read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")
        ]
        transport = PlaywrightTransport() if args.transport == "playwright" else StdlibTransport()

    print(f"acquisition: {len(targets)} target(s), transport={type(transport).__name__}", file=sys.stderr)
    stats = run(targets, transport, DEMO_SPEC, out_path, interval_seconds=args.interval)

    print(
        "done: "
        f"{stats['leads']} prospect(s) from {stats['fetched']} page(s); "
        f"{stats['skipped_robots']} skipped by robots, {stats['failed']} failed",
        file=sys.stderr,
    )
    print(f"wrote {out_path}")

    if isinstance(transport, PlaywrightTransport):  # pragma: no cover - depends on env
        transport.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
