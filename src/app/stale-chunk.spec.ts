import { NavigationError } from '@angular/router';
import { isStaleChunkError, reloadOnStaleChunk } from './stale-chunk';

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

const staleError = new TypeError('Failed to fetch dynamically imported module: https://x/chunk-ABC.js');

describe('isStaleChunkError', () => {
  it('recognises the Chrome, Safari and Firefox wording', () => {
    expect(isStaleChunkError(staleError)).toBeTrue();
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBeTrue();
    expect(isStaleChunkError(new TypeError('error loading dynamically imported module'))).toBeTrue();
  });

  it('ignores other errors', () => {
    expect(isStaleChunkError(new Error('permission-denied'))).toBeFalse();
    expect(isStaleChunkError(undefined)).toBeFalse();
  });
});

describe('reloadOnStaleChunk', () => {
  it('loads the address the user clicked', () => {
    const load = jasmine.createSpy('load');
    reloadOnStaleChunk(new NavigationError(1, '/contacts', staleError), memoryStorage(), load, 0);
    expect(load).toHaveBeenCalledOnceWith('/contacts');
  });

  it('does not reload for other navigation errors', () => {
    const load = jasmine.createSpy('load');
    reloadOnStaleChunk(new NavigationError(1, '/contacts', new Error('boom')), memoryStorage(), load, 0);
    expect(load).not.toHaveBeenCalled();
  });

  it('does not reload the same address again within 10 seconds', () => {
    const load = jasmine.createSpy('load');
    const storage = memoryStorage();
    reloadOnStaleChunk(new NavigationError(1, '/contacts', staleError), storage, load, 0);
    reloadOnStaleChunk(new NavigationError(2, '/contacts', staleError), storage, load, 5_000);
    expect(load).toHaveBeenCalledTimes(1);
    reloadOnStaleChunk(new NavigationError(3, '/contacts', staleError), storage, load, 11_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
