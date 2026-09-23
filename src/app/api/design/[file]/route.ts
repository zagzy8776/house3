/**
 * Serves a screen SVG from design/screens/ for the /design gallery.
 *
 * Whitelist, not a sanitised path: the filename must match a strict pattern, and
 * the resolved path must still sit inside the screens directory. Path traversal
 * on a route handler is worth being boring about.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const SCREENS_DIR = path.join(process.cwd(), 'design', 'screens');
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*\.svg$/;

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;

  if (!SAFE_NAME.test(file)) {
    return new Response('Not found', { status: 404 });
  }

  const resolved = path.resolve(SCREENS_DIR, file);
  if (!resolved.startsWith(path.resolve(SCREENS_DIR) + path.sep)) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const svg = await readFile(resolved, 'utf8');
    return new Response(svg, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
