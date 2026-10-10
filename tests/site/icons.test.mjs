// Tests for the browser tab icon and the phone home-screen icon. Every icon
// that src/index.html links to must exist in public/ at the size it declares,
// so a browser never shows a broken or blurry icon.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const indexHtml = readFileSync(`${root}src/index.html`, 'utf8');

// Width and height from a PNG file's IHDR header.
function pngSize(file) {
  const bytes = readFileSync(file);
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `${file} is not a PNG file`);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

const iconLinks = [...indexHtml.matchAll(/<link\s+rel="(icon|apple-touch-icon)"[^>]*>/g)].map(([tag, rel]) => ({
  rel,
  href: tag.match(/href="\/([^"]+)"/)?.[1],
  sizes: tag.match(/sizes="([^"]+)"/)?.[1],
}));

describe('site icons', () => {
  it('links a browser tab icon and a phone home-screen icon', () => {
    assert.deepEqual(iconLinks.map((l) => l.rel).sort(), ['apple-touch-icon', 'icon']);
  });

  for (const { rel, href, sizes } of iconLinks) {
    it(`serves the ${rel} file at the size the page declares`, () => {
      const file = `${root}public/${href}`;
      assert.ok(existsSync(file), `public/${href} is missing`);
      assert.equal(pngSize(file), sizes);
    });
  }

  it('keeps a favicon.ico for browsers that request it without reading the page', () => {
    const bytes = readFileSync(`${root}public/favicon.ico`);
    assert.equal(bytes.readUInt16LE(2), 1, 'favicon.ico is not an icon file');
  });
});
