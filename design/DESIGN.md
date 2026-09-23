# House3 — Design

## Context this design is built for

Not a generic travel app. The actual conditions:

| Reality | Design consequence |
|---|---|
| Bookings happen on Android phones, commonly 360px wide | 360px is the design baseline, not 375/390. Check every frame at 360 before shipping |
| Data is metered and often 3G | Three webfonts ship with the brand, so every non-essential effect is gated: blur and 3D tilt are desktop-only, reduced-motion is honoured, and images lazy-load |
| One-handed use, often while moving | Primary action sits in the bottom third; touch targets ≥ 44px |
| Bank transfer and USSD are first-class payment methods, not fallbacks | The payment-pending screen is a designed screen, not a spinner |
| Guests compare your price against the operator's own Instagram/WhatsApp post | The breakdown must make the fee *legible*, not hide it |
| Operators will screenshot your app and check they were paid correctly | The confirmation screen shows the split |

## Principles

**1. The price breakdown is the product.**
House3's differentiator is not inventory (anyone can list rooms) — it is that the guest can see exactly what they pay and what each line is for. Every screen that shows money shows the full itemisation. `MoneyTable` is the only component that renders price, and it has no "hide the fee" prop.

**2. Never style the fee as a penalty.**
The fee row takes the brand accent (`--accent`), as the Figma design specifies. That works because orange *is* the identity here, not a warning colour — the row reads as "our line" rather than a surcharge. The rule this protects is unchanged: the fee is never hidden, never struck through, and never styled to look like a punishment. VAT is labelled "to FIRS" so the guest can see it is the government's line, not ours.

**3. Attribution beats anonymity.**
Every listing names the operator. "Operated by Lekki Homes Ltd" with a verified mark. An anonymous listing is what turns a booking platform into something that feels like a scam, and it destroys operator trust in one screenshot.

**4. Show real states, including the bad ones.**
The availability engine returns *reasons* (`src/domain/availability.ts`), not just a boolean. That exists so the UI can say "booked on the 11th" instead of "unavailable". Design for: no results, partial results, held-by-someone-else, payment declined, amount mismatch, hold expired.

**5. Motion is optional, always.**
The brand carries a floating hero, an auto-rotating showcase and a pointer-tracked 3D tilt. All of it is behind `prefers-reduced-motion`, the tilt is skipped on coarse pointers, and the heaviest blur is desktop-only. Nothing that helps someone book depends on an animation running.

## Colour

Ported from the Figma Make design. Dark warm ground, burnt-orange brand.

| Role | Token | Value | Why |
|---|---|---|---|
| Page background | `background` | `#0E0C0A` | Warm near-black, not neutral `#000`. The warm cast stops photography looking cut out against it |
| Surface | `card` | `#1A1714` | Raised surfaces separate by **value**, not by heavy shadow — which also keeps it cheap to paint |
| Brand / primary action | `primary` | `#D97C2B` | Burnt orange. Unclaimed in travel: Booking is blue, Airbnb coral, Agoda purple, Expedia blue/yellow. Reads hospitality, not fintech |
| Our fee + VAT lines | `accent` | `#E8A44A` | Lighter amber, used for the fee/VAT rows so our lines are identifiable without reading the label |
| Primary text | `foreground` | `#F5F0E8` | Warm off-white, ~15:1 on background |
| Body copy on dark | `secondary-foreground` | `#C8B99A` | Warm sand. Used for the longer descriptive paragraphs |
| Tertiary text | `muted-foreground` | `#8A7A68` | Labels, metadata, helper copy, ~4.6:1 on card |
| Border | `border` | `rgba(255,255,255,0.08)` | Hairline only. A visible border on a dark ground reads as a box |
| Failure | `danger` | `#E8756B` | Lightened from the consumer-side red so it clears contrast on the dark ground |
| Scarcity flag | `amber` | `#E8A33D` | **Only ever driven by real calendar data.** Never fake "2 rooms left" |

