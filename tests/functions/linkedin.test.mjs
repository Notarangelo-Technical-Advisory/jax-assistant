// The pure helpers behind the weekly LinkedIn post. They enforce the rule that
// nothing is posted until Jack approves it, so they get tested without GitHub.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { comingTuesday, parseQueue, setQueueStatus, parseDraft, cardTuesday, describeWeek } =
  fromFunctions('./lib/linkedin.js');

const row = (date, title, status) =>
  `| ${date} Tue | ${title} | 1. It is software now | Write down how it works (Level 1) | Standard | First line of ${title}. | no | ${status} |`;

const queue = [
  '| Date | Title | Theme | Practice | Format | First line | Offer | Status |',
  '|---|---|---|---|---|---|---|---|',
  row('2026-10-06', 'Every tool needs an owner', 'posted'),
  row('2026-10-13', 'Write it down', 'drafted'),
  row('2026-10-20', 'Odd status', 'maybe'),
  row('2026-10-27', 'Next idea', 'idea'),
].join('\n');

describe('Coming Tuesday', () => {
  it('is today when today is Tuesday', () => {
    assert.equal(comingTuesday(new Date('2026-10-06T15:00:00Z')), '2026-10-06');
  });

  it('is the next Tuesday when today is Wednesday', () => {
    assert.equal(comingTuesday(new Date('2026-10-07T15:00:00Z')), '2026-10-13');
  });

  it('is still that Tuesday at 10 PM Eastern, though UTC has reached Wednesday', () => {
    assert.equal(comingTuesday(new Date('2026-10-07T02:00:00Z')), '2026-10-06');
  });
});

describe('Reading the queue', () => {
  it('skips the header, the separator and any row with an unknown status', () => {
    const rows = parseQueue(queue);
    assert.deepEqual(rows.map((r) => r.date), ['2026-10-06', '2026-10-13', '2026-10-27']);
    assert.equal(rows[0].title, 'Every tool needs an owner');
    assert.equal(rows[0].dateCell, '2026-10-06 Tue');
    assert.equal(rows[0].status, 'posted');
  });
});

describe('Changing a status in the queue', () => {
  it('changes only the Status cell of the named row', () => {
    const out = setQueueStatus(queue, '2026-10-13', 'approved');
    const before = queue.split('\n');
    const after = out.split('\n');
    assert.equal(after.length, before.length);
    after.forEach((line, i) => {
      if (i === 3) assert.equal(line, before[i].replace(/drafted \|$/, 'approved |'));
      else assert.equal(line, before[i]);
    });
  });

  it('refuses a date the queue does not have', () => {
    assert.throws(() => setQueueStatus(queue, '2026-11-03', 'approved'), /no row for 2026-11-03/);
  });
});

describe('Reading a draft', () => {
  const md = [
    '# Write it down',
    '',
    '- **Status:** drafted',
    '',
    '## Post',
    '',
    '```',
    'Line one of the post.',
    '[STORY: a client example]',
    '```',
    '',
    '## First comment',
    '',
    'See the checklist at [LINK].',
    '',
    '## Image',
    '',
    'No image needed.',
    '',
  ].join('\n');

  it('takes the post from its fenced block and lists the placeholders', () => {
    const d = parseDraft('posts/2026-10-13-write-it-down.md', md);
    assert.equal(d.post, 'Line one of the post.\n[STORY: a client example]');
    assert.equal(d.firstComment, 'See the checklist at [LINK].');
    assert.equal(d.image, 'No image needed.');
    assert.deepEqual(d.placeholders, ['[STORY: a client example]', '[LINK]']);
  });
});

describe('Which Tuesday the card shows', () => {
  const rows = parseQueue(queue);

  it('skips a Tuesday that is already posted', () => {
    // Monday 5 Oct: the coming Tuesday is 6 Oct, which is posted.
    assert.equal(cardTuesday(rows, new Date('2026-10-05T15:00:00Z')), '2026-10-13');
  });

  it('shows the coming Tuesday when it is not posted', () => {
    assert.equal(cardTuesday(rows, new Date('2026-10-12T15:00:00Z')), '2026-10-13');
  });
});

describe('Telling Jack about the week', () => {
  const base = {
    tuesday: '2026-10-13', title: 'Write it down', status: 'drafted',
    stage: 'needs-approval', draft: null, draftUrl: null,
    remaining: 5, lowQueue: false, postUrl: null,
  };

  it('asks for approval when a draft is ready', () => {
    const text = describeWeek({ ...base, draft: { placeholders: [] } });
    assert.match(text, /is ready\. Please approve it/);
    assert.match(text, /Oct 13/);
  });

  it('names the placeholders to fill when the draft has some', () => {
    const text = describeWeek({ ...base, draft: { placeholders: ['[LINK]'] } });
    assert.match(text, /placeholders to fill: \[LINK\]/);
    assert.doesNotMatch(text, /Please approve/);
  });

  it('says nothing should be published when nothing is approved on Tuesday', () => {
    const text = describeWeek({ ...base, stage: 'missing-today' });
    assert.match(text, /nothing should be published/);
  });
});
