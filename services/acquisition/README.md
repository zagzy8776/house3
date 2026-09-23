# Partner acquisition service

Finds shortlet operators across the launch states and produces a **call list**.

## Two layers, deliberately separate

```
DISCOVERY_SOURCE  ->  scraped public data  ->  PROSPECT / CATALOGUE
BOOKING_SOURCE    ->  PARTNER_API | ICAL_FEED | PARTNER_DASHBOARD | AFFILIATE_PROGRAM
                                          ->  BOOKABLE INVENTORY
```

`SCRAPER` is invalid as a **booking** source and valid as a **discovery** source.
Those are different layers, and conflating them was the mistake. `sources/`
implements discovery; it cannot produce bookable inventory because there is no
calendar and no agreement here. `AdapterRegistry.register` refuses anything
declaring `layer = BOOKING_SOURCE`.

A lead becomes bookable only after a human signs the operator, at which point
they onboard through the same channels as any partner and `assertAuthorized()`
gates them exactly as before.

## Architecture

```
compliance/     robots.txt · per-host rate limit · field allowlist · media stripping
sources/        base.py (SourceAdapter protocol + registry) · npc.py
                providers.py (stdlib · playwright · firecrawl · exa · fixture)
extraction/     property · operator · contact · pms · schema (API output schemas)
normalization/  names · phones · addresses · dedupe (consolidation) · history
pipeline.py     discover -> fetch -> parse -> consolidate -> diff -> funnel
```

Adding a portal is a new file in `sources/` implementing two methods, `discover`
and `parse`. Everything after parsing is source-agnostic — that is what stops
this becoming a pile of brittle per-site scripts.

## Crawl providers

Three ways to fetch a page, one interface behind them, chosen with `--transport`:

| `--transport` | What it is | When |
|---|---|---|
| `stdlib` | our own request | default; free; static pages only |
| `playwright` | a real browser | JS-rendered portals such as NPC |
| `firecrawl` | managed scrape API | scale, proxies, no browser to operate |
| `fixture` | bundled HTML | offline development and tests |

Every one of them is wrapped in `GuardedProvider`, which runs the robots check,
then the throttle, then the provider, then media stripping. **A paid crawl API
does not move the obligation.** If Firecrawl fetches a page, we received that
page, so the rules run on its output exactly as they run on our own. Firecrawl's
scrape endpoint takes no robots parameter and `excludeTags` is a cost
optimisation on top of our stripper, never a replacement for it.

`strip_media()` removes image references from the markup *before* extraction —
`<img>`, `<picture>`, `<figure>`, CSS `url()`, `srcset`, data URIs, and any URL
ending in an image extension in any attribute or inline JSON. A parser therefore
cannot match a photo URL even by mistake. Stopping at an output allowlist would
only prevent *storing* one.

## Discovery

`--discover exa` adds semantic discovery for operators our sitemap walk
structurally cannot reach: NPC's sitemap only ever tells us about NPC. Exa's
`contents.summary.schema` accepts a JSON schema and returns an LLM-written object
matching it, which is exactly the shape we want and exactly the risk — any field
we ask for is a field we have collected.

So the schema is **derived from `ALLOWED_FIELDS`** in `extraction/schema.py`, and
the module raises at import if it names anything forbidden or undeclared. Asking
Exa for `description` would launder prose collection through a vendor and defeat
the allowlist entirely; that is now an ImportError rather than a code review.

```bash
export EXA_API_KEY=...        # and FIRECRAWL_API_KEY=... for --transport firecrawl
python pipeline.py --source npc --state LA --area lekki \
  --transport firecrawl --discover exa
```

Exa results are candidates, not listings. Nothing reaches the lead file until the
operator's own page has been fetched and parsed like any other.

## Which houses are listed, and when

`--ledger listing-observations.jsonl` is append-only. Each run appends one
observation per listing and diffs it against everything already known:

```
  since last run, across 1,204 listings already known:
      37 newly listed
       9 changed price
       4 gone (absent beyond the grace period)
   1,154 unchanged
```

`first_seen_at` is a floor, not an exact date — the listing predated our finding
it by an unknown amount, so anything derived from it is reported as "at least".
A listing counts as delisted only after `DEFAULT_DELIST_GRACE_DAYS` of absence,
because portals reorder and an interrupted crawl looks identical to a withdrawal
on the day it happens.

