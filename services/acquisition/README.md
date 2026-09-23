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
compliance/     robots.txt · per-host rate limit · field allowlist
sources/        base.py (SourceAdapter protocol + registry) · npc.py
extraction/     property · operator · contact · pms
normalization/  names · phones · addresses · dedupe (operator consolidation)
pipeline.py     discover -> fetch -> parse -> consolidate -> funnel
```

Adding a portal is a new file in `sources/` implementing two methods, `discover`
and `parse`. Everything after parsing is source-agnostic — that is what stops
this becoming a pile of brittle per-site scripts.

## Running

```bash
cd services/acquisition

# Offline against bundled NPC-shaped pages. No dependencies, no network.
python pipeline.py --source npc --state LA --area lekki --fixture --interval 0

# Tests
python test_acquisition.py
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

## What is never collected

`compliance/ALLOWED_FIELDS` is an allowlist. `FORBIDDEN_FIELDS` names `photo`,
`images`, `gallery`, `description`, `body_text`, `review_text` and `agent_name`
explicitly, and `assert_no_media_or_prose()` **fails the run** if an extractor
reaches for any of them — or for a field nobody declared.

Crawling permission and copyright are different things. NPC's robots.txt permits
us to fetch their pages; it does not license their photographs or their written
descriptions. This module makes that structural rather than a promise.

`agent_name` is on the list for a different reason: we are contacting a business
about a commercial proposition, and the name of whichever staff member happened
to post a listing is personal data we have no need for.

## Retention

Outreach data is held for a year (`LEAD_RETENTION_DAYS`), then reviewed. An
expired record is **blocked from contact** by the scorer, not merely flagged.

## Next portals

`propertypro.py`, `jiji.py`, `shortlet.py` each implement `discover` + `parse`.
Before writing one: fetch its `robots.txt`, then `--dump-html` a listing page and
read the real markup. An adapter written without that step is guesswork.