Contrast on this palette: `foreground` on `background` ~15:1, `muted-foreground` on `card` ~4.6:1, `primary-foreground` on `primary` ~7:1. All pass WCAG AA for their size.

**Known trade-off:** a dark UI is harder to read in direct Lagos sunlight than a light one. This was a deliberate brand decision, not an oversight. If outdoor conversion data ever shows a problem, the fix is a light mode on the *transaction* screens only — the semantic token layer (`--h3-*`) makes that a one-file change, because no component references a raw hex.

## Type

Three families, each with a narrow job:

| Family | Used for | Why |
|---|---|---|
| **Fraunces** (variable serif) | Headlines only | Gives the brand its editorial, hospitality feel. The italic carries the accent word in each headline ("*across Nigeria*", "*before you pay*") |
| **Outfit** | All UI and body | Clean geometric sans that pairs with Fraunces without competing |
| **JetBrains Mono** | Money only | Monospace is better than `tabular-nums` for price columns: it aligns decimals **and** fixes digit widths |

Scale: h1 22 / h2 18 / body 15 / small 13 / micro 11.

**Money never drops below 15px.** Meta-information can be 11px. The amount someone is about to pay cannot.

**Load cost, and what was done about it.** Three families is a real download on a metered plan. Mitigations: only the weights actually used are requested, the hero image lazy-loads below the fold, and no effect that depends on the fonts is load-bearing. If this ever needs to shrink, the order to cut is Fraunces first (it is decorative), then JetBrains Mono (fall back to `tabular-nums`). Outfit stays — it is the interface.


## The money table

The single most important component. Rules, all encoded in `globals.css`:

```css
font-variant-numeric: tabular-nums;   /* decimal points align down the column */
```

People compare prices by the position of the comma. Proportional figures break that alignment, so the guest cannot scan the column — and scanning is how they verify nothing was added.

Row order is fixed and comes from the pricing engine, not from the screen:

1. **Room** — "2 nights × ₦150,000". The operator's own rate, first, because it is the number the guest already has in their head from Instagram.
2. **Passthrough** — "Cleaning & turnover". Their fee, shown as theirs.
3. **Fee** — "House3 service fee (12%)". **The percentage is shown.** It costs nothing and pre-empts "how much are you taking?".
4. **Tax** — "VAT on service fee (7.5%)", muted 13px.
5. **Total** — the only bold row, above a stronger divider.

The table ends at the total. An earlier version also printed the internal
operator/platform split beneath it, and that line was removed. The guest sees what
they pay and what each line is for, but not how the money is divided afterwards.

The operator/platform split still exists and is still auditable by us; it lives in
the ledger (`src/server/bookingService.ts`, `LedgerEntry`) and in the Paystack
subaccount split. It is simply not guest-facing, so `MoneyTable` has no prop for it.


## Screen inventory

Status: `[SVG]` = drawn and in `design/screens/`. The rest are specified here so
they can be drawn without re-deriving the decisions.

### 1. Search summary / results — `[SVG]` `01-search-results.svg`
Sticky search summary at the top (not the full form again — the guest already
filled it), results below.

States to draw:
- **Default** — as drawn.
- **Empty** — no units in the area. Copy: "No stays in *area* for these dates." Then three real alternatives: nearby areas with supply, a date shift, or a shorter stay. Never a dead end.
- **Partial** — some units unavailable. Grey the card and show the engine's actual reason: "Booked on 11 Sep". Showing *why* teaches the guest the calendar is real, which is the trust proposition.
- **Error** — `h3-error` banner with a retry action.

### 2. Listing detail
One photo (lazy, ~40KB), full rules (min stay, check-in time), and the money
table pinned above a sticky checkout bar.

Sticky bar: total on the left, `Reserve for 15 min` on the right. That total is
the same `totalKobo` from the same `Quote` — never a re-computed "from ₦X".

### 3. Hold countdown — 15 minutes
Once `startCheckout` succeeds the room is genuinely held, and
`cancelExpiredHolds()` will release it. So the timer must be honest.

