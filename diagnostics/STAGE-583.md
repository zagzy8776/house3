# Stage record: NPC, 583 listings, frozen

**Status: frozen and verified.** Re-audited after three ingests from the same file.

## What is in the database

| Table | Count |
|---|---|
| `SourceListing` | 583 |
| `SourceObservation` | 608 |
| `PriceObservation` | 590 |
| `Location` | 22 |
| `Property` | **0** |
| `Operator` | **0** |
| `Unit` | **0** |

`Property`, `Operator` and `Unit` are zero because **entity resolution does not exist
yet**, not because anything failed. Discovery produces evidence; only resolution
produces canon. 583 listings await that step.

## Verified properties

| Check | Result |
|---|---|
| Listings match the frozen file (count) | 583 = 583 |
| Same ids present (set equality, not just count) | 0 only-in-db, 0 only-in-file |
| Same urls present | 0 only-in-db, 0 only-in-file |
| Duplicate ids / urls | 0 / 0 |
| Duplicate `(sourceListingId, observedAt)` in either ledger | 0 / 0 |
| Non-shortlet rows | 0 |
| Linkage to `Property`/`Operator` | 0 |
| Price-basis distribution matches the file | 523 PER_NIGHT, 34 PER_MONTH, 22 UNKNOWN, 4 PER_WEEK |
| Observability days | 2 (the earlier 25-listing batch plus this one) |
| Geographic spread | 22 areas, Lekki 352 / Victoria Island 54 / Ikeja 53 / Ikoyi 46 |

## Verified behaviours

**Idempotence, measured not inferred.** Ingesting the same 583 records a second time
produced zero change to any table. Re-running after a partial failure is safe.

**The multi-day ledger works.** 608 observations decompose into 583 for 2026-09-24 and
25 for the earlier batch. A prior day is retained, never overwritten, which is what
makes price history possible later.

**Discovery cannot create canonical inventory.** `Unit`, `Booking` and any listing
`operatorId`/`propertyId` linkage are all zero, checked after three writes.

**Unreachable is never read as empty.** A failed discovery raises; a stalled fetch hits
a hard deadline. Neither can be mistaken for "this source has no inventory".

## Defects found by running this stage, and fixed

1. **A list page was recorded as a listing.** When the sitemap timed out, discovery fell
   back to list pages and parsed one, keying every row on the state slug. A live run
   reported "18 written" and the database received one junk row.
2. **A shortlet list page publishes links that are not shortlets.** 15 of 79 `/for-rent/`
   links on a shortlet page pointed outside short-let, and two carried listing-shaped
   tails, so annual rents entered shortlet inventory at `PER_MONTH`.
3. **The probe's timeout did not time out.** `urlopen(timeout=)` bounds socket reads,
   not a stalled TLS handshake. A nine-host probe hung indefinitely on host eight.
4. **`--ingest-file` read JSONL as JSON.**
5. **The resume file marked refused URLs as done**, which would have skipped real
   listings permanently.
6. **The ingest had no progress reporting, no duration bound and no measured
   idempotence.** All three are now fixed; see `diagnostics/ingest-slow-20260924-134355/`.

## What this dataset is not

It is **discovery inventory**, not bookable inventory.

- No `Unit` row exists, so no listing here can be booked, priced or charged.
- Every price is an **advertisement observed on a source**, never a House3 quote.
- No photograph or description text was collected. `compliance/allowed_fields.py`
  strips media before a parser sees a page, and the run fails if a parser emits one.
- The operator contact on each row is **the publisher's own phone number**, recorded as
  contact evidence. It is not a verified identity and it does not imply a partnership.

Next step: geocoding and entity resolution, to turn 583 listings into canonical
properties with coordinates.
