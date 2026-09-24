/**
 * Reads the published directory produced by the acquisition pipeline.
 *
 * The crawl writes `services/acquisition/directory.json`; this reads it. There is
 * no database dependency on purpose, because the directory must work before the
 * Postgres ingest exists, and a file you can open and inspect is the right first
 * step for data whose whole basis is that it is attributable.
 *
 * Failing soft: a missing or malformed file yields an empty directory rather than
 * a 500. The public site should degrade to "we have not crawled yet", never to a
 * crash. `rejected` is surfaced so a run that lost rows is visible instead of
 * quietly shrinking.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDirectory, type DirectoryPlace } from '@/domain/directory';

/** Override with DIRECTORY_JSON_PATH; defaults to the pipeline's output. */
export function directoryPath(): string {
  return (
    process.env.DIRECTORY_JSON_PATH ??
    path.join(process.cwd(), 'services', 'acquisition', 'directory.json')
  );
}

export type DirectorySnapshot = {
  places: DirectoryPlace[];
  /** Rows the guard refused. Non-zero means the pipeline and this module disagree. */
  rejected: number;
  /** ISO date the crawl ran, or null when there is no file yet. */
  generatedAt: string | null;
  /** Whether a pipeline run has produced anything. */
  available: boolean;
};

const EMPTY: DirectorySnapshot = {
  places: [],
  rejected: 0,
  generatedAt: null,
  available: false
};

export async function loadDirectory(now?: string): Promise<DirectorySnapshot> {
  let raw: string;
  try {
    raw = await readFile(directoryPath(), 'utf8');
  } catch {
    // No crawl has run. Not an error: a developer cloning this repo should get a
    // working site, not a stack trace.
    return EMPTY;
  }

  try {
    const parsed = parseDirectory(JSON.parse(raw), now);
    return { ...parsed, available: true };
  } catch {
    return { ...EMPTY, available: false };
  }
}

/**
 * One place by id, or null.
 *
 * Reads the whole file rather than indexing it. The directory is a few thousand
 * rows and Next caches the route segment, so a linear scan is not the cost here;
 * an index would be a second structure to keep in step with the parser, which is
 * where the bug would be. Revisit if the directory reaches five figures.
 */
export async function loadPlace(id: string): Promise<DirectoryPlace | null> {
  const { places } = await loadDirectory();
  return places.find((place) => place.id === id) ?? null;
}

/**
 * Directory places grouped for display, newest observation first within a state.
 *
 * Ordering by state keeps a five-state crawl readable: Lagos rows do not get
 * separated from each other by an Abuja row that happened to be crawled next.
 */
export function groupByState(
  places: readonly DirectoryPlace[]
): Array<{ state: string; places: DirectoryPlace[] }> {
  const groups = new Map<string, DirectoryPlace[]>();

  for (const place of places) {
    const key = place.state ?? 'UNKNOWN';
    const bucket = groups.get(key);
    if (bucket) bucket.push(place);
    else groups.set(key, [place]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, grouped]) => ({
      state,
      places: [...grouped].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    }));
}