**Not built, deliberately: a view count.** There is no honest way to measure how
many people viewed someone else's listing; that number lives in their analytics
and appears nowhere on the page. We could infer something from search rank and
print it as "views", and it would be invented. Presence, absence and advertised
price are measurable, so those are what we record.

## Publishing the directory

`--publish directory.json` writes the rows the public site renders at `/places`.

Every launch state is crawled by default:

```bash
python pipeline.py --states LA,FC,OY,IM,AK --transport firecrawl --interval 5
```

### What is publishable, and what is not

This is the whole design, so it is worth being precise.

**Facts are publishable.** A business's name, its address, its phone number, the
price it advertises. Nobody owns a fact. We watched an operator advertise a
3-bedroom in Ikeja at 220,000 a night; that is a thing that happened, and we can
say so — as long as we say where we saw it. So every row carries `attribution`
and links back to `source_url`, and `publishing.assert_publishable()` **fails the
run** if either is missing.

**Creative work is not.** A photograph and a written description have an owner,
and republishing either is not made lawful by the page being reachable. That
holds whether we fetched the page ourselves or paid an API to fetch it. Hence
`strip_media()` at the fetch boundary, `FORBIDDEN_FIELDS` at the extraction
boundary, and `NEVER_PUBLISHED` at the publish boundary — three walls, in order.

**`property_name` is dropped too**, and not out of caution: a listing title is
the operator's marketing copy, and "Luxury 3 Bedrooms Flats with City View" tells
a guest nothing. "3-bedroom short-let, Ikeja, ₦200,000 advertised" is both more
useful and unambiguously fact. No trade-off — `src/domain/directory.ts` derives
the descriptor from the numbers.

`media` is `null` on every row, declared rather than omitted, so a guest can tell
"no photographs we may show" from "the page failed to load them". Photographs
arrive when the operator claims the listing and sends us their own, which is what
the supply agreement is for.

### The row contract

```jsonc
{
  "id": "npc:1043668",
  "distribution": "DIRECTORY",          // DIRECTORY = observed coverage;
                                        // AFFILIATE = authorised partner handoff
  "operator_name": "Adeniyi Jones Residences Ltd",
  "phone": "0803 000 0000",
  "bedrooms": 3,
  "area": "Ikeja",
  "advertised_price": 20000000,        // kobo. Advertised BY THEM, not a rate we can charge
  "first_seen_at": "2026-09-23",       // a floor: it existed before we found it
  "contact_route": { "kind": "PHONE", "href": "tel:08030000000" },
  "attribution": "Nigeria Property Centre",
  "source_url": "https://…/…-1043668",
  "media": null
}
```

An `AFFILIATE` row additionally requires `affiliate_partner`, an absolute
`affiliate_url`, `affiliate_disclosure`, and an `AFFILIATE_URL` contact route.
Those fields are mutually exclusive with `DIRECTORY`: a crawl may observe a
`booking_url`, but it can never promote that observation into a bookable or
affiliate route. The crawl's `booking_url`/`availability_url` are internal
signals only and are refused by `NEVER_PUBLISHED`.

`src/domain/directory.ts` validates this shape on the way in and refuses a row
that is unattributed, that carries a photograph or a title, or that declares a
contact route it cannot deliver. Rejections are counted and surfaced on the page,
so a run that loses half its rows is visible rather than quietly shrunk.

**`directory.json` is generated, not source** — it is gitignored. `/places`
degrades to an empty state without it.

## Running

```bash
cd services/acquisition

# Offline against bundled NPC-shaped pages. No dependencies, no network.
python pipeline.py --source npc --state LA --area lekki --fixture --interval 0

# Tests (pytest, or the built-in runner if pytest is absent)
python -m pytest -q
```

Real crawl needs a browser, because NPC is Livewire/Alpine and paginates in JS:

```bash
pip install playwright && playwright install chromium
python pipeline.py --source npc --state LA --transport playwright --interval 5
```

**Verify the regexes against real markup before trusting a large crawl:**

```bash
python pipeline.py --dump-html https://www.nigeriapropertycentre.com/for-rent/short-let/lagos
```

The extraction patterns are derived from the observed structure but were not
tuned against a full page dump. Treat a first small crawl as calibration.

## Nigeria Property Centre — reconnaissance, 2026-09-23

