// Tests for how the Headlines tab gathers stories. fetch is replaced with
// fixed feeds, so nothing reaches Bing News or any publisher.

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { gatherCandidates } = fromFunctions('./lib/headlines.js');

const NOW = new Date('2026-03-10T15:00:00Z');
const HOURS_AGO = (h) => new Date(NOW.getTime() - h * 3600_000).toUTCString();

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function rss(items) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:News="https://www.bing.com/news/search?q=&amp;format=rss">
<channel><title>Feed</title><link>https://example.com/</link>
${items.join('\n')}
</channel></rss>`;
}

function item({ title, link, hoursAgo = 1, source }) {
  return `<item><title>${title}</title><link>${link}</link><pubDate>${HOURS_AGO(hoursAgo)}</pubDate>` +
    `<description>About ${title}</description>${source ? `<News:Source>${source}</News:Source>` : ''}</item>`;
}

/** Bing wraps each article link in its click-tracking page. */
const bingLink = (article) =>
  `http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=abc&amp;url=${encodeURIComponent(article)}&amp;c=123&amp;mkt=en-us`;

/** Serves `bing` for every Bing search, `feeds[url]` for a direct feed, and an empty feed otherwise. */
function serve({ bing = rss([]), feeds = {} } = {}) {
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    const body = url.includes('bing.com/news/search') ? bing : (feeds[url] ?? rss([]));
    return new Response(body, { status: 200 });
  };
  return requested;
}

describe('news searches', () => {
  it('search Bing News and never Google News', async () => {
    const requested = serve();
    const { errors } = await gatherCandidates(null, false, NOW);

    assert.deepEqual(errors, []);
    assert.ok(requested.some(u => u.startsWith('https://www.bing.com/news/search?') && u.includes('format=rss')));
    assert.equal(requested.filter(u => u.includes('news.google.com')).length, 0);
  });

  it('a Bing story links to the article itself and names its publisher', async () => {
    serve({ bing: rss([item({ title: 'Fed holds rates', link: bingLink('https://www.reuters.com/markets/fed-holds'), source: 'Reuters' })]) });
    const { candidates } = await gatherCandidates(null, false, NOW);

    // Every search returns the same story, so it is kept once.
    const fed = candidates.filter(c => c.title === 'Fed holds rates');
    assert.equal(fed.length, 1);
    assert.equal(fed[0].url, 'https://www.reuters.com/markets/fed-holds');
    assert.equal(fed[0].sourceName, 'Reuters');
  });

  it('a Bing story with no publisher is credited to Bing News', async () => {
    serve({ bing: rss([item({ title: 'Unnamed outlet story', link: bingLink('https://example.org/story') })]) });
    const { candidates } = await gatherCandidates(null, false, NOW);

    assert.equal(candidates.find(c => c.title === 'Unnamed outlet story').sourceName, 'Bing News');
  });
});

describe('publisher feeds', () => {
  const CNBC = 'https://www.cnbc.com/id/100003114/device/rss/rss.html';
  const TECHCRUNCH = 'https://techcrunch.com/category/artificial-intelligence/feed/';
  const twelve = (name) => rss(Array.from({ length: 12 }, (_, i) =>
    item({ title: `${name} story ${i + 1}`, link: `https://example.com/${name}/${i + 1}`, hoursAgo: i + 1 })));

  it('CNBC keeps its 10 newest stories and TechCrunch its 5 newest', async () => {
    serve({ feeds: { [CNBC]: twelve('cnbc'), [TECHCRUNCH]: twelve('techcrunch') } });
    const { candidates } = await gatherCandidates(null, false, NOW);

    const cnbc = candidates.filter(c => c.sourceName === 'CNBC');
    const techcrunch = candidates.filter(c => c.sourceName === 'TechCrunch');
    assert.equal(cnbc.length, 10);
    assert.ok(cnbc.every(c => c.section === 'markets'));
    assert.equal(techcrunch.length, 5);
    assert.ok(techcrunch.every(c => c.section === 'ai'));
    assert.equal(techcrunch[0].title, 'techcrunch story 1');
  });

  it('a feed that fails is reported, and the other sources still count', async () => {
    serve({ feeds: { [CNBC]: twelve('cnbc') } });
    const working = globalThis.fetch;
    globalThis.fetch = async (url) =>
      url.includes('bing.com') ? new Response('', { status: 503 }) : working(url);
    const { candidates, errors } = await gatherCandidates(null, false, NOW);

    assert.ok(errors.length > 0);
    assert.ok(errors.every(e => e.startsWith('Bing News:') && e.endsWith('HTTP 503')));
    assert.equal(candidates.filter(c => c.sourceName === 'CNBC').length, 10);
  });
});
