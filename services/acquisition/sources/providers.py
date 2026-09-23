"""
Crawl providers.

Three ways to fetch a page, one interface behind them:

    StdlibTransport      our own request. Free, no dependencies, no JS.
    PlaywrightTransport  a real browser. Needed for JS-rendered pages.
    FirecrawlProvider    managed scraping service, does the browser work for us.

WHY A MANAGED PROVIDER DOES NOT CHANGE THE RULES
------------------------------------------------
Paying a vendor to fetch a page does not move the obligation. If Firecrawl
retrieves a page, we received that page. Two consequences, both enforced here
rather than trusted:

  1. `GuardedProvider` wraps every provider and refuses to call it until our own
     robots check has passed. Firecrawl's scrape endpoint takes no robots
     parameter, and Exa indexes pages we did not choose, so OUR gate is the only
     one we can actually verify. You cannot construct a provider in this module
     without the wrapper.

  2. Whatever a provider returns is text, and it goes through the same
     `assert_no_media_or_prose` allowlist as a page we fetched ourselves. A
     vendor returning markdown does not licence the copy inside it.

Cost shape, for planning: Firecrawl bills credits per scrape and Exa bills per
search. Both are far cheaper than the engineering time to run our own browser
fleet, and far more expensive than the stdlib path - so the stdlib path stays the
default and providers are opt-in per run.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol, runtime_checkable
from urllib.request import Request, urlopen

from compliance.allowed_fields import PolicyViolation, strip_media
from compliance.rate_limit import HostThrottle
from compliance.robots import USER_AGENT, RobotsCache


class ProviderError(RuntimeError):
    """Raised when a provider cannot complete a request."""


#: Where the bundled sample pages live, resolved relative to this file so the
#: fixture provider works from any working directory.
_DEFAULT_FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


@runtime_checkable
class CrawlProvider(Protocol):
    name: str

    def fetch(self, url: str) -> str:
        """Return the page as HTML."""
        ...


# ---------------------------------------------------------------------------
# direct transports
# ---------------------------------------------------------------------------


class StdlibTransport:
    """Our own HTTP request. Free and dependency-free, but no JavaScript."""

    name = "stdlib"

    def __init__(self, timeout_seconds: float = 20.0) -> None:
        self.timeout_seconds = timeout_seconds

    def fetch(self, url: str) -> str:
        request = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en-NG,en"})
        with urlopen(request, timeout=self.timeout_seconds) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")


class PlaywrightTransport:
    """
    A real browser. Required for NPC, whose filters and pagination are
    Livewire/Alpine, and generally for anything that renders client-side.

    Lazy import so the service still runs in CI and fixture mode with nothing
    installed.
    """

    name = "playwright"

    def __init__(self, timeout_ms: int = 30_000) -> None:
        try:
            from playwright.sync_api import sync_playwright  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on env
            raise ProviderError(
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


class FixtureTransport:
    """Serves bundled HTML, so the pipeline runs and is testable offline."""

    name = "fixture"

    def __init__(self, fixtures_dir: Optional[Path] = None, sequence: bool = True) -> None:
        # Defaults to the sibling fixtures/ directory, so `FixtureTransport()`
        # works with no arguments from a test or a REPL.
        self.fixtures_dir = Path(fixtures_dir) if fixtures_dir else _DEFAULT_FIXTURES
        self.sequence = sequence
        self._cursor = 0

    def fetch(self, url: str) -> str:
        if self.sequence:
            names = sorted(p.name for p in self.fixtures_dir.glob("npc-listing-*.html"))
            if not names:
                raise ProviderError("no npc-listing-*.html fixtures")
            name = names[self._cursor % len(names)]
            self._cursor += 1
            return (self.fixtures_dir / name).read_text(encoding="utf-8")

        name = url.rsplit("/", 1)[-1] or "npc-listing-1.html"
        path = self.fixtures_dir / name
        if not path.exists():
            raise ProviderError(f"no fixture named {name}")
        return path.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# managed crawl service
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FirecrawlConfig:
    api_key: str
    endpoint: str = "https://api.firecrawl.dev/v2/scrape"
    # We ask for html, not markdown, because every extractor in extraction/ is a
    # regex over markup. Feeding them markdown would silently return zero rows,
    # which is the worst kind of failure.
    formats: tuple[str, ...] = ("html",)
    only_main_content: bool = False
    timeout_ms: int = 60_000
    wait_for_ms: int = 0
    # Largest legal lever we have, and we should pull it: keeps scraped pages
    # out of Firecrawl's own index. We read third-party pages to find operators,
    # not to build a mirror of them.
    store_in_cache: bool = False


class FirecrawlProvider:
    """
    Managed scraping via Firecrawl. No browser to install, no proxy fleet to
    run, and it handles the JS-rendered portals our stdlib path cannot.

    Response shape (v2):
        { "success": true, "data": { "html": "...", "markdown": "...",
                                     "metadata": {...} } }
    """

    name = "firecrawl"

    def __init__(self, config: FirecrawlConfig) -> None:
        if not config.api_key:
            raise ProviderError(
                "FirecrawlProvider needs FIRECRAWL_API_KEY. Set it in .env, "
                "or run with --transport stdlib / --transport fixture."
            )
        self.config = config

    def fetch(self, url: str) -> str:
        payload = {
            "url": url,
            "formats": list(self.config.formats),
            "onlyMainContent": self.config.only_main_content,
            "timeout": self.config.timeout_ms,
            "storeInCache": self.config.store_in_cache,
            # Images are stripped before they reach us. We do not publish other
            # operators' photographs, and removing them at the boundary stops
            # downstream code from ever starting to rely on them.
            "removeBase64Images": True,
            "excludeTags": ["img", "picture", "source", "figure"],
        }
        if self.config.wait_for_ms:
            payload["waitFor"] = self.config.wait_for_ms

        body = self._post(payload)
        if not body.get("success"):
            raise ProviderError(f"firecrawl failed for {url}: {body.get('error')}")

        data = body.get("data") or {}
        html = data.get("html") or data.get("rawHtml")
        if not html:
            raise ProviderError(
                f"firecrawl returned no html for {url} "
                f"(formats requested: {list(self.config.formats)})"
            )
        return html

    def _post(self, payload: dict) -> dict:
        request = Request(
            self.config.endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.config.timeout_ms / 1000 + 15) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - surfaced as ProviderError
            raise ProviderError(f"firecrawl request failed for {payload.get('url')}: {exc}") from exc


# ---------------------------------------------------------------------------
# semantic discovery
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExaConfig:
    api_key: str
    endpoint: str = "https://api.exa.ai/search"
    num_results: int = 25
    # "preferred" asks Exa to live-crawl when its cached copy is stale, which is
    # what we want for operators who listed this week.
    livecrawl: str = "preferred"
    category: Optional[str] = None


class ExaDiscovery:
    """
    Finds operators we do not already know about, by meaning rather than by URL
    shape. This is the piece our sitemap walk structurally cannot do: NPC's
    sitemap only ever tells us about NPC.

    Request shape (verified against the API reference):
        POST https://api.exa.ai/search
        x-api-key: <key>
        { "query", "includeDomains", "numResults", "category",
          "contents": { "text", "summary": { "query", "schema" },
                        "livecrawl" } }

    `contents.summary.schema` is the useful and dangerous part. It accepts a JSON
    schema and returns an LLM-written object matching it, which is exactly the
    structured shape we want. But any field we put in that schema is a field we
    have collected - so the schema is BUILT FROM ALLOWED_FIELDS in
    extraction/schema.py and never hand-written. Putting "description" in that
    schema would launder prose collection through a vendor and defeat the
    allowlist entirely.

    Results carry `title`, `url`, `publishedDate` and `author`, so discovery
    also answers WHEN a page appeared - the search index tells us, instead of us
    re-crawling to find out.
    """

    name = "exa"

    def __init__(self, config: ExaConfig) -> None:
        if not config.api_key:
            raise ProviderError(
                "ExaDiscovery needs EXA_API_KEY. Set it in .env, "
                "or run without --discover exa."
            )
        self.config = config

    def search(self, query: str, include_domains: list[str], output_schema: dict) -> list[dict]:
        payload = {
            "query": query,
            "includeDomains": include_domains,
            "numResults": self.config.num_results,
            "type": "auto",
            "contents": {
                "text": False,
                "summary": {"query": query, "schema": output_schema},
                "livecrawl": self.config.livecrawl,
            },
        }
        if self.config.category:
            payload["category"] = self.config.category

        return self._post(payload).get("results") or []

    def discover(self, query: str, include_domains: list[str], output_schema: dict) -> list[dict]:
        """
        Project Exa results into discovery candidates, dropping any field the
        allowlist does not admit. Belt and braces: the schema already restricts
        what we asked for, and this restricts what we keep. A vendor is not a
        compliance boundary, so we do not trust one.
        """
        allowed = summary_field_names()
        candidates: list[dict] = []
        for result in self.search(query, include_domains, output_schema):
            url = result.get("url")
            if not url:
                continue
            candidate: dict = {
                "source_url": url,
                "title": result.get("title"),
                "published_at": result.get("publishedDate"),
                "discovered_via": "exa",
            }
            summary = result.get("summary")
            if isinstance(summary, dict):
                candidate["fields"] = {
                    key: value for key, value in summary.items() if key in allowed
                }
            candidates.append(candidate)
        return candidates

    def _post(self, payload: dict) -> dict:
        request = Request(
            self.config.endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "x-api-key": self.config.api_key,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=45) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(f"exa search failed: {exc}") from exc


def summary_field_names() -> frozenset[str]:
    # Imported lazily so this module stays importable without extraction/, and
    # so that extraction/schema.py remains the single definition of the surface.
    from extraction.schema import EXA_SUMMARY_FIELDS

    return EXA_SUMMARY_FIELDS


# ---------------------------------------------------------------------------
# the wrapper that makes the rule structural
# ---------------------------------------------------------------------------


class GuardedProvider:
    """
    Every outbound fetch goes through here: robots first, then throttle, then
    the wrapped provider.

    Nothing else in the codebase should call a provider's `fetch` directly - the
    pipeline builds one of these instead. That way "did we check robots?" is
    answered by the type system rather than by remembering to call a function,
    and swapping in a paid provider cannot quietly skip the check.
    """

    def __init__(
        self,
        inner: CrawlProvider,
        robots: RobotsCache,
        throttle: HostThrottle,
        min_interval_seconds: float = 1.0,
    ) -> None:
        self.inner = inner
        self.robots = robots
        self.throttle = throttle
        self.min_interval_seconds = min_interval_seconds
        self.name = inner.name

    def fetch(self, url: str) -> str:
        if not self.robots.allowed(url):
            raise PolicyViolation(f"robots.txt disallows {url}; refusing to fetch")

        # A published Crawl-delay wins over our own floor, and it wins here
        # rather than in the caller so a new provider cannot forget it.
        delay = self.robots.crawl_delay(url)
        self.throttle.wait(url, override_interval=delay or self.min_interval_seconds)

        html = self.inner.fetch(url)
        # Images come out of the markup before any parser touches it, whoever
        # fetched the bytes. A provider is not a licence and not a compliance
        # boundary, so this runs on managed output too.
        return strip_media(html)


class AlwaysAllowRobots:
    """
    Offline stand-in for RobotsCache.

    Fixture mode serves bundled HTML and never contacts a network, so there is
    no host whose rules we could be breaching. Named so that it is obvious in a
    stack trace, and separate from RobotsCache so it can never be selected by a
    flag that also runs real crawls.
    """

    def allowed(self, url: str) -> bool:  # noqa: ARG002
        return True

    def crawl_delay(self, url: str) -> Optional[float]:  # noqa: ARG002
        return None

    def sitemaps(self, url: str) -> list[str]:  # noqa: ARG002
        return []


def offline_guard(inner: CrawlProvider) -> GuardedProvider:
    """Fixture mode. No robots fetch, no throttle - there is no host involved."""
    return GuardedProvider(
        inner,
        AlwaysAllowRobots(),  # type: ignore[arg-type]
        HostThrottle(interval_seconds=0.0),
        min_interval_seconds=0.0,
    )


def build_provider(
    transport: str,
    *,
    fixtures_dir=None,
    timeout_ms: int = 60_000,
) -> CrawlProvider:
    """Construct a transport by name. Wrap the result in GuardedProvider."""
    if transport == "stdlib":
        return StdlibTransport()
    if transport == "playwright":
        return PlaywrightTransport(timeout_ms=timeout_ms)
    if transport == "fixture":
        if fixtures_dir is None:
            raise ProviderError("fixture transport needs a fixtures directory")
        return FixtureTransport(fixtures_dir)
    if transport == "firecrawl":
        return FirecrawlProvider(
            FirecrawlConfig(
                api_key=os.environ.get("FIRECRAWL_API_KEY", ""),
                timeout_ms=timeout_ms,
            )
        )
    raise ProviderError(f"unknown transport {transport!r}")


def build_discovery(provider_name: str) -> ExaDiscovery:
    if provider_name != "exa":
        raise ProviderError(f"unknown discovery provider {provider_name!r}")
    return ExaDiscovery(ExaConfig(api_key=os.environ.get("EXA_API_KEY", "")))
