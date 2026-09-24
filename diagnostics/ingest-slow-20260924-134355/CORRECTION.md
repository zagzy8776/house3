INGEST DIAGNOSTIC — CORRECTION RECORD
=====================================

Original diagnostic label:
    ingest-hang-20260924-134355

Correction:
    The ingest was NOT hung. It completed normally with:
        583 written, 0 rejected
    and wrote its report to ingest-npc-583.json. The client process exited on its
    own, without being terminated.

    Final database state after completion:
        SourceListing       584
        SourceObservation   609
        PriceObservation    591
    (584 rather than 583 because one stale non-shortlet row, id 3667246, was written
    before the SHORTLET_PATH filter fix and had not yet been removed. That row was
    removed afterwards, bringing the canonical set to 583.)

Root cause of the false diagnosis:
    Monitoring sampled a SEPARATE database connection while the ingest was still
    in progress. A separate connection cannot see uncommitted work from another
    session, so it reported the last committed state (100/123/122) on every sample.
    Three identical samples were then read as evidence of a stall.

    The absence of ingest progress reporting made a slow-but-working operation
    indistinguishable from a hung one. The monitor's observation ("I cannot see
    progress") was correct. The inference ("the system is not making progress") was
    not, and only the first was supported by the data.

    Compounding it: the process CPU time was sampled (1.11 -> 1.77s over minutes) and
    read as "creeping", when for a network-bound writer with ~2,000-3,000 sequential
    round-trips to a remote host, a low CPU figure is the expected shape.

Disproving evidence (from aiven-session-inspection.txt, taken while the writer was
still alive and therefore while the evidence still existed):
    - blocked queries:            none
    - locks held:                 none
    - idle-in-transaction:        none
    - xact_open_for:              0:00:00   (no long-lived transaction)
    - the only session present was the inspector's own

Actual engineering findings (these survive):
    1. PostgresIngestor had insufficient progress visibility. A slow ingest looked
       identical to a stalled one, to a human and to a monitor.
    2. Total ingest duration was unbounded. Nothing capped how long an ingest ran.
    3. Idempotence had not been empirically verified. `ON CONFLICT` appeared in the
       code, which is a reason to expect convergence, not evidence that it happens.
    4. Static validation cannot prove a write path works. The production-readiness
       audit returned 22/22 PASS while the write path had never been exercised
       end-to-end by any check.

RESOLUTION
----------
All four are now fixed and, where applicable, measured.

    (1) ingest() reports progress: `ingest 200/583`, `400/583`, `583/583`, with
        elapsed and ETA. Verified on a live 583-record run.
    (2) `--ingest-max-seconds` (default 900) bounds the run and ROLLS BACK on
        expiry, so a partial write cannot be mistaken for a complete inventory.
        A connect timeout and a statement timeout were added alongside it.
    (3) Idempotence was MEASURED, not inferred. Ingesting the same 583 records a
        second time produced zero change:
              SourceListing       583 -> 583
              distinct ids        583 -> 583
              SourceObservation   608 -> 608
              PriceObservation    590 -> 590
              observations @ day  583 -> 583
              prices @ day        565 -> 565
        The two runs ran for 395s and reported 583 written, 0 rejected.
    (4) The acceptance suite needs a small real write/read/re-ingest test against a
        configured database. That is the only check that would have caught what the
        static audit could not see.

    Note on (3): the earlier claim that convergence "follows from ON CONFLICT" was
    an inference from reading code and was presented as though it were established.
    It happened to be correct. The difference matters - it was measured afterwards,
    not before.

MONITORING LESSON, RECORDED BECAUSE IT CAUSED THIS ARTIFACT
-----------------------------------------------------------
    Sampling a database from a second connection cannot observe uncommitted work.
    The monitor's readings (100/123/122, unchanging) were accurate and its
    conclusion (the ingest is stalled) was false. Before concluding "no progress"
    from "no visible progress", check whether the observing mechanism could see
    progress at all.
