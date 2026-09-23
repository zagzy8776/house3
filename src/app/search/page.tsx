/**
 * Search results.
 *
 * Moved here from `/` when the Figma Make landing page took over the front door.
 * Renders the FULL price breakdown on every result, via MoneyTable. There is no
 * code path in this app that shows a total without the fee that produced it.
 */

import { findState, liveStates } from '@/data/nigeria';
import { getContainer } from '@/server/container';
import type { SellableUnit } from '@/server/bookingService';
import { MoneyTable } from '../components/MoneyTable';

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

  let results: SellableUnit[] = [];
  let error: string | null = null;
  let operatorCount = 0;

  try {
    const outcome = getContainer().service.search({
      stateCode,
      area,
      stay: { checkIn, checkOut },
      guests
    });
    results = outcome.results;
    operatorCount = new Set(results.map((result) => result.partner.id)).size;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Search failed';
  }

  return (
    <main className="h3-page">
      <h1>
        House3
        <span className="h3-badge">
          {findState(stateCode)?.name ?? stateCode} · {results.length} stay{results.length === 1 ? '' : 's'}
        </span>
      </h1>
      <p className="h3-lede">
        Every price is itemised: the operator&apos;s own rate, our service fee, and VAT on that fee.{' '}
        <a href="/">Back to home</a>
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
        {results.length} stay{results.length === 1 ? '' : 's'} from {operatorCount} operator
        {operatorCount === 1 ? '' : 's'}
        {area ? ` in ${area}` : ''} · {checkIn} to {checkOut} · {guests} guest{guests === 1 ? '' : 's'}
      </p>

      <ul className="h3-list">
        {results.map((result) => (
          <ResultCard key={result.unit.id} result={result} />
        ))}
      </ul>
    </main>
  );
}

function ResultCard({ result }: { result: SellableUnit }) {
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
        </div>

        <div className="h3-card__price">
          <MoneyTable lines={result.quote.lines} totalKobo={result.quote.totalKobo} />
        </div>
      </div>
    </li>
  );
}
