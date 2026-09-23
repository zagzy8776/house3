# Partner acquisition service

Finds shortlet operators across the launch states and produces a **call list**.

## What this outputs, and what it deliberately does not

**Output:** operator prospects — who to call, in which neighbourhood, running how
many properties, at what advertised rate, and whether they already run a booking
system.

**Not output:** inventory. There is no calendar here and no agreement, so a lead
cannot be sold. When an operator signs, they onboard through the same channels as
any other partner (`PARTNER_API`, `ICAL_FEED`, `PARTNER_DASHBOARD`), and
`assertAuthorized()` gates them exactly as before.

That distinction is enforced in code, not documentation:

- `policy.ALLOWED_FIELDS` is an allowlist. `assert_no_media_or_prose()` rejects
  anything else, so an over-eager parser fails loudly instead of writing a
  photographer's work into our database.
- `policy.FORBIDDEN_FIELDS` names media, descriptions, body text, review text and
  personal agent names explicitly, so the exclusion is a decision on record.
- There is no code path from a `PartnerLead` to a bookable unit that does not pass
  through a signed supply agreement.

## Running it

```bash
cd services/acquisition

# Offline, against the bundled fixture. No dependencies, no network.
python pipeline.py --fixture --out leads.jsonl

# Tests (plain Python or pytest)
python test_policy.py
```

Nothing is installed for the default path — the transport is `urllib`. Only a
crawling environment needs the browser:

```bash
pip install playwright && playwright install chromium

cat > targets.txt <<'EOF'
https://example-portal.ng/shortlets/lekki
https://example-portal.ng/shortlets/maitama
EOF

python pipeline.py --targets targets.txt --out leads.jsonl --transport playwright --interval 5
```

## The rules every fetch obeys

| Rule | Where | Why |
|---|---|---|
| `robots.txt` respected, cached per host per run | `policy.RobotsCache` | If a site says no, the answer is no |
| One request per host per `--interval` seconds | `policy.HostThrottle` | We are a guest. A crawler that degrades someone else's site is the fastest route to being blocked |
| Allowlisted fields only | `policy.ALLOWED_FIELDS` | What we do not fetch cannot leak |
| Media and prose refused | `policy.assert_no_media_or_prose` | Photographs and descriptions are the operator's copyright |
| No contact channel → discarded | `pipeline.run` | A lead nobody can call is noise |
| Retention window | `src/domain/lead.ts` | Outreach data is held for a year, then reviewed |

## Where the work is divided

```
Python (this service)          TypeScript (src/domain/lead*.ts)
─────────────────────          ──────────────────────────────────
fetch, parse, extract     →    normalise, dedupe, score, retain
transport concerns             business logic, one implementation
```

`pipeline.py` writes JSONL. The TypeScript side owns identity normalisation,
deduplication across sources and scoring — so that logic exists once, is typed,
and is covered by the 182-test suite rather than duplicated in two languages.

## Adding a source

1. Write a `SourceSpec` with the operator, area, phone and rate patterns for that
   site's markup.
2. Run it with `--targets` and a rate-limited interval.
3. Check the output for anything you did not intend to collect. If a field appears
   that is not in `ALLOWED_FIELDS`, the run fails — that is the guard working.

Rate patterns are per-site because portals differ. Expect to tune them.
