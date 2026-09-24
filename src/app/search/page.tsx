/**
 * Search results.
 *
 * Moved here from `/` when the Figma Make landing page took over the front door.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This page used to say "the operator's own rate, our service fee, and VAT on
 * that fee" and render a `MoneyTable` whose last row read "Total to pay now",
 * with a service-fee and VAT line above it. None of that is true any more:
 * House3 does not take payments, does not charge a service fee and is not the
 * merchant of record. A page that itemised a fee we do not charge was the most
 * misleading thing the app could show, so the fee lines and the payable total are
 * gone.
 *
 * What replaces them is the operator's own rate, the number of nights it covers,
 * and a link to the place's own page where the guest sees the gallery and every
 * observed detail and chooses how to make contact.
 */

import { findState, liveStates } from '@/data/nigeria';
import { formatNaira } from '@/domain/money';
import { telHref, toWhatsappHref } from '@/domain/phone';
import { placeHref, placeDescriptor, placeLocation } from '@/domain/directory';
import { buildDirectoryRepository } from '@/server/directoryRepository';
import { createPlaceSearch, type PlaceResult } from '@/server/placeSearch';
import { defaultFeePolicy, allFeePolicies } from '@/data/feePolicies';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

type SearchParams = {
  state?: string;
  area?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: string;
};

function isoPlusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const rolloutMode = process.env.ROLLOUT_MODE === 'all' ? 'all' : 'phased';
  const live = liveStates(rolloutMode, Number(process.env.LAST_LIVE_LAUNCH_ORDER ?? '5'));

  const stateCode = params.state ?? live[0]?.code ?? 'LA';
  const checkIn = params.checkIn ?? isoPlusDays(7);
  const checkOut = params.checkOut ?? isoPlusDays(9);
  const guests = Number(params.guests ?? '2');
  const area = params.area?.trim() ? params.area.trim() : undefined;

  let results: PlaceResult[] = [];
  let error: string | null = null;
  let operatorCount = 0;
  let nights = 0;
  let total = 0;

  try {
    // Search reads the PUBLISHED DIRECTORY, not the demo fixtures. Before this,
    // the homepage rendered crawled places while this page returned zero for the
    // same state - coverage the search box could not find.
    const repo = await buildDirectoryRepository();
    const policies = allFeePolicies();
    const search = createPlaceSearch({
      repo,
      feePolicyFor: (stateCode) =>
        policies.find((policy) => policy.subjectId === stateCode) ?? defaultFeePolicy()
    });

    const outcome = search.search({
      stateCode,
      area,
      stay: { checkIn, checkOut },
      guests
    });

    results = outcome.results;
    nights = outcome.nights;
    total = outcome.results.length + outcome.excluded.length;
    operatorCount = new Set(results.map((result) => result.partner.id)).size;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Search failed';
  }

  // Every discovered unit links to the place's own page, where the gallery and
  // the full detail live. That is what a guest needs in order to decide to call.
  const detailHrefFor = (result: PlaceResult): string | null =>
    result.unit.sourceUrl ? placeHref({ id: result.unit.id }) : null;

  return (
    <main className="h3-page">
      <h1>
        House3
        <span className="h3-badge">
          {findState(stateCode)?.name ?? stateCode} · {results.length} stay{results.length === 1 ? '' : 's'}
        </span>
      </h1>
      <p className="h3-lede">
        What each operator published, and how to reach them. We do not take the booking or the
        payment. <a href="/">Back to home</a>
      </p>

      <form method="get" className="h3-search">
        <label className="h3-field">
          State
          <select name="state" defaultValue={stateCode} className="h3-select">
            {live.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </select>
        </label>

        <label className="h3-field">
          Area (optional)
          <input name="area" defaultValue={area ?? ''} placeholder="Lekki Phase 1" className="h3-input" />
        </label>

        <label className="h3-field">
          Check in
          <input type="date" name="checkIn" defaultValue={checkIn} className="h3-input" />
        </label>

        <label className="h3-field">
          Check out
          <input type="date" name="checkOut" defaultValue={checkOut} className="h3-input" />
        </label>

        <label className="h3-field">
          Guests
          <input type="number" name="guests" defaultValue={guests} min={1} max={20} className="h3-input" />
        </label>

        <button type="submit" className="h3-btn h3-btn--primary">
          Search
        </button>
      </form>

      {error ? <p className="h3-error">{error}</p> : null}

      <p className="h3-summary">
        {results.length} place{results.length === 1 ? '' : 's'} of {total} in{' '}
        {findState(stateCode)?.name ?? stateCode}
        {area ? ` in ${area}` : ''} · {checkIn} to {checkOut} · {nights} night
        {nights === 1 ? '' : 's'} · {guests} guest{guests === 1 ? '' : 's'}
      </p>

      {total === 0 ? (
        <p className="h3-summary">
          We have not crawled {findState(stateCode)?.name ?? stateCode} yet, so there is nothing to
          show here. This is a limit of our coverage rather than of your search.
        </p>
      ) : null}

      <ul className="h3-list">
        {results.map((result) => (
          <ResultCard
            key={result.unit.id}
            result={result}
            detailHref={detailHrefFor(result)}
            nights={nights}
          />
        ))}
      </ul>
    </main>
  );
}

