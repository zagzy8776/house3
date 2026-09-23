/**
 * The operator directory.
 *
 * Every shortlet we can see in a state, whether or not we can sell it yet.
 * Populated by services/acquisition, which crawls portals and publishes facts:
 * who operates where, how big, and at what advertised rate.
 *
 * WHY THIS PAGE EXISTS SEPARATELY FROM /search
 *
 * /search returns stays we can confirm, with a calendar behind them and a price
 * built by our own pricing engine. This page returns places we know about, where
 * the guest's route is to the operator. Two different promises, so two different
 * pages - and nothing here is ever rendered as a bookable rate.
 *
 * It is also the honest answer to "the site looks empty". A directory is real
 * coverage: a guest in Owerri can see that there are shortlets in New Owerri and
 * roughly what they cost, today, before we have signed anyone there.
 */

import { findState } from '@/data/nigeria';
import { groupByState, loadDirectory } from '@/server/directorySource';
import { PlaceCard } from '../components/marketing/PlaceCard';

export const dynamic = 'force-dynamic';

export default async function PlacesPage() {
  const { places, rejected, generatedAt, available } = await loadDirectory();
  const groups = groupByState(places);

  return (
    <main
      className="min-h-screen px-6 py-16"
      style={{ background: 'var(--background)', color: 'var(--foreground)' }}
    >
      <div className="max-w-6xl mx-auto">
        <p
          className="text-sm mb-2 m-0"
          style={{ color: 'var(--accent)', fontFamily: 'var(--font-outfit)' }}
        >
          Operator directory
        </p>
        <h1
          className="text-3xl md:text-4xl font-bold mb-3 m-0"
          style={{ fontFamily: 'var(--font-outfit)' }}
        >
          Shortlets we can see
        </h1>
        <p
          className="text-sm max-w-2xl mb-8 m-0"
          style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
        >
          Shortlet operators advertising in our launch states, with the rate they published and a
          way to reach them. These are directory entries, not bookings: we name the source of every
          row, we do not carry their photographs, and we do not take payment for them.
        </p>

        {!available ? (
          <Empty
            title="No directory build yet"
            body="Run the acquisition pipeline to populate this page: python pipeline.py --states LA,FC,OY,IM,AK --publish directory.json"
          />
        ) : places.length === 0 ? (
          <Empty
            title="The last crawl returned nothing"
            body="A file exists but contains no publishable rows. Check the pipeline output for rows rejected by the guard."
          />
        ) : (
          <>
            <div
              className="flex flex-wrap gap-4 text-sm mb-3"
              style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
            >
              <span>{places.length.toLocaleString()} places</span>
              <span>{groups.length} states</span>
              {generatedAt ? <span>last crawled {generatedAt}</span> : null}
            </div>

            {rejected > 0 ? (
              <p
                className="text-xs mb-8 m-0"
                style={{ color: 'var(--accent)', fontFamily: 'var(--font-outfit)' }}
              >
                {rejected.toLocaleString()} rows were withheld: they could not be attributed to a
                source, or carried a field a directory must not publish.
              </p>
            ) : null}

            {groups.map((group) => (
              <section key={group.state} className="mb-14">
                <h2
                  className="text-xl font-semibold mb-1 m-0"
                  style={{ fontFamily: 'var(--font-outfit)' }}
                >
                  {findState(group.state)?.name ?? group.state}
                </h2>
                <p
                  className="text-sm mb-5 m-0"
                  style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
                >
                  {group.places.length.toLocaleString()} places advertised
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {group.places.map((place) => (
                    <PlaceCard
                      key={place.id}
                      place={place}
                      stateName={findState(group.state)?.name ?? null}
                    />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </main>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="rounded-2xl p-8"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <p className="m-0 font-semibold mb-2" style={{ fontFamily: 'var(--font-outfit)' }}>
        {title}
      </p>
      <p
        className="m-0 text-sm"
        style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-outfit)' }}
      >
        {body}
      </p>
    </div>
  );
}
