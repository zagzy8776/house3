import { NextResponse } from 'next/server';
import { loadDirectory } from '@/server/directorySource';

/**
 * Authorised affiliate handoff.
 *
 * This endpoint exists so affiliate clicks have a first-party, auditable hop
 * instead of sending guests straight from HTML to an arbitrary destination. It
 * only redirects rows already validated as AFFILIATE by `loadDirectory`; a
 * DIRECTORY row or an unknown id gets a 404 rather than an open redirect.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing affiliate place id' }, { status: 400 });
  }

  const { places } = await loadDirectory();
  const place = places.find((entry) => entry.id === id);

  if (!place || place.distribution !== 'AFFILIATE' || !place.affiliate) {
    return NextResponse.json(
      { error: 'Not an authorized affiliate handoff' },
      { status: 404 }
    );
  }

  let destination: URL;
  try {
    destination = new URL(place.affiliate.destinationUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid affiliate destination' }, { status: 404 });
  }
  if (destination.protocol !== 'http:' && destination.protocol !== 'https:') {
    return NextResponse.json({ error: 'Invalid affiliate destination' }, { status: 404 });
  }

  return NextResponse.redirect(destination, {
    status: 307,
    headers: { 'Cache-Control': 'no-store' }
  });
}