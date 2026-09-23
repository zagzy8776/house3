# Inventory engine — phased implementation plan

Turns today's crawl → `directory.json` → `/places` path into the PostGIS-backed
inventory engine, without weakening an invariant the platform already enforces.

Written against commit `d066b92` (`feat(directory): split DIRECTORY from AFFILIATE handoffs`).

## How to read this

Every phase has the same shape:

- **Objective** — the outcome, not a task list.
- **Current state** — what the repo already does at that boundary, with file paths.
- **Deliverables** — concrete models, files, endpoints.
- **Milestones** — `M<n>.<k>`, each independently shippable.
- **Acceptance criteria** — testable statements. Done means these pass in CI.
- **Migration / cutover** — how data and readers move, and how to reverse it.

Phase 0 is not in the brief. It exists because Phase 1 cannot be migrated onto a
database that has never had a migration run against it.

## Ground rules (every phase, no exceptions)

These are already enforced in code. A phase that breaks one is a regression, not
a trade-off.

| # | Rule | Enforced by |
|---|---|---|
| 1 | Money is `Int` kobo; rates are integer basis points | `src/domain/money.ts`, `prisma/schema.prisma` |
| 2 | An observed price can never become a payable price | `src/domain/provenance.ts` (`assertBookable`) |
| 3 | No photographs or prose from a crawl, at three boundaries | `strip_media()` → `FORBIDDEN_FIELDS` → `NEVER_PUBLISHED` |
| 4 | No authorized channel, no sync | `assertAuthorized()`, `PartnerChannel.authorizationReference` |
| 5 | Every public row is attributed and links to its source | `assertPublishable()` in `src/domain/directory.ts` and `publishing.py` |
| 6 | The supplier is always named; there is no anonymous supply | `InventoryPartner`, `partnerDisplayName` |
| 7 | Unknown stays unknown — no inferred pin, rate, or view count | nullable `Unit.latitude/longitude`, `cardImage()` returning `EMPTY` |
| 8 | `src/domain/**` imports nothing else in the project | `ARCHITECTURE.md`; reviewed by hand |

Rule 7 is the one that feels slowest and matters most. A `NULL` that is honestly
`NULL` is cheap; a plausible guess is expensive the first time a guest drives to
the wrong street.

## Baseline at `d066b92`

| Layer | State | Where |
|---|---|---|
| Domain | Pure: money, pricing, splits, dates, geo, media, provenance, directory, title | `src/domain/**` |
| Orchestration | Booking hold → charge → confirm → ledger | `src/server/bookingService.ts` |
| Persistence | `Repository` interface + in-memory implementation. **No runtime Prisma client anywhere** | `src/server/store.ts`, `src/server/container.ts` |
| Schema | Sellable supply + prospect tables, **no `prisma/migrations/` directory** | `prisma/schema.prisma`, `prisma/seed.ts` |
| Partner supply | Four authorized channel kinds behind one contract | `src/inventory/*Adapter.ts`, `registry.ts` |
| Payments | Paystack + Flutterwave, webhook replay protection | `src/payments/**`, `WebhookEvent` |
| Acquisition | Compliant crawl → leads, observation ledger, `directory.json` | `services/acquisition/**` |
| Surfaces | `/`, `/search`, `/places`, `/checkout/return`, six API routes | `src/app/**` |
| `/places` read path | JSON file, fails soft when missing | `src/server/directorySource.ts` |

Verified while writing this plan, not assumed:

- `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`
  emits full baseline DDL **with no database connection**, so a baseline migration
  can be created and reviewed before any Postgres instance exists.
- Prisma 6.3.0 validates both `geog Unsupported("geography(Point, 4326)")?` and the
  non-nullable form (probed with `prisma validate`), so PostGIS columns do not
  require abandoning the Prisma model.
- `postgres:16-alpine` in `docker-compose.yml` does **not** ship PostGIS. The image
  has to change before any `geography` column can exist. That is Phase 0's first job.

## Gaps this plan closes

1. No canonical `Property` — nothing lets several source listings describe one real
   accommodation, and `Unit` is partner-scoped rather than physical.
2. No source-listing ↔ canonical-property link; `ProspectListing` has no `propertyId`.
3. No operator entity — `operatorKey` is a string produced by Python union-find, not
   a row a signed `InventoryPartner` can link to.
4. No `PriceObservation` with price *basis* (per night vs per stay), nights, guest
   count, or tax/fee inclusion. Only a bare `advertisedPriceKobo`.
5. No amenity taxonomy, and no record of source wording or the mapping decision.
6. No geocode metadata (`provider`, `confidence`, `precision`), and no PostGIS.
7. No `MatchDecision` audit, so a merge cannot be reviewed or reversed.
8. No `SourceRegistry` — permission lives in Python constants and prose.
9. No crawl-run or outcome telemetry.
10. Availability is per-night partner state; there is no property-level `UNKNOWN` /
    `REQUIRES_CONFIRMATION` distinction.