| Finding | Detail |
|---|---|
| robots.txt | `User-agent: *` disallows only `*report/create*`. Every property path permitted, a Sitemap is published, AI crawlers get `Allow: /`, and `trovitBot` is blocked |
| Sitemaps | `sitemap_listings_1..4.txt` plus `neighbourhoods`, `area_guides`, `list_pages`, `market_reports`, `demand_supply` |
| Canonical paths | `/for-rent/short-let/{state}/{locality}` |
| Scale | Lagos: **13,525** short-let listings across **50** localities |
| Prices | Lagos avg **₦170K/day**, most between **₦120–240K**, max ₦700K, min ₦35K |
| Runtime | Livewire/Alpine — filters and pagination need a real browser |
| Listings are posted by | "an estate agent or developer you can contact directly" |

Discovery uses **their sitemap**, not a guessed URL pattern. A publisher that
advertises a sitemap is telling crawlers where its canonical pages are; guessing
URL shapes is both more fragile and less welcome.

## Operator consolidation

The step that turns a crawl into a call list. An operator with twelve units must
not appear twelve times.

Matching is a **connected-components** problem, not pairwise, because identity is
transitive through a listing:

```
Listing A  phone 0803...          \
Listing B  phone 0803...          /  same phone  -> one component
Listing C  email bookings@...     <- C shares nothing with A except through B
```

Signals are weighted: `phone`, `email` and website/email **domain** are strong
(union always); normalised `name + area` is weak (still unioned, but the evidence
is recorded on the operator so a human can see why — and split it if the machine
was wrong).

`test_three_real_fixture_pages_consolidate_to_one_operator` proves it end to end
through real parsing: three pages, three distinct listing ids, **one operator**.

## The funnel

```
     3 listings discovered
     3 usable records
     3 unique properties
     1 unique operators          <- the gap here is the value of consolidation
     1 multi-property operators
     1 with detectable booking/PMS infrastructure
```

If `unique properties == unique operators`, consolidation is not working.

Fields extracted: `source`, `source_url`, `source_listing_id`, `property_name`,
`operator_name`, `phone`, `email`, `website`, `state`, `city`, `area`,
`property_type`, `bedrooms`, `bathrooms`, `advertised_price`, `currency`,
`pms_detected`, `booking_url`, `availability_url`, `title_document` — with
`first_seen_at` / `last_seen_at` provenance applied on the TypeScript side.
`booking_url`, `availability_url`, `property_name` and `title_document` stay
internal: publishing drops them, and the public projection refuses them again.

## What is never collected

`compliance/ALLOWED_FIELDS` is an allowlist. `FORBIDDEN_FIELDS` names `photo`,
`images`, `gallery`, `description`, `body_text`, `review_text` and `agent_name`
explicitly, and `assert_no_media_or_prose()` **fails the run** if an extractor
reaches for any of them — or for a field nobody declared.

`strip_media()` runs earlier still, on the fetched markup, so an image reference
never reaches an extractor in the first place. The allowlist is the second wall,
not the only one.

Crawling permission and copyright are different things. NPC's robots.txt permits
us to fetch their pages; it does not license their photographs or their written
descriptions. This module makes that structural rather than a promise.

`agent_name` is on the list for a different reason: we are contacting a business
about a commercial proposition, and the name of whichever staff member happened
to post a listing is personal data we have no need for.

### So where do the photographs come from?

From the signed partner. `src/domain/media.ts` is the other half of this rule: an
image is displayable only when it belongs to an `ACTIVE` partner with a signed
supply agreement, names that agreement as its licence, and depicts the unit it is
shown on. A unit with no licensed photographs renders as a card with **no image**
— never a stock photo standing in for a specific property, because a guest who
books because of that photo has been misled about the room.

Two different problems, one fix. The operator uploads their own files during
onboarding, or we commission a shoot, and the agreement is what licenses the use.

## Retention

Outreach data is held for a year (`LEAD_RETENTION_DAYS`), then reviewed. An
expired record is **blocked from contact** by the scorer, not merely flagged.

## Next portals

`propertypro.py`, `jiji.py`, `shortlet.py` each implement `discover` + `parse`.
Before writing one: fetch its `robots.txt`, then `--dump-html` a listing page and
read the real markup. An adapter written without that step is guesswork.
