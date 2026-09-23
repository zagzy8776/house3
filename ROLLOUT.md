# Rollout

## Sequence

| Phase | State | Code | Why this order |
|---|---|---|---|
| 1 | Lagos | `LA` | Densest shortlet supply in Nigeria, highest nightly rates, most operators already running a PMS or channel manager — so `PARTNER_API` and `ICAL_FEED` onboarding works without teaching anyone new software |
| 2 | Abuja / FCT | `FC` | Corporate and government travel, mid-week demand, plus weekend leisure. Second-largest shortlet market |
| 3 | Oyo (Ibadan) | `OY` | Large student and diaspora-visit demand; lower rates, so the 9% fee tier applies |
| 4 | Imo (Owerri) | `IM` | South-East hub, strong December/Christmas peaks |
| 5 | Akwa Ibom (Uyo) | `AK` | Regional hub and event city; validates the hostel-bed product type |

Then phases 6–11 cover the remaining 32 states (`EXPANSION_STATES` in
`src/data/nigeria.ts`), so the schema and code never change during expansion.

## The gate between phases

Do not open the next state until the current one passes all of these:

1. **Supply floor** — at least 50 bookable units across 5+ neighbourhoods, from 10+
   distinct operators, with verified settlement accounts.
2. **Confirmation rate** — 95%+ of paid bookings confirmed by the operator within 2 hours.
   Anything less means the calendar is not trusted and the room was double-sold.
3. **Reconciliation** — zero unexplained ledger imbalances for 30 days. If
   `assertLedgerBalances` has thrown in production, stop and fix the cause first.
4. **Chargebacks** — under 0.5% of transactions.
5. **Support load** — under 5% of bookings require a human intervention before check-in.
6. **Payout timeliness** — every operator settled inside the processor's own window
   (Paystack T+1/T+7 as configured), with no manual transfers.

## Operating per state

**Supply acquisition.** Target operators already publishing a calendar (Airbnb host, PMS
user, or one with a Booking.com listing). They get a signed supply agreement that states
plainly: House3 displays your rate, adds a named service fee, collects the guest's
payment, and settles your share directly into your bank account. Show them the split
table in the README — operators who understand the split are the ones who stay.

**Settlement.** Every operator needs a verified settlement account before their unit can
be sold; the booking service refuses to quote otherwise (`partnerBlockers()`). This is
deliberate: an unverified account means there is nowhere to send their money, which turns
into an unpaid operator and a suspended listing.

**Neighbourhood ordering.** `Area.rank` controls the search dropdown order. Rank by
demand evidence, not alphabetically — Lekki Phase 1 and Ikoyi outrank Festac in Lagos.

**Pricing per state.** Lagos/FCT at 12% with a per-night floor; Oyo/Imo/Akwa Ibom at 9%.
Both are rows in `FeePolicy`, so tuning is an ops action with an audit trail.

## What breaks first, and the plan

| Risk | Symptom | Mitigation |
|---|---|---|
| Operator double-sells the room | Guest arrives to an occupied flat | `PartnerApiAdapter.pushReservation()` writes the booking back with an idempotency key; calendar re-synced every 15 min |
| Calendar drift from iCal | Room shows available but is booked | iCal is a block-only feed — never treat "no event" as proof of vacancy for high-value bookings; require `ON_REQUEST` for units whose feed is older than 24h (`lastSyncedAt`) |
| Guest disputes the fee | "I saw it cheaper on their Instagram" | The checkout breakdown is itemised and stored in the payment metadata; the operator is named on the listing. This is a support conversation, not a legal one |
| Paystack account restricted | Payments stop | Flutterwave path is implemented (`src/payments/flutterwave.ts`); switch per-partner by settlement method |
| Refund request after confirmation | Operator refuses to refund | State machine already supports `REFUNDED` / `PARTIALLY_REFUNDED`; publish a cancellation policy per unit before scaling past phase 2 |

## Metrics to watch weekly

- **Fill rate** = confirmed bookings / bookable unit-nights, per state and per area
- **Rate integrity** = quotes that reached checkout vs quotes that were paid (a big gap
  means the disclosed fee is too high for that market, not that guests are "diverted")
- **Time-to-confirm** = payment verified → operator confirmation
- **Cancellation and refund rate**, by partner — a partner above 10% is a supply problem
- **Effective take rate** = `platformShareKobo / totalKobo`, tracked against the nominal
  policy rate so processor costs never quietly eat the margin