11. No mapping tables from House3 IDs to partner IDs.
12. No commission accrual for affiliate inventory, and no metrics pipeline.

## Dependency order, and why it is this order

```
Phase 0  PostGIS + migration baseline          (unblocks 1 and 4)
   |
Phase 1  canonical schema                      (IDs are the contract for everything else)
   |--- Phase 2  ingestion writes canonical rows
   |--- Phase 3  geocoding + entity resolution
   |
Phase 4  PostGIS-backed inventory + Prisma repository
   |
Phase 5  search, maps, availability semantics
   |
Phase 6  partner connectivity (live rates, booking, reconciliation)
   |
Phase 7  payments and commissions, monitoring, nationwide expansion
```

Phases 2 and 3 are siblings: both consume Phase 1's IDs and can proceed in
parallel once `Property` and `SourceListing` exist. Phase 6 can start earlier
because the adapters already exist, but its mapping tables belong after Phase 1 —
a partner unit must bind to a House3 unit that has a stable canonical parent.

One ordering decision is not negotiable: building ingestion before the canonical
schema means writing rows keyed by portal listing IDs, and every duplicate created
that way has to be merged by hand later.

## Migration and cutover strategy (cross-cutting)

### Expand → backfill → contract

Never add a `NOT NULL` column to a populated table in the release that starts
writing it. Three releases: (1) add nullable and dual-write, (2) backfill and
verify, (3) add the constraint. Prisma cannot express GiST, partial, or exclusion
constraints, so those are hand-written in a `--create-only` migration and reviewed
like code.

### Baseline, once

No `prisma/migrations/` exists and only `prisma/seed.ts` imports Prisma, so the
baseline is safe to introduce now:

```bash
npx prisma migrate dev --name baseline --create-only   # review the generated SQL
npx prisma migrate deploy                              # apply to a clean database
```

Commit `prisma/migrations/**` — `.gitignore` only excludes `dev.db*`. `db:push`
stays for throwaway local work but is not authoritative; CI uses `migrate deploy`
plus a drift guard.

### PostGIS columns

`geog` is `Unsupported(...)`, so Prisma Client cannot read or write it. Every write
goes through raw SQL (`ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography`) in a
small helper module with tests, and index creation is hand-written SQL. Prisma
6.3.0 validates both the nullable and required forms, so the column can live in the
Prisma datamodel while the writes live in SQL.

### Rename a table without migrating data

`ProspectListing` → `SourceListing` at the **model** level with
`@@map("ProspectListing")`: DDL is untouched, the code reads better, and there is no
table rewrite. Renaming the physical table later is a separate, reversible migration
with a view alias during the transition.

### Dual-write, shadow-read, then flip one reader

1. Pipeline keeps writing `directory.json`; DB ingest is added behind `--ingest db`.
   `/places` and `/api/search` are unchanged in this step.
2. Shadow compare: a job checks row counts, `rejected` counts and price parity
   between JSON and database per run. A difference is an alert, never a silent pass.
3. Flip one reader at a time behind a flag (`SEARCH_DRIVER`, `PLACES_DRIVER`).
   `directorySource.ts` already fails soft, so JSON remains the fallback for a full
   release after the flip.
4. Remove the JSON read only after a full release with zero parity failures.

### Rollback rules

- Migrations are forward-only in production; a migration that cannot be reversed
  ships with a written forward-fix.
- Flags return reads to the previous driver. A code rollback never has to undo data.
- Ingest can stop without affecting reads: no reader depends on ingest having run.
- Nightly `pg_dump` plus PITR; a restore rehearsal is required evidence in Phase 4.

### Data protection

- Separate roles: ingest (write), api (`SELECT` only, `statement_timeout`),
  migrator (DDL). No shared superuser.
- Prospect and observation tables hold business contact data only. `agent_name`
  stays forbidden; retention jobs are the only deleters and they record what they
  deleted.
- Snapshot bytes live in object storage keyed by SHA-256. Postgres holds the hash
  and a reference, never a third-party CDN URL we do not control.

## Phase 0 — PostGIS and the migration baseline

**Objective.** A database the schema can be migrated onto reproducibly, with no
change to runtime behavior.

**Current state.** `docker-compose.yml` runs `postgres:16-alpine` on host port 5433
with a `pg_isready` healthcheck. `package.json` has `db:up`, `db:migrate`, `db:push`,
`db:seed`. No migrations exist. Only `prisma/seed.ts` uses Prisma.

**Deliverables**

