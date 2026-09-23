"""
robots.txt compliance.

Cached per host, per run: one fetch per host rather than one per URL. An
unreachable robots.txt is treated as "no rules published"; a robots.txt that
*disallows* us is obeyed, which is the case that actually matters.

Observed on nigeriapropertycentre.com (2026-09-23): `User-agent: *` disallows
only `*report/create*`, every property path is permitted, and a Sitemap directive
is published. So the intended crawl path is their own sitemap - which is what
sources/npc.py uses.
"""

from __future__ import annotations

import urllib.robotparser
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlparse

USER_AGENT = "House3PartnerResearch/1.0 (+https://house3.ng/bot; partner-outreach)"


@dataclass
class RobotsCache:
    user_agent: str = USER_AGENT
    timeout_seconds: float = 10.0
    _parsers: dict[str, Optional[urllib.robotparser.RobotFileParser]] = field(default_factory=dict)
    _unknown: set[str] = field(default_factory=set)

    def _parser_for(self, url: str):
        host = urlparse(url).netloc
        if host in self._parsers:
            return self._parsers[host]

        parser = urllib.robotparser.RobotFileParser()
        parser.set_url(f"{urlparse(url).scheme}://{host}/robots.txt")
        try:
            parser.read()
        except Exception:
            parser = None

        self._parsers[host] = parser
        return parser

    def allowed(self, url: str) -> bool:
        parser = self._parser_for(url)
        if parser is None:
            return True
        try:
            return parser.can_fetch(self.user_agent, url)
        except Exception:
            return True

    def crawl_delay(self, url: str) -> Optional[float]:
        """Honour a published Crawl-delay if the host sets one."""
        parser = self._parser_for(url)
        if parser is None:
            return None
        try:
            delay = parser.crawl_delay(self.user_agent)
            return float(delay) if delay else None
        except Exception:
            return None

    def sitemaps(self, url: str) -> list[str]:
        host = urlparse(url).netloc
        parser = self._parser_for(url)
        if parser is None:
            return []
        entries = getattr(parser, "site_maps", None) or []
        return list(entries)
