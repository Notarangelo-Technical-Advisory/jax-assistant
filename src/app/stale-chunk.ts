import { NavigationError } from '@angular/router';

// Each page (contacts, journal, ...) is a separate script file whose name changes
// with every deploy, and the hosting only keeps the newest files. A tab opened
// before a deploy still asks for the old names, so moving to another page fails
// and the click seems to do nothing. Loading the page again fetches the new files.

/**
 * Each browser words this error differently. Safari on the iPhone reports the
 * index.html it got back: "'text/html' is not a valid JavaScript MIME type."
 */
const STALE_CHUNK = /dynamically imported module|Importing a module script failed|module script|not a valid JavaScript MIME type/i;

/** Remembers the last reload, so a page that is really broken is not reloaded forever. */
const LAST_RELOAD_KEY = 'staleChunkReload';
const RELOAD_GAP_MS = 10_000;

export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return STALE_CHUNK.test(message);
}

/**
 * Router error handler: on a stale script file, loads the page the user asked for
 * from the server. Reloads at most once per 10 seconds for the same address.
 */
export function reloadOnStaleChunk(
  event: NavigationError,
  storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage,
  load: (url: string) => void = (url) => location.assign(url),
  now = Date.now(),
): void {
  if (!isStaleChunkError(event.error)) return;
  const last = JSON.parse(storage.getItem(LAST_RELOAD_KEY) ?? 'null') as { url: string; at: number } | null;
  if (last?.url === event.url && now - last.at < RELOAD_GAP_MS) return;
  storage.setItem(LAST_RELOAD_KEY, JSON.stringify({ url: event.url, at: now }));
  load(event.url);
}