- `docker-compose.yml`: `postgis/postgis:16-3.4`, same port, volume and healthcheck.
- `prisma/migrations/00000000000000_baseline/migration.sql`, generated from the
  datamodel and reviewed by hand, beginning with
  `CREATE EXTENSION IF NOT EXISTS postgis;` (before any geography column) and
  `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (Phase 3 uses it for name similarity).
- `prisma/migrations/migration_lock.toml`.
- CI: a PostGIS service, `prisma migrate deploy` on an empty database, and a drift
  guard (`prisma migrate diff --from-migrations ... --exit-code`).
- `npm run db:reset` and a short "database" section in `README.md`.

**Milestones**

- `M0.1` Compose image swapped; `npm run db:up` healthy and `SELECT PostGIS_Version()`
  returns a row.
- `M0.2` Baseline migration applies to an empty database; `prisma migrate status` clean.
- `M0.3` Drift guard in CI fails when the schema changes without a migration.

**Acceptance criteria**

- `docker compose up -d postgres && npx prisma migrate deploy` exits 0 on a clean volume.
- `npx prisma migrate status` reports up to date.
- The drift guard fails for a deliberately edited schema with no migration (tested in CI).
- `npm run db:push` still works and is documented as non-authoritative.
- `prisma/migrations/**` is committed.

**Migration / cutover.** No data exists and no runtime code reads Prisma, so this is
pure addition. Rollback is dropping the volume; nothing depends on it yet.

## Phase 1 — canonical property and listing model

**Objective.** One row per real accommodation, many source listings, provenance
intact, unknown fields genuinely null.

**Current state.** `ProspectListing` and `ProspectObservation` hold source-scoped
observations. `InventoryPartner`/`Unit`/`UnitNight` hold signed, sellable supply.
There is no `Property`, `Operator`, `Amenity`, `PriceObservation`, `SourceRegistry`
or `MatchDecision`.

**Deliverables — additive Prisma models**

- `Property` — the physical accommodation. `id`, `canonicalName?`, `propertyType?`,
  `bedrooms?`, `bathrooms?`, `maxGuests?`, `stateCode?`, `areaId?`, `addressLine?`,
  `latitude?`/`longitude?`, `locationPrecision?`, `geocodeConfidence?`,
  `canonicalSourceListingId?`, timestamps. Every attribute nullable: a property may
  legitimately be known as "a 3-bed in Ikeja" and nothing more.
- `Operator` — `id`, `displayName`, `normalizedName`, `phoneNormalized?`, `email?`,
  `websiteDomain?`, `stateCode?`, `partnerId?` (set only when signed),
  `firstSeenAt`/`lastSeenAt`. Not unique on name; names collide, and `MatchDecision`
  is what links them.
- `SourceListing` — `ProspectListing` renamed at the model level with
  `@@map("ProspectListing")`, plus `propertyId?`, `operatorId?`, `sourceRegistryId`,
  `city?`, `priceBasis`, `roomTypeId?`, `rawSnapshotRef?`, `parserVersion`,
  `normalizedAt`. Keeps `@@unique([source, sourceListingId])`.
- `PriceObservation` — append-only: `sourceListingId`, `amountKobo?`, `currency`,
  `basis` (`PER_NIGHT|PER_STAY|PER_PERSON_NIGHT|UNKNOWN`), `nights?`, `guests?`,
  `taxesIncluded?`, `feesIncluded?`, `observedAt`, `sourceUrl`. A price change is a
  new row; there is no update path.
- `RoomType` — internal research only: source wording, `maxGuests?`, `bedrooms?`,
  `bathrooms?`, `sleeps?`. Never rendered publicly (ground rule 3).
- `Amenity`, `AmenityAlias`, `SourceListingAmenity` — taxonomy row, source wording
  alias, and the mapping with `mappingVersion`, `confidenceBps`, `decidedBy`
  (`RULE|HUMAN`). Unique on `(sourceListingId, amenityId)`.
- `SourceRegistry` — `key` unique, `displayName`, `ownerLegalName?`,
  `regions String[]`, `accessMethod`, `termsStatus`, `termsUrl?`,
  `robotsPolicySnapshot?`, `attributionRequirement?`, `rateLimitPerMinute?`,
  `contactEmail?`, `lastReviewedAt?`, `reviewedBy?`.
- `MatchDecision` — `leftType`/`leftId`, `rightType`/`rightId`, `strategy`,
  `ruleVersion`, `scoreBps`, `decision`
  (`AUTO_MERGED|REVIEW_APPROVED|REVIEW_REJECTED|SPLIT|LEFT_SEPARATE`),
  `evidence Json`, `decidedBy?`, `decidedAt`, `reversedByDecisionId?`.
- `AvailabilitySignal` — `propertyId?`/`unitId?`, `state`
  (`AVAILABLE|UNAVAILABLE|UNKNOWN|REQUIRES_CONFIRMATION`), `source`, `observedAt`,
  `expiresAt?`, `confidenceBps?`. Keeps crawl-derived availability out of `UnitNight`,
  which stays partner-only.

Also:

- `src/domain/inventory.ts` — pure types and parsers mirroring the above, with tests.
  `src/domain/**` still imports nothing.
- `services/acquisition/publishing.py --publish canonical.ndjson` — internal export
  carrying `source_listing_id`, `price_basis`, amenity wording and `operator_key`.
  Gitignored like the other pipeline output; the public `directory.json` contract is
  unchanged.
- Amenity taxonomy seed (shortlet-realistic: 24h power, generator, inverter/solar,
  borehole water, security, gated estate, parking, furnished, AC, WiFi, kitchen,
  washing machine, pool, gym, workspace, lift, balcony, pets, serviced cleaning,
  breakfast, wheelchair access, smoking, short-stay allowed).

**Milestones**

- `M1.1` `Property`, `Operator`, `SourceListing` migration with the `@@map` rename.
- `M1.2` `PriceObservation`, with the existing observation ledger imported.
- `M1.3` Amenity taxonomy and mapping tables seeded.
- `M1.4` `SourceRegistry` plus the Python loader that gates a connector on it.
- `M1.5` `MatchDecision` and reversible merge/split helpers.

**Acceptance criteria**

- A `Property` can be stored with every attribute null except id and timestamps.
- Two listings pointing at one property and three at another yields 2 properties and
  5 listings; deleting a listing does not delete the property (explicit `onDelete`).
- `PriceObservation` is append-only and a price change creates a second row (test).
- Python row → JSON → TS parse → Prisma field mapping round-trip loses no field, and
  a missing basis maps to `UNKNOWN`, never to `PER_NIGHT`.
- The existing 241 TypeScript and 72 Python tests still pass unchanged.

**Migration / cutover.** Additive. The `@@map` rename needs no DDL change. New FKs are
nullable; no `NOT NULL` is added to a populated table in this release.

## Phase 2 — source discovery and compliant ingestion

**Objective.** Every run produces auditable crawl records, and a source's permission
to be crawled is a database fact rather than prose in a README.

**Current state.** `sources/base.py` (adapter protocol + registry) and `sources/npc.py`;
`providers.py` with `stdlib | playwright | firecrawl | fixture`; `GuardedProvider`
running robots → throttle → provider → `strip_media()`; `compliance/` holding robots,
per-host rate limit, `ALLOWED_FIELDS`/`FORBIDDEN_FIELDS`, media stripping;
`pipeline.py` with `--source --state --area --fixture --transport --discover --ledger
--publish --dump-html --interval`; outputs `leads.jsonl`,
`listing-observations.jsonl`, `directory.json`; `LEAD_RETENTION_DAYS`.

**Deliverables**

- `ingest/envelope.py` — one `ObservationEnvelope` every connector returns:
  `source_key`, `source_listing_id`, `source_url`, `observed_at`, `fetched_at`,
  `parser_version`, `fields` (allowlisted only), `snapshot_sha256`, `snapshot_ref?`,
  `http_status?`, `outcome`. Connectors stop returning ad-hoc dictionaries.
- `CrawlRun` and `CrawlOutcome` tables — run id, source_key, scope (state/area),
  started/finished, transport, `git_sha`, `parser_version`, and counters that
  reconcile with the funnel printed today: discovered, fetched, parsed,
  field_incomplete, parser_failed, robots_denied, rate_limited, http_error,
  newly_listed, changed, unchanged, delisted.
- Snapshot retention — bytes keyed by SHA-256 in object storage (local-disk shim in
  dev), hash and reference in Postgres, per-source retention days, and a deletion job
  that records what it deleted (`RetentionAction`).
- Registry-driven permission — a connector refuses to run when
  `SourceRegistry.termsStatus != PERMITTED`. A robots denial writes
  `CrawlOutcome(outcome='ROBOTS_DENIED')` and never an observation. A takedown sets
  `PROHIBITED` and suppresses that source's rows in a single run.
- `pipeline.py --ingest db [--dry-run] [--limit N]` writing canonical rows through
  the Phase 1 schema, idempotent on `(source, source_listing_id)`.
- Job table `CrawlJob` (priority, `run_after`, `attempts`, `locked_at`, `locked_by`)
  plus per-source concurrency and a circuit breaker: N consecutive failures pauses the
  source and records a health note. Postgres before a broker — one fewer moving part
  until there is a measured need.

**Milestones**

- `M2.1` Envelope type and outcome ledger wired through NPC parsing.
- `M2.2` Registry gate on every connector.
- `M2.3` Snapshot hashing, storage and the retention job.
- `M2.4` Job table, per-source concurrency and circuit breaker.
- `M2.5` A second connector (`propertypro.py`) proving parsing is source-agnostic.

**Acceptance criteria**

- A fixture run produces exactly one `CrawlRun` and one `CrawlOutcome` per page, with
  counters that reconcile to the funnel output.
- A source with `termsStatus = UNREVIEWED` performs zero HTTP calls (asserted with an
  injected provider that throws if used).
- A parser failure is an outcome row with a snapshot hash — never a silent skip and
  never a partial row.
- `ALLOWED_FIELDS` remains the only source of extractable fields: naming a new field
  requires editing the allowlist, and an import-time test proves the Exa schema is
  still derived from it.
- The retention job deletes bytes, keeps the hash row, and a zero-day policy is tested.
- `--dry-run` writes no rows and still prints the counters.

**Migration / cutover.** Dual-write: the pipeline keeps writing `directory.json`
while also inserting canonical rows. Readers are untouched, so rollback is stopping
the write side.

## Phase 3 — geocoding, entity resolution and deduplication

**Objective.** One canonical property per real place, with recorded confidence, a
review path, and reversible decisions.

**Current state.** `normalization/dedupe.py` is a union-find over strong signals
(phone, email, website/email domain) and one weak signal (normalized name + area),
producing `operatorKey`. `names.py`, `phones.py` and `addresses.py` normalize values.
There is no geocoder, no coordinates on prospect rows, no LGA/locality reference data,
no review queue, and no way to reverse a merge.

**Deliverables**

- Reference tables `Lga` (code, name, stateCode) and `Locality` (lgaCode, name,
  aliases, centroid geog, `source`), seeded from a versioned CSV in
  `prisma/seed-data/` with a recorded `datasetVersion`.
- `GeocodeResult` — `subjectType`/`subjectId`, `provider`, `queryHash`, `confidenceBps?`,
  `precision` (`ROOFTOP|BUILDING|STREET|NEIGHBOURHOOD|LOCALITY|CITY|CENTROID`),
  `geog`, `formattedAddress?`, `geocodedAt`, `expiresAt?`. Cached by query hash so a
  retry does not re-bill.
- One geocoder contract with two callers: Python for bulk backfill, TypeScript for
  on-demand geocoding during ingest. The provider is configurable — a licensed Nigerian
  dataset is preferred, a paid provider is the fallback, and public Nominatim is used
  only if its usage policy permits it.
- Candidate generation in SQL: `pg_trgm` similarity on normalized name, equality on
  normalized phone/email/domain, `ST_DWithin(geog, 250m)`, shared `areaId`. The score
  is a weighted sum with weights and `ER_RULE_VERSION` held in code.
- Staged policy: `>= 8500 bps` auto-merge, `5000–8499` review queue, `< 5000` left
  separate. Thresholds are configuration, not constants, so they can be tuned with the
  audit trail intact.
- Review queue: an internal-only route (`/api/match-review`, gated by
  `INTERNAL_API_TOKEN`, or omitted from production builds) plus a bulk CLI in
  `services/acquisition`. Approve/reject writes `MatchDecision`.
- `mergeProperties(left, right)` re-parents `SourceListing.propertyId` and never
  deletes a listing or an observation; `splitProperty(property, listingIds)` reverses
  it. Both write `MatchDecision` rows with their evidence.

**Milestones**

- `M3.1` LGA/locality reference data seeded.
- `M3.2` Geocoder contract, provider adapter and cache.
- `M3.3` Candidate SQL and scoring with `ER_RULE_VERSION`.
- `M3.4` Review queue (CLI + internal route).
- `M3.5` Merge/split with audit.
- `M3.6` Backfill existing `operatorKey` groupings into `Operator`.

**Acceptance criteria**

- Dense-urban fixture: two distinct properties 80 m apart, with different names and
  phones, do **not** auto-merge. Proximity alone must never merge.
- The same property described on two portals, with different names but the same
  normalized phone, auto-merges with a `MatchDecision` row carrying strategy, version
  and score.
- Every auto-merge is reversible by one `splitProperty` call, and after reversal each
  listing still carries its original claims and price observations.
- `precision` is stored, and a `NEIGHBOURHOOD` result cannot be rendered as an exact
  pin (asserted in the Phase 5 map layer).
- Operator backfill reports `COUNT(Operator)` per state against the previous
  `operatorKey` grouping, with any difference enumerated rather than absorbed.

**Migration / cutover.** New tables and nullable FKs; no existing column changes
semantics. The Python union-find keeps producing `operatorKey` until the backfill is
verified, then becomes a fallback rather than the source of truth.

## Phase 4 — PostGIS-backed inventory layer

**Objective.** Durable, queryable canonical inventory behind the existing
`Repository` contract, with no public behavior change yet.

**Current state.** `Unit` carries `latitude`/`longitude` floats and a commented-out
`geog` field with instructions. `src/domain/geo.ts` does a two-stage bounding-box
filter then haversine. `src/server/store.ts` defines `Repository` with an in-memory
implementation; `src/server/container.ts` chooses it. There is no PostGIS, no
Prisma-backed repository and no ingest writer.

**Deliverables**

- `geog Unsupported("geography(Point, 4326)")?` on `Property` and `Unit` (validated
  against Prisma 6.3.0).
- Hand-written migration SQL: backfill with
  `UPDATE ... SET geog = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography`,
  then `CREATE INDEX property_geog_idx ON "Property" USING GIST (geog);` and the
  equivalent for `Unit`. Prisma cannot express GiST, so this SQL is reviewed like code.
- Text search: a `pg_trgm` GIN index over a normalized-name expression, or a generated
  `tsvector`. Search predicates live in SQL rather than as application-side filters
  over a full table read.
- `PrismaRepository` implementing the existing `Repository` interface, selected by
  `REPOSITORY_DRIVER = memory | prisma` in `src/server/container.ts`. The in-memory
  implementation stays for tests.
- An ingest writer (`pipeline.py --ingest db`) upserting canonical tables, idempotent
  on `(source, source_listing_id)`.
- Freshness views: `current_price_observation` (latest per listing),
  `listing_freshness` (age against per-source TTL), `stale_sources`.
- Database roles: `house3_ingest` (write canonical and prospect tables), `house3_api`
  (`SELECT` only plus `statement_timeout`), `house3_migrator` (DDL). Secrets stay in
  env; `PartnerChannel.config` never holds them.
- Backup and restore runbook: nightly `pg_dump`, a PITR note, and an executed restore
  rehearsal into a scratch database.

**Milestones**

- `M4.1` Extension, `geog` columns, backfill and GiST indexes.
- `M4.2` Trigram/text-search indexes.
- `M4.3` `PrismaRepository` passing the `Repository` contract suite.
- `M4.4` Ingest writer with idempotency tests.
- `M4.5` Freshness views.
- `M4.6` Roles, backup and a completed restore rehearsal.

**Acceptance criteria**

- A radius query via `ST_DWithin` returns exactly the same set as
  `src/domain/geo.ts` bbox+haversine for a fixed fixture. Two implementations that
  disagree is a bug, not a rounding difference.
- The `Repository` contract test suite passes unmodified against both drivers.
- `prisma migrate diff --exit-code` is clean after the hand-written SQL, proving the
  SQL matches the datamodel.
- Running the same ingest fixture twice leaves row counts and latest observations
  unchanged.
- A restore from backup into a scratch database reproduces row counts and passes the
  parity test.
- `house3_api` cannot write (an attempted insert fails) and cannot run an unbounded
  query (`statement_timeout` enforced).

**Migration / cutover.** No public reader switches in this phase. `/places` and
`/api/search` keep their current sources, so the database can be proven in shadow
without risking a live surface. The repository driver flag exists but defaults to
`memory`.

## Phase 5 — search, maps and availability semantics

**Objective.** Serve discovery from canonical inventory while stating exactly how fresh
and how verified each answer is.

**Current state.** `/api/search` runs over the in-memory repository. `src/domain/geo.ts`
does bounding-box then haversine. `checkAvailability()` returns explicit reasons rather
than a boolean. `UnitNight` holds per-night partner state (`OPEN|CLOSED|ON_REQUEST`).
There are no map endpoints, no clustering, no coordinate-precision policy, and no
freshness field in responses.

**Deliverables**

- A search service over the repository with filters: state/area, dates, guests, price
  band plus basis, amenities (taxonomy IDs), room type, unit type, and distance/bbox.
  A page cap is enforced; an unbounded query is rejected rather than run.
- Map endpoints: `GET /api/map?bbox=&zoom=&filters…` returning clusters at low zoom and
  precise points at high zoom, clustered server-side (grid or `ST_ClusterDBSCAN`) so
  dense Lagos does not melt the client.
- Coordinate-precision policy in one tested module: `ROOFTOP`/`BUILDING` may render an
  exact pin; `NEIGHBOURHOOD`/`LOCALITY` are deterministically jittered (stable per
  property, seeded by id) or omitted from the exact layer; `CITY`/`CENTROID` render no
  pin at all.
- Provenance and freshness in every response: `observedAt`, `lastVerifiedAt`,
  `freshness` (`LIVE|RECENT|STALE|UNKNOWN`) computed from per-source TTL against an
  injected clock, `priceBasis`, `isIndicative` (true for anything observed rather than
  quoted), `sourceName`, `attribution`.
- Availability semantics: `AVAILABLE|UNAVAILABLE|UNKNOWN|REQUIRES_CONFIRMATION`.
  Crawl-derived signals can only produce `UNKNOWN` or `REQUIRES_CONFIRMATION`; only a
  partner channel can produce `AVAILABLE`. This is a guard with tests, in the same shape
  as `assertBookable()`.
- Caching: per-source TTL, cache key includes the filter hash, invalidation on ingest
  completion, stale-while-revalidate for directory-style reads.
- `SEARCH_DRIVER` flag, so flipping the read path is a config change with an instant
  rollback.

**Milestones**

- `M5.1` Search over the repository, behind the flag.
- `M5.2` Map endpoint with server-side clustering.
- `M5.3` Coordinate-precision policy.
- `M5.4` Freshness and provenance fields.
- `M5.5` Availability states and the crawl-cannot-say-AVAILABLE guard.
- `M5.6` Caching, then the flag flip.

**Acceptance criteria**

- A `DIRECTORY` row and a `ProspectListing` can never appear in `/api/search` results —
  asserted against the SQL driver, not only memory.
- A crawl-sourced availability signal cannot be `AVAILABLE`, and a unit in
  `REQUIRES_CONFIRMATION` never renders an instant-book call to action.
- Every result carries `observedAt` and `freshness`; a source past its TTL reports
  `STALE` rather than "today", proven with an injected clock.
- The map endpoint refuses a bbox wider than a configured cap (or returns clusters
  only), with a test.
- Both drivers return the same result IDs for a fixed fixture, and the flag flip is
  reversible in one env change.

**Migration / cutover.** The flag flip is the cutover. JSON stays the fallback for one
release, and the shadow comparison from Phases 1–2 has to be clean before the flip.

## Phase 6 — partner connectivity for live availability and booking

**Objective.** Partner systems are the authority for live rates and booking outcomes,
with explicit mappings and scheduled reconciliation.

**Current state.** Four adapters behind `PartnerInventoryAdapter` (`PARTNER_API`,
`ICAL_FEED`, `PARTNER_DASHBOARD`, `AFFILIATE_PROGRAM`), gated by `assertAuthorized()`
and an `AuthorizationRecord`. `PartnerApiAdapter.pushReservation()` already sends an
`Idempotency-Key`. `PartnerChannel` stores authorization metadata. Holds and the booking
state machine exist, and `WebhookEvent` has a unique index on `(processor, signature)`
for replay protection.

**Deliverables**

- Mapping tables `PartnerPropertyMap`, `PartnerUnitMap` and `PartnerRatePlanMap`:
  partner id plus external id → House3 id, unique per partner, with `verifiedAt` and
  `verifiedBy`. A mapping is a claim, so it needs an owner and a date.
- `RatePlan`: partner rate plan id, unit, currency, basis, cancellation policy
  reference, min/max nights — so every quoted rate names the plan it came from.
- `BookingOperation`: bookingId, operation (`HOLD|CONFIRM|CANCEL|STATUS`), partner,
  unique `idempotencyKey`, request hash, attempt count, result, `partnerRef`, timings.
  This drives retries and the reconciliation report.
- Partner webhook endpoint `POST /api/webhooks/partner/[partnerId]`: per-partner
  signature verification, dedup on `(partnerId, eventId)`, replay-safe, with our own
  outbound retries and backoff.
- A reconciliation job comparing House3 bookings with partner status over a rolling
  window. Mismatches become `ReconciliationIssue` rows and alerts; a booking is never
  silently "corrected" without a recorded decision.
- Fallback policy: a partner that is unreachable, or a feed older than its TTL, degrades
  the unit to `ON_REQUEST`/`REQUIRES_CONFIRMATION` and disables instant booking. It
  never fabricates `AVAILABLE`.

**Milestones**

- `M6.1` Mapping tables plus a verification CLI.
- `M6.2` `BookingOperation` with idempotency tests.
- `M6.3` Partner webhooks with signature verification and dedup.
- `M6.4` Reconciliation job and `ReconciliationIssue`.
- `M6.5` Fallback policy wired into search and checkout.

**Acceptance criteria**

- Unique constraints prevent two House3 units binding to one partner unit, and one unit
  binding twice to the same partner.
- Replaying the same webhook, or the same `pushReservation` call, is a no-op — extending
  the existing Paystack replay protection to partner traffic.
- A drift fixture (partner says CANCELLED, we say CONFIRMED) produces exactly one
  reconciliation issue and one alert event, and does not change booking status
  automatically.
- `assertAuthorized()` remains the only gate: an expired or wrong-basis authorization can
  neither fetch nor push.
- A partner outage degrades the unit to `ON_REQUEST`, with a test asserting that no
  `AVAILABLE` is produced.

**Migration / cutover.** Additive tables. The booking service keeps working through
`Repository`, and the partner path is exercised only when a channel is configured, so
disabling a channel is the rollback.

## Phase 7 — payments, commissions, monitoring and nationwide expansion

**Objective.** Commercial correctness for affiliate inventory, operational visibility,
and a regional gate that is code rather than a checklist someone remembers.

**Current state.** The pricing engine, `FeePolicy` rows, `src/domain/splits.ts` and
`LedgerEntry` cover bookings settled through House3, with Paystack and Flutterwave.
`ROLLOUT.md` holds six manual gates. There is no affiliate commission ledger, no metrics
pipeline, and alerting exists only as prose.

**Deliverables**

- `CommissionAccrual`: partner/programme, source listing, partner-reported booking
  reference, `basis` (`CPS|CPA|CPC`), `rateBps` or flat kobo, `grossKobo`, `accruedKobo`,
  `status` (`EXPECTED|REPORTED|INVOICED|PAID|WRITTEN_OFF`), `evidenceRef`. Separate from
  `LedgerEntry`, because no guest payment flows through House3 for affiliate inventory.
- A disclosed affiliate pricing rule: the UI shows the partner's price only as
  "partner price, seen <date>", never as a House3 total, and never beside a House3
  service fee — we are not the merchant of record. Encoded as a display type with a
  test, mirroring `assertBookable()`.
- Metrics: a `MetricSnapshot` table plus a nightly job computing crawl success per
  source, parse quality and field completeness, duplicate rate, geocode precision mix,
  freshness age distribution, partner API latency and error rate, quote→paid conversion,
  payment failure rate, and reconciliation backlog. Each metric has exactly one SQL
  definition committed under `services/analytics/`.
- Alerts: `AlertRule` rows evaluated by the same job, with a pluggable notifier (log
  first, Slack or email later). Rules cover parser breakage (field-completeness drop),
  abrupt source change (listing-count delta), stale inventory, per-state coverage gap,
  partner outage, and reconciliation backlog.
- Ops queues with an owner and an SLA: match review, reconciliation issues, takedown
  requests, data-quality failures.
- Takedown and correction procedure: `termsStatus = TAKEN_DOWN` suppresses the source's
  rows in one run, deletes snapshot bytes, records `RetentionAction`, and generates a
  report for the requester.
- Expansion gate automation: the six gates in `ROLLOUT.md` become
  `scripts/expansion-gate.ts`, querying the database and exiting non-zero when unmet —
  supply floor, confirmation rate, ledger balance, chargebacks, support load, payout
  timeliness.

**Milestones**

- `M7.1` Commission accrual with reproducibility tests.
- `M7.2` Disclosed affiliate pricing type.
- `M7.3` Metric definitions and the nightly job.
- `M7.4` Alert rules and the notifier.
- `M7.5` Ops queues.
- `M7.6` Takedown and retention automation.
- `M7.7` Expansion gate script.

**Acceptance criteria**

- Commission accrual recomputes identically from stored terms; no rate is ever assumed
  in code.
- An affiliate row can never render a House3-style total or fee — a test asserts the
  affiliate pricing display type rejects a House3 quote.
- Every metric has a committed definition and a non-null `computedAt`, and the job is
  idempotent for a given day.
- Each alert rule fires on a deliberately broken fixture and stays quiet on a healthy
  one — rules are tested, not merely written down.
- A takedown fixture removes that source's rows from the public projection within one
  run and records a `RetentionAction`; a re-run is a no-op.
- The expansion gate exits non-zero for a state below the supply floor, and zero once a
  fixture satisfies all six gates.

**Migration / cutover.** Additive tables and jobs. Nothing in Phases 1–6 changes
behavior here; this phase makes the money and the health of the pipeline legible.

## Test and CI strategy

- **Baseline stays green.** 241 TypeScript and 72 Python tests are the floor. Each phase
  adds tests; an existing test is never rewritten to accommodate a regression.
- New test layers:
  - repository contract tests run against both drivers (`memory`, `prisma`);
  - SQL parity tests (bbox vs `ST_DWithin`), so the two geo implementations cannot drift;
  - migration tests that apply the baseline plus every migration to an empty PostGIS
    service and assert `migrate diff --exit-code` is clean;
  - fixture-based parser tests, kept offline with `--transport fixture`, so CI never
    depends on a live portal;
  - property-based tests for merge/split idempotency and commission accrual.
- CI additions, in order: PostGIS service container → `prisma migrate deploy` → drift
  guard → `npm run typecheck` → `npx vitest run` → `npm run build` →
  `python -m pytest -q`.

## Risks and open decisions

| Risk / decision | Impact | Mitigation | Phase |
|---|---|---|---|
| PostGIS image swap invalidates dev volumes | Local DB stops working | Documented volume recreate; CI uses a fresh service container | 0 |
| Prisma `Unsupported` fields are invisible to Prisma Client | Writes need raw SQL | Small tested SQL helper for geometry reads and writes | 4 |
| A false merge joins two real properties | Most expensive data bug: a guest books the wrong flat | Conservative thresholds, review queue, reversible decisions, dense-urban regression fixture | 3 |
| Geocoder provider licence and cost | Blocks M3.2 | Decide before starting; licensed dataset preferred, paid provider as fallback, cache by query hash | 3 |
| Snapshot object storage choice | Blocks M2.3 | Local-disk shim keeps dev working; the key is a SHA-256 hash, so the backend can change later | 2 |
| Queue technology choice | Adds operational surface early | Postgres job table first; adopt a broker only on measured need | 2 |
| `Property` vs `Unit` boundary | Ambiguity produces duplicate canonical rows | `Property` is physical; `Unit` is a partner's sellable inventory and points at exactly one property | 1 |
| Should `/places` read the database at all? | Scope of the cutover | Yes, after shadow parity; JSON stays the fallback for one release | 4–5 |
| Affiliate commission basis | Wrong revenue numbers | Stored as programme terms rows, never assumed in code | 7 |
| Source legal review | Crawling a source we may not | `SourceRegistry.termsStatus` is the gate; a human decision with reviewer and date is recorded | 2 |

## Definition of done (every phase)

- Migration(s) committed, applying cleanly to an empty database, with the drift guard clean.
- Tests added for every new invariant, and the full baseline suite still passes.
- Docs updated in the same commit (`README.md`, `ARCHITECTURE.md`, `ROLLOUT.md`,
  `services/acquisition/README.md` as applicable).
- New failure modes are recorded as rows (outcomes, issues, metrics), not merely logged.
- A rollback or forward-fix path is stated, and exercised wherever data changes.
- No rule in the Ground rules table is weakened.

## Explicitly out of scope

Real partner contracts, content-licensing deals, payment processor commercial terms, and
the actual per-source legal permissions are business steps. This plan builds the machinery
that makes those steps safe to take; it does not take them.


