# House3 — Nigerian shortlet discovery & referral

House3 is a **discovery and referral platform** for Nigerian shortlets. It crawls the
listings operators publish themselves, shows a guest the operator's own photographs, the
rate they published and every other fact it observed — and then sends the guest to the
operator to arrange the stay.

**House3 does not take payments, does not process bookings, promises no availability and
is not the merchant of record.** There is no payment code in this repository, no
processor key it reads, and no fee it charges. A guest decides, contacts the property, and
pays them directly. What the platform provides is coverage: the work of finding out who
operates what, where, and at what rate.

**Launch coverage:** Lagos → Abuja (FCT) → Oyo → Imo → Akwa Ibom, then the remaining
31 states + FCT.

---

## What a guest does

```
Homepage              observed places, with the operator's own photographs
  -> View
/stay/{source}:{id}   the gallery, every observed detail, the published rate,
                      and the ranked ways to reach the operator
  -> Call / WhatsApp / operator site / source listing
The operator. Not House3.
```

## How the money works

It does not, and that is the design. The table below is what the platform used to do and
has been removed:

| Concept | Status |
|---|---|
| Operator's published rate | **Observed.** Shown as "the rate the operator published", attributed to the source, with the date we saw it. |
| Service fee | **Does not exist.** Removed with the payment layer. |
| VAT on a service fee | **Does not exist.** There is no supply of ours to tax. |
| Processor fee | **Does not exist.** Nothing is processed. |
| A payable total | **Does not exist.** No page renders one, and no code path can produce one. |

`src/domain/pricing.ts` and `src/domain/splits.ts` still hold the arithmetic, fully unit
tested, with no caller in the UI. They are kept for a transaction business that may come
later; `src/domain/contact.ts` is what the product expresses today and what every page
uses.

**The guest always knows whose rate they are looking at and who to call.**


**The guest always sees the breakdown, and the operator is always named on the listing.**
That is not a nicety — it is what makes operators willing to sign, keeps the merchant
account alive with Paystack/Flutterwave, and keeps pricing on the right side of the
FCCPC's misleading-pricing rules. The margin is identical to a hidden markup; the
difference is that it survives contact with a chargeback team.

## How inventory is sourced

Two layers, deliberately separate.

### Bookable inventory — consented channels (`src/inventory/`)

| Channel | Authorization basis | Booking model |
|---|---|---|
| `PARTNER_API` | API credentials issued by the operator (Smoobu, Beds24, Hostaway, Lodgify…) | book & settle |
| `ICAL_FEED` | operator publishes a calendar URL | book & settle |
| `PARTNER_DASHBOARD` | operator (or our onboarding agent, on their instruction) enters units under a supply agreement | book & settle |
| `AFFILIATE_PROGRAM` | accepted into the partner's own affiliate programme | redirect to partner checkout |

`assertAuthorized()` runs at the top of every adapter fetch and **throws** when the
authorization record is missing, stale, or of the wrong basis for the channel. A
non-consented channel name (e.g. `SCRAPER`) is rejected by the registry.

### Prospects and the directory — `services/acquisition/`

A crawl **cannot** produce inventory: there is no signed agreement, no settlement
account and no live calendar, so nobody could confirm a booking made against it. What
it produces is *coverage* — which operators exist, where, with how many units, at what
advertised rate, and how that has moved since we started watching (`--ledger`).

That splits into two outputs:

- **A lead list** (`leads.jsonl`) that feeds operator outreach.
- **The public directory** (`directory.json`) rendered at `/places`.

**Publishing publishes facts, not creative work.** An operator's name, phone, area,
bedroom count and advertised price are facts about a business, and nobody owns a fact —
so every row carries `attribution` and links back to `sourceUrl`, and the pipeline
**fails the run** without them. A photograph and a written description are different:
they have an owner, and republishing either is not made lawful by the page being
reachable — whether we fetched it ourselves or paid an API to fetch it. Those are
stripped at the fetch boundary, refused at the extraction boundary, and refused again
at the publish boundary.

`media: null` on every directory row means "we hold no licence to show photographs of
this place". Photographs arrive when the operator claims the listing under a supply
agreement. The directory card therefore renders a designed panel rather than a stock
photo of a different apartment — a guest who calls because of that photo would have
been misled about the room.

A prospect's advertised rate is never shown as a price we can charge: `assertBookable()`
in `src/domain/provenance.ts` makes that a type error, not a policy.

---

## Layout

