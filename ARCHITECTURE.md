# Architecture

## Layers, and why the boundaries are where they are

```
        HTTP (Next.js route handlers)
                 |
        src/server/bookingService   <- orchestration: hold, charge, confirm, ledger
           /        |         \
   src/domain/  src/payments/  src/inventory/
   (pure)       (processors)   (authorised supply)
                 |
        src/server/store        <- Repository contract; Prisma in production
```

`src/domain` has **no imports** from anywhere else in the project: no `fetch`, no
`process.env`, no database. Every rule that touches money is therefore testable with
plain function calls and a fixed clock, which is exactly what `tests/` does.

## Money rules

1. **Kobo integers, always.** `src/domain/money.ts` is the only place that converts.
   `toNaira`/`formatNaira` exist for display; nothing stores a float.
2. **Basis points for rates.** 1200 bps = 12%. Integer maths, deterministic half-up
   rounding, so a quote issued twice is identical.
3. **Two invariants, both fuzz-tested:**

   ```
   quote.partnerNetKobo + quote.platformNetKobo === quote.totalKobo
   split.partnerShareKobo + split.platformShareKobo + split.processorFeeKobo === quote.totalKobo
   ```

   A violation throws (`PricingError` / `SplitError`) rather than charging a guest.

4. **Display rounding.** The service fee and its VAT round to `roundingStepKobo`
   (default NGN 50) so checkout shows human numbers. The partner's rate is never rounded
   — we do not silently alter someone else's price.

## The pricing engine

```
feeBaseKobo = roomSubtotal - lengthOfStayDiscounts + addOns
serviceFee  = clamp(feeBase * rateBps, max(minFee, minNightlyFee * nights), maxFee)
                        then rounded to roundingStepKobo
vat         = serviceFee * vatRateBps, rounded
total       = roomSubtotal - discounts + addOns + cleaningFee + serviceFee + vat
partnerNet  = roomSubtotal - discounts + addOns + cleaningFee
platformNet = serviceFee + vat
```

Policy precedence is `PARTNER` → `STATE` → `GLOBAL`. Lagos and FCT carry a higher rate
(12%) with a per-night floor because their average nightly rate supports it; Oyo, Imo and
Akwa Ibom sit at 9% to stay competitive with direct booking. All of it lives in
`FeePolicy` rows — changing a rate is a row update, not a deploy.

## The payment split

`src/domain/splits.ts` produces, for one charge:

- `partnerShareKobo` — settled into the operator's Paystack subaccount
- `platformShareKobo` — the platform's net margin **after** processor cost
- `processorFeeKobo` — the processor's cut, forecast from a configurable model

`bearer` decides who eats the processor fee:

| bearer | partner receives | platform keeps |
|---|---|---|
| `platform` | full partner net | fee + VAT − processor fee |
| `partner` | partner net − processor fee | fee + VAT |

Paystack gets `transaction_charge` (flat kobo to the partner) — the cleanest mapping of
"operator takes their money, we take ours". Flutterwave only supports integer percentage
ratios, so `toFlutterwaveRatios()` gives the partner the floor percent and hands the
platform the remainder; bookings where our share would round below 1% are refused
(`FlutterwaveError`) and should route to Paystack instead.

## Availability and holds

- A stay is a **half-open** interval `[checkIn, checkOut)`. A guest checking out on the
  5th and another checking in on the 5th do **not** conflict — asserted in
  `dates.test.ts` and `bookingService.test.ts`.
- `checkAvailability()` returns *reasons*, not just a boolean, so the UI can say "this
  room is booked on the 11th" and ops can see why supply dropped.
- `createHold()` **throws** on unavailable inventory. A caller cannot accidentally
  continue into a payment flow for a night that is already gone.
- Holds are 15 minutes by default and derive from bookings in `HELD` /
  `AWAITING_PAYMENT`. `cancelExpiredHolds()` releases them, so a timer job is all that is
  needed — no second hold table to reconcile.


## Booking state machine