- Persistent bar: "Held for you · 14:32" on `amber.50`, tabular-nums so digits do not jitter.
- At expiry: "Your hold expired and the room was released. It is still available." plus a re-hold button. No fake "someone else is viewing this".

### 4. Checkout
Guest details (name, email, phone), the money table again, then
`Continue to payment`.

Copy rules:
- Name the processor: "You will pay on Paystack's secure page." Saying where they are going reduces abandonment at the redirect, the biggest drop-off in Nigerian checkout flows.
- Say what happens next: "Lekki Homes Ltd is paid directly. We never hold their money."

### 5. Payment pending — the Nigeria-specific screen
Payments here are asynchronous. Bank transfer can take minutes; USSD sessions
succeed or time out with no reliable client callback.

- Reference in large tabular type with a copy button.
- Show the amount **and who it goes to**, next to the processor name. Guests have been trained by scams to distrust a naked amount.
- Show the hold timer, and warn before expiry.
- Poll with backoff. A guest on 3G must not spend their data on retries.

### 6. Confirmation — `[SVG]` `05-confirmation.svg`
Answers one question properly: **what did I pay, and what was each line for.** The
itemisation is repeated in full, the total is stated once, and the reference is
shown for quoting over the phone.

The design originally split this into two cards — "what you were charged" and
"where the money went", the second showing the operator's and House3's shares.
That second card has been removed. A guest does not need our internal split, and
publishing it invites a conversation about margin instead of about the stay.

Also drawn: a reference readable over the phone (`H3-LA-303785EA`) and a
secondary action to message the operator.

### 7. Payment declined / amount mismatch
Two states, because they mean different things:

- **Declined** — the card failed. Encouraging, retry-focused, alternate methods offered. No blame.
- **Amount mismatch** — reconciliation caught a settlement that does not equal the frozen quote (`confirmPayment` throws here). Tell the guest plainly: "We did not confirm this booking. Your payment is refunded in full, reference X." Then a real support contact. Never silently confirm and hope.

### 8. Partner onboarding (separate surface, its own language)
Different audience — operators, often on a laptop. Denser, table-based. Do not
reuse the guest layout. Must include:

- The split explained with a worked example on *their own* rate.
- Settlement account capture (Paystack subaccount) and its verification state.
- Channel setup: the four authorised kinds only.
- Blackout dates and rate overrides.
- Payout history showing `ROOM_REVENUE` legs as `SETTLED`.


## Component inventory (build these in Figma first)

Name them exactly like this so the Figma library and the CSS classes line up
one-to-one. `MoneyTable` is the only component that may render a price.

| Figma component | CSS class | Variants |
|---|---|---|
| `Money / Table` | `.h3-money` | `discount=yes/no` |
| `Money / Row` | `.h3-money__row--{kind}` | `kind=room, passthrough, fee, tax, discount, total` |
| `Money / Total Box` | `.h3-total-box` | — |
| `Card / Listing` | `.h3-card` | `state=default, held, unavailable` |
| `Button / Primary` | `.h3-btn--primary` | `state=default, pressed, disabled, loading` |
| `Button / Secondary` | `.h3-btn` + border | same |
| `Field / Text` | `.h3-input` | `state=default, focus, error, disabled` |
| `Field / Select` | `.h3-select` | same |
| `Banner / Error` | `.h3-error` | — |
| `Banner / Hold` | `amber.50` bg | `urgency=normal, expiring, expired` |
| `Ledger / List` | `.h3-ledger` | — |
| `Badge / Trust` | `.h3-badge` | `kind=verified, state-live` |

In code, `MoneyTable` derives its row variant from `QuoteLine.kind` via
`moneyRowClass()`. That mapping is a `switch` over a union with no default, so
adding a line kind without designing its treatment is a **compile error** — the
design system cannot silently fall behind the pricing engine.

## Anti-patterns — do not ship these

Not style preferences. Each one is a specific way this product loses the thing
that makes it work.