```
src/domain/      pure, fully tested business logic (money, dates, pricing, splits,
                 availability, booking state machine, media licensing, provenance)
src/inventory/   authorised supply channels + the authorization guard
src/payments/    Paystack (subaccounts + split) and Flutterwave (split ratios)
src/server/      booking orchestration, repository contract, in-memory store, demo data,
                 directory loader
src/data/        Nigeria rollout plan + fee policies
services/acquisition/  the crawl: compliance, sources, extraction, normalization,
                 publishing (Python; writes leads.jsonl + directory.json)
prisma/          production PostgreSQL schema + seed
tests/           241 TypeScript tests; services/acquisition has 88 Python tests
```

## Quick start

```bash
npm install
npm test                 # 241 TypeScript tests
npm run typecheck

# optional: real database
npm run db:up            # docker compose postgres on :5433
npm run db:deploy        # apply committed, authoritative migrations
npm run db:seed
npm run db:studio
```

The local database uses `postgis/postgis:16-3.4`. `db:push` remains available for
throwaway experiments, but committed migrations and `db:deploy` are authoritative.
Use `npm run db:migrate` only when developing a new migration, `npm run db:status`
to inspect migration state, and `npm run db:reset` to recreate a local database.
Discovery records are written with the acquisition pipeline's explicit database
ingest mode; a crawl never becomes bookable inventory merely by being ingested.

For production, set `DATABASE_URL` to the managed PostgreSQL connection string
from the deployment secret store (Aiven/Neon/etc.) and use SSL. The managed
PostgreSQL database is the authoritative store for properties, operators,
availability, bookings, payments, and ledger data. Turso is not wired as the
primary database; it may be added later as a separately defined read model or
edge cache without changing the source of truth.

Copy `.env.example` to `.env` before touching a processor. Nothing in `src/domain`
reads the environment — pricing is injected, which is why the tests are deterministic.

### Moving the same schema to a managed PostgreSQL (Aiven)

The local container and Aiven must hold the **same committed migration** — never a
copy of local data. The local database is disposable once the migration has been
proven against it; what travels is `prisma/migrations/**`.

```bash
# 1. point at Aiven, with SSL. Secret store only; never commit it.
export DATABASE_URL="postgresql://avnadmin:…@pg-xxxx.aivencloud.com:12345/defaultdb?sslmode=require"

# 2. the committed baseline, against an empty database
npx prisma migrate deploy

# 3. prove the schema landed, rather than that the command exited 0
psql "$DATABASE_URL" -c "SELECT PostGIS_Version()"
psql "$DATABASE_URL" -c "SELECT extname FROM pg_extension ORDER BY 1"
psql "$DATABASE_URL" -c "SELECT indexname FROM pg_indexes WHERE indexname IN ('Property_geog_gist_idx','Operator_normalizedName_trgm_idx')"
npm run db:status

# 4. smoke-ingest a small slice, then read it back
python services/acquisition/pipeline.py --source npc --state LA --interval 5 --max 25 --ingest db --limit 25
```

`CREATE EXTENSION postgis`/`pg_trgm` run inside the baseline migration, so the
connecting role needs permission to create them. On Aiven the default admin user
has it; if it does not, enable the extension from the Aiven console and re-run
step 2.

Expected after step 4, as counts:

| Expectation | Why |
|---|---|
| `ProspectListing` > 0 | the crawl was persisted |
| `Property` = 0 | discovery does not claim canonical properties |
| `Unit` = 0 | discovery is not bookable inventory |
| `Operator` = 0 | no operator is invented from a weak signal |
| running step 4 twice leaves every count identical | ingest is idempotent on `(source, sourceListingId)` |

`DATABASE_URL` carries Prisma's `?schema=public`, which libpq rejects outright.
The pipeline strips Prisma-only parameters before psycopg connects, so one
variable serves both tools.

## Documentation

- `ARCHITECTURE.md` — data flow, invariants, why each layer exists
- `IMPLEMENTATION_PLAN.md` — phased path from the current JSON directory to PostgreSQL/PostGIS inventory
- `ROLLOUT.md` — state-by-state operating plan

## Status

Implemented and tested: domain engine, authorized inventory layer, both payment
integrations, booking funnel, split ledger, Nigeria rollout data, PostgreSQL schema.

Not yet built: the Next.js UI on top of the API routes, partner-facing onboarding
dashboard, refunds/partial refunds UI, Channel Manager push-back, and admin reporting.
