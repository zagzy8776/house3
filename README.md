# House3 — Nigeria shortlet & hostel booking platform

House3 aggregates shortlet apartments, serviced flats and hostel beds across Nigeria,
takes the guest's payment once, and settles the operator's share straight into the
operator's own bank account. The platform's revenue is a **disclosed service fee**.

**Launch coverage:** Lagos → Abuja (FCT) → Oyo → Imo → Akwa Ibom, then the remaining
31 states + FCT.

---

## How the money works

This is the core of the product, so it is stated plainly.

| | Amount | Goes to |
|---|---|---|
| Room subtotal (`roomSubtotalKobo`) | the operator's own published rate | **the operator** |
| Cleaning / turnover passthrough | the operator's own fee | **the operator** |
| House3 service fee | % of room revenue, min/max capped, NGN 50 rounding | **House3** |
| VAT on the service fee (7.5%) | Nigerian VAT on *our* supply only | **House3** |
| Processor fee (e.g. 1.5% + NGN 100, capped NGN 2,000) | configured bearer | processor |

Worked example — a Lagos operator advertises **NGN 150,000** for one night:

```
Room (1 night)               NGN 150,000.00   -> operator
Cleaning & turnover           NGN  10,000.00   -> operator
House3 service fee (12%)      NGN  18,000.00   -> House3
VAT on service fee (7.5%)     NGN   1,350.00   -> House3
--------------------------------------------------------------
Charged to the guest          NGN 179,350.00
```

The guest is charged `174,350`. Paystack sends the operator their full share to their
subaccount, keeps its own processing fee, and remits the remainder to House3. The
platform never holds the operator's money waiting to pay it out by hand.

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
tests/           228 tests
```

## Quick start

```bash
npm install
npm test                 # 120 tests
npm run typecheck

# optional: real database
npm run db:up            # docker compose postgres on :5433
npm run db:push
npm run db:seed
npm run db:studio
```

Copy `.env.example` to `.env` before touching a processor. Nothing in `src/domain`
reads the environment — pricing is injected, which is why the tests are deterministic.

## Documentation

- `ARCHITECTURE.md` — data flow, invariants, why each layer exists
- `ROLLOUT.md` — state-by-state operating plan

## Status

Implemented and tested: domain engine, authorized inventory layer, both payment
integrations, booking funnel, split ledger, Nigeria rollout data, PostgreSQL schema.

Not yet built: the Next.js UI on top of the API routes, partner-facing onboarding
dashboard, refunds/partial refunds UI, Channel Manager push-back, and admin reporting.
