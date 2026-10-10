// Tests for the Maisie logo in the dashboard header. The header shows the
// round badge and the spaced-capitals wordmark; both must exist in public/,
// and the wordmark must render without a web font and be readable by a
// screen reader as "Maisie".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const template = readFileSync(`${root}src/app/components/dashboard/dashboard.component.html`, 'utf8');

const images = [...template.matchAll(/<img\s[^>]*>/g)].map(([tag]) => ({
  src: tag.match(/src="\/([^"]+)"/)?.[1],
  alt: tag.match(/alt="([^"]*)"/)?.[1],
  cls: tag.match(/class="([^"]+)"/)?.[1],
}));

describe('dashboard header logo', () => {
  it('serves every image the dashboard shows from public/', () => {
    assert.ok(images.length > 0, 'the dashboard shows no images');
    for (const { src } of images) {
      assert.ok(existsSync(`${root}public/${src}`), `public/${src} is missing`);
    }
  });

  it('names the wordmark "Maisie" for screen readers and hides the badge beside it', () => {
    const wordmark = images.find((i) => i.cls === 'header-wordmark');
    const badge = images.find((i) => i.cls === 'header-badge');
    assert.equal(wordmark?.alt, 'Maisie');
    assert.equal(badge?.alt, '', 'the badge repeats the name, so it should be hidden from screen readers');
  });

  for (const file of ['maisie-logo.svg', 'maisie-logo-light.svg']) {
    it(`draws ${file} as shapes, so it looks the same without the font installed`, () => {
      const svg = readFileSync(`${root}public/${file}`, 'utf8');
      assert.match(svg, /^<svg[^>]*\saria-label="Maisie"/);
      assert.doesNotMatch(svg, /<text[\s>]/);
      assert.doesNotMatch(svg, /<(script|image|use)[\s>]/, 'the logo must not load scripts or other files');
    });
  }
});