| Pattern | Why it is banned |
|---|---|
| Hidden markup — showing NGN 190,000 with no breakdown | Processor terminations for undisclosed merchant-of-record pricing, FCCPC misleading-pricing exposure, and operators stop signing once a guest was charged more than they asked for |
| Struck-through "was NGN 190,000" that was never a real past price | Straightforwardly false, and the first thing a journalist screenshots |
| Fake scarcity — "only 1 room left" with no calendar basis | We have a real calendar. Faking it throws away the one advantage over the competition |
| Countdown that resets on reload | The 15-minute hold is real and enforced server-side; a fake timer makes the real one untrustworthy too |
| Anonymising the operator | Kills operator trust instantly and makes the listing feel like a scam |
| Invented reviews or ratings | We have none yet. "No reviews yet — new on House3" beats fabrication |
| "Prices exclude fees" small print | The opposite of the positioning, and no code path produces a pre-fee total |
| Pre-ticked paid extras | Chargebacks, and it poisons the transparency story for a few thousand naira |
| Forcing account creation before showing a price | The price is the product. Gate it and we lose the comparison |
| Auto-selecting a pricier unit or date | One bad review sentence undoes the whole trust position |

## Accessibility

- **Contrast:** `ink.900` on `ink.50` ≈ 16:1. White on `green.500` ≈ 4.6:1. `green.700` for any green text so it clears 4.5:1.
- **Touch targets:** at least 44px (`--h3-touch-target`). Buttons are 48px.
- **Focus:** `:focus-visible` outlines are defined on inputs, selects and buttons in `globals.css`. Do not remove them — the partner dashboard must be keyboard-drivable.
- **Never colour alone:** the discount row is green *and* carries a minus sign; unavailable cards carry text, not just a grey tint.
- **Motion:** `prefers-reduced-motion` collapses all transitions.
- **Zoom:** 200% must not clip money rows — amounts are `white-space: nowrap` and the label column wraps.
- **Currency:** the naira sign is a text character, never an image or CSS pseudo-element, so screen readers announce it.

## Getting this into Figma

Figma is not installed on this machine and I have no way to drive a GUI, so
these are the steps to run yourself. About ten minutes.

1. **File:** new design file, named `House3 — Platform`. Pages: `Foundations`, `Components`, `Guest flow`, `Partner flow`, `Archive`.
2. **Variables (the important step):** install the **Tokens Studio** plugin, then *Import* `design/tokens.tokens.json` and *Export to Figma*. This creates a Figma Variables collection with your colour, spacing, radius and size tokens. Apply the Variables, never hard-code hexes. When a fee tier changes, one Variable updates every frame — exactly like one CSS custom property.
3. **Text styles:** create styles from the `typography` tokens, named identically to the CSS custom properties: `display`, `h1`, `h2`, `body`, `small`, `micro`, `money`.
4. **Import the screens:** drag `design/screens/01-search-results.svg` and `05-confirmation.svg` onto the `Guest flow` page. Figma imports SVG as editable vector layers — select all, group, convert to a Frame at 360 wide. Text stays editable text.
5. **Font note:** the SVGs carry a system-font stack, which Figma will substitute. In the library file only, override to **Inter** so mockups are consistent. The shipped app keeps the system stack for the data-saving reasons above — do not let that become a webfont.
6. **Build components** in the order of the inventory table. `Money / Row` with its six variants is the one that matters most.
7. **Prototype the funnel:** results to listing to hold countdown to checkout to payment pending to confirmation. The payment-pending screen is the one most teams forget, and in Nigeria it is the one guests actually sit on.

## Keeping Figma and code in sync

Two files, both in this repo, changed in the same commit:

- `design/tokens.tokens.json` — what Figma imports.
- `src/app/globals.css` — what the app renders.

`MoneyTable` (`src/app/components/MoneyTable.tsx`) is the only bridge from
domain data to visual money. A design showing a price row the engine cannot
produce will not ship — check any new row kind against `QuoteLineKind` in
`src/domain/pricing.ts` before drawing it.
