"""
A deadline that a stalled TLS handshake cannot escape.

WHY THIS IS ITS OWN MODULE
--------------------------
`urlopen(timeout=N)` bounds socket reads. It does NOT bound a TLS handshake that
makes progress and then stalls, and it does not reliably bound a DNS lookup. This
was observed live, not theorised:

    shortlethomes.com   DNS resolved (217.160.0.230)
                        TCP 443 connected
                        plain HTTP over that socket answered in under 8 seconds
                        TLS via urlopen  ->  HUNG INDEFINITELY
                        the 12s timeout never fired

A nine-host probe sat on host eight forever. The same shape of failure would turn a
13,471-URL crawl into an unbounded one, which is why "a crawler that can hang
indefinitely is effectively a production outage" is the right way to think about it.

So `call_with_deadline` runs the blocking work on a daemon thread and abandons it at
the deadline. Python cannot kill a thread, and it does not need to: the worker is a
daemon, so an abandoned handshake dies with the process and cannot keep it alive.

The distinction that matters is between a SLOW SOURCE and a STALLED ONE, and both
must return. `DeadlineExceeded` says "we got no answer", never "there is nothing
there" - a caller must not turn it into an empty result.
"""

from __future__ import annotations

import threading
from typing import Callable, TypeVar

T = TypeVar("T")

#: Grace added to a caller's own timeout, so work that honours its timeout reports
#: its own error message rather than being pre-empted by the outer deadline.
DEFAULT_GRACE_SECONDS = 2.0


class DeadlineExceeded(RuntimeError):
    """The work did not finish in time. Distinct from 'the source said no'."""


def call_with_deadline(
    work: Callable[[], T],
    timeout: float,
    grace: float = DEFAULT_GRACE_SECONDS,
) -> T:
    """
    Run `work` and return its result, or raise `DeadlineExceeded`.

    Raises whatever `work` raised, so a caller's own error handling is unaffected in
    the normal case. The deadline only ever adds a new failure mode, never masks one.
    """
    outcome: list[tuple[bool, object]] = []

    def runner() -> None:
        try:
            outcome.append((True, work()))
        except BaseException as exc:  # noqa: BLE001 - re-raised on the caller's thread
            outcome.append((False, exc))

    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    thread.join(timeout + grace)

    if thread.is_alive():
        raise DeadlineExceeded(
            f"no response within {timeout + grace:.0f}s (the socket stalled; "
            "urlopen's own timeout does not cover a stalled TLS handshake)"
        )

    if not outcome:
        raise DeadlineExceeded("work produced no result")

    ok, payload = outcome[0]
    if not ok:
        raise payload  # type: ignore[misc]
    return payload  # type: ignore[return-value]