/**
 * One search result.
 *
 * THE PRICE REPLACED A PAYABLE TOTAL
 *
 * This card used to render `MoneyTable`, whose final row read "Total to pay
 * now" beneath a service-fee line and a VAT line. There is no code path in this
 * app that can take that payment, so the card now shows the operator's own
 * nightly rate, what it comes to for the dates chosen, and a way through to the
 * place's page. The arithmetic notes what it is: a calculation, not a charge.
 */
function ResultCard({
  result,
  detailHref,
  nights
}: {
  result: PlaceResult;
  detailHref: string | null;
  nights: number;
}) {
  const nightlyKobo = result.unit.nightlyRateKobo;
  const stayKobo = nightlyKobo * nights;

  // The number the listing published, read off the shared unit projection so this
  // page and the place page cannot disagree about it.
  const contactPhone = result.unit.contactPhone ?? null;
  const whatsappHref = toWhatsappHref(contactPhone);

  return (
    <li className="h3-card">
      <div className="h3-card__head">
        <div>
          <h2 className="h3-card__title">{result.unit.name}</h2>
          <div className="h3-meta">
            {result.unit.bedrooms} bed · {result.unit.bathrooms} bath · sleeps {result.unit.maxGuests} ·{' '}
            {result.unit.area}
          </div>
          <div className="h3-operator">
            Operated by <strong>{result.partner.displayName}</strong> · minimum stay {result.unit.minNights}{' '}
            night{result.unit.minNights === 1 ? '' : 's'}
          </div>
          {result.unit.sourceName ? (
            <div className="h3-operator">
              Observed on <strong>{result.unit.sourceName}</strong>
            </div>
          ) : null}

          {/*
            The contact block, which is the point of the card.

            Search results are reused from `placeToUnit` in
            `src/server/directoryRepository.ts`, so the phone here is the number
            the listing published - the same number the place page offers. It is
            absent for listings that published none, and the row disappears rather
            than rendering an empty button.
          */}
          {contactPhone ? (
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.9rem', flexWrap: 'wrap' }}>
              <a
                href={telHref(contactPhone)}
                className="h3-contact"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.6rem 1rem',
                  borderRadius: '0.75rem',
                  background: 'var(--primary)',
                  color: 'var(--primary-foreground)',
                  fontWeight: 600,
                  textDecoration: 'none'
                }}
              >
                ☎ Call
              </a>
              {whatsappHref ? (
                <a
                  href={whatsappHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h3-contact"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.6rem 1rem',
                    borderRadius: '0.75rem',
                    background: 'var(--secondary)',
                    color: 'var(--foreground)',
                    textDecoration: 'none'
                  }}
                >
                  💬 WhatsApp
                </a>
              ) : null}
            </div>
          ) : null}

          {detailHref ? (
            <p className="h3-operator" style={{ marginTop: '0.75rem' }}>
              <Link href={detailHref}>See the full details →</Link>
            </p>
          ) : null}
        </div>

        <div className="h3-card__price">
          <table className="h3-money">
            <tbody>
              <tr className="h3-money__row--room">
                <td>
                  {nights} night{nights === 1 ? '' : 's'} at the operator&apos;s rate
                </td>
                <td>{formatNaira(stayKobo)}</td>
              </tr>
              <tr className="h3-money__row--passthrough">
                <td>Cleaning &amp; turnover</td>
                <td>{formatNaira(result.unit.cleaningFeeKobo)}</td>
              </tr>
              <tr className="h3-money__row--total">
                <td>Payable to the operator</td>
                <td>{formatNaira(stayKobo + result.unit.cleaningFeeKobo)}</td>
              </tr>
            </tbody>
          </table>
          <p className="h3-operator" style={{ marginTop: '0.5rem' }}>
            {formatNaira(nightlyKobo)} per night. This is a calculation from the rate the operator
            published, not a charge from House3.
          </p>
        </div>
      </div>
    </li>
  );
}