```
DRAFT -> HELD -> AWAITING_PAYMENT -> CONFIRMED -> COMPLETED
             \-> EXPIRED                \-> FAILED / EXPIRED
                                        \-> CANCELLED / REFUNDED / PARTIALLY_REFUNDED
```

Terminal states have **zero** allowed transitions, so a settled booking can never be
silently reopened. `assertTransition()` runs before every status write.

## Payment confirmation is defensive

`confirmPayment()` does four things, in order:

1. **Idempotency** — a booking already `CONFIRMED`/`COMPLETED` returns
   `alreadyProcessed: true` without touching the ledger. Webhooks retry; the ledger must
   not double-settle.
2. **Server-side verification** — the processor is queried directly; a client-supplied
   amount is never trusted.
3. **Amount reconciliation** — if the settled amount differs by one kobo from the frozen
   quote, the booking goes `FAILED`, the guest is flagged for refund, and a
   `BookingError` is raised. We never confirm at an unexpected price.
4. **Ledger posting** — legs are built and `assertLedgerBalances()` proves they sum to
   the payouts actually disbursed (`partnerShare + platformShare`).

### Ledger semantics

The guest's gross payment is *not* the sum of outgoing legs, because the processor takes
its fee out of the flow. The ledger mirrors real cash movement:

| Leg | Recipient | Amount |
|---|---|---|
| `ROOM_REVENUE` | PARTNER | partner share (includes their cleaning passthrough) |
| `SERVICE_FEE` | PLATFORM | service fee |
| `SERVICE_FEE_VAT` | PLATFORM | VAT on the service fee |
| `PROCESSOR_FEE` | PLATFORM | **negative** — only when the platform bears it |

Sum of legs = `partnerShare + platformShare`. When the partner bears the processor fee,
that cost is already inside their reduced share, so no expense leg is posted.

## Inventory authorization

`AuthorizationRecord` = `{ kind, basis, reference, grantedAt, expiresAt, partnerId }`.

`assertAuthorized()` enforces that:

- a record exists at all;
- the basis is valid for the channel (`ICAL_FEED` cannot be justified by
  `AFFILIATE_PROGRAM_TERMS`, for example);
- the agreement has not expired;
- a contract/agreement reference is present — no anonymous data.

The registry (`src/inventory/registry.ts`) allows exactly four channel kinds and throws
`UnsupportedChannelError` for anything else. Adding a scraping adapter would mean adding
a fifth kind that the guard rejects by construction.

Adapters defend themselves too: `IcalFeedAdapter` refuses a calendar URL outside the
declared `origin`, and surfaces upstream HTTP failures instead of returning an empty
snapshot (an empty snapshot would mass-delist the operator's rooms).

## Persistence

`prisma/schema.prisma` is the production model. Key choices:

- Money columns are `Int` kobo.
- `Booking` stores the **frozen** `priceBreakdown` (JSON) plus
  `partnerNetKobo` / `platformNetKobo` / `processorFeeKobo`, so a booking is fully
  reconstructable years later even after fee policies change.
- `PartnerChannel` carries the authorization fields — a channel row without a reference
  is a bug, not a configuration option.
- `WebhookEvent` has a unique index on `(processor, signature)` for replay protection.
- `BookingEvent` is an append-only status audit trail.

`src/server/store.ts` defines the `Repository` interface the service depends on and ships
an in-memory implementation. Swapping in a Prisma-backed implementation is one
constructor argument in `src/server/container.ts`.

## Extension points

- **Fee changes:** insert/update a `FeePolicy` row (GLOBAL / STATE / PARTNER).
- **New state:** set `State.status = LIVE` and rank `Area` rows for the search dropdown.
- **Channel Manager push-back:** `PartnerApiAdapter.pushReservation()` already sends the
  confirmed booking with an `Idempotency-Key`, so the operator's own calendar blocks
  those nights and the two channels cannot oversell each other.
- **Refunds:** the state machine already permits `CONFIRMED → REFUNDED` /
  `PARTIALLY_REFUNDED`; add the processor call and a `REFUND` ledger leg (the kind
  already exists).
