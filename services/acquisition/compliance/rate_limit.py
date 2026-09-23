"""
Rate limiting.

One request at a time per host, with a floor on the interval. We are a guest on
someone else's server, and a crawler that degrades their site is both rude and
the fastest route to being blocked.

A published Crawl-delay wins over our own default.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

#: Minimum seconds between requests to the same host.
DEFAULT_HOST_INTERVAL_SECONDS = 5.0


@dataclass
class HostThrottle:
    interval_seconds: float = DEFAULT_HOST_INTERVAL_SECONDS
    _last_hit: dict[str, float] = field(default_factory=dict)
    total_waited: float = 0.0

    def wait(self, url: str, override_interval: float | None = None) -> float:
        """Sleep if needed. Returns how long we waited, for the run log."""
        host = urlparse(url).netloc
        interval = override_interval or self.interval_seconds

        now = time.monotonic()
        previous = self._last_hit.get(host)

        waited = 0.0
        if previous is not None:
            elapsed = now - previous
            if elapsed < interval:
                waited = interval - elapsed
                time.sleep(waited)

        self.total_waited += waited
        self._last_hit[host] = time.monotonic()
        return waited
