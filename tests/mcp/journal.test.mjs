// Tests for the work journal job that runs on Jack's Mac
// (functions/src/mcp/collect-journal.ts). Saved answers stand in for GitHub
// (gh api), Jira, Apple Calendar and Wispr Flow's database, and a folder of session files stands in
// for Claude Code's, so nothing reaches the real services; the job then runs
// exactly as launchd runs it, against the Firestore emulator, in Jack's time zone.

import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const functionsDir = fileURLToPath(new URL('../../functions/', import.meta.url));
const admin = createRequire(`${functionsDir}package.json`)('firebase-admin');

const PROJECT_ID = 'demo-jax-mcp';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';

const dir = mkdtempSync(join(tmpdir(), 'maisie-journal-'));
const GITHUB_FIXTURE = join(dir, 'github.json');
const JIRA_FIXTURE = join(dir, 'jira.json');
const MEETINGS_FIXTURE = join(dir, 'meetings.json');
const WISPR_FIXTURE = join(dir, 'wispr.json');
const SESSIONS = join(dir, 'projects');

// A checkout of IHRDC/cmsonline for the Claude Code session to run in.
const CHECKOUT = join(dir, 'cmsonline');
mkdirSync(CHECKOUT);
execFileSync('git', ['-C', CHECKOUT, 'init', '-q']);
execFileSync('git', ['-C', CHECKOUT, 'remote', 'add', 'origin', 'https://github.com/IHRDC/cmsonline.git']);

// The job looks back 30 days from now, so the fixtures are dated from now too.
const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const etDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// GitHub's events feed as it is now: no pull request titles, no commit messages.
const GITHUB = {
  user: { login: 'jacknota' },
  'users/jacknota/events': [
    { id: '101', type: 'PullRequestEvent', created_at: ago(120), repo: { name: 'IHRDC/cmsonline' },
      payload: { action: 'opened', number: 674, pull_request: { number: 674, head: { ref: 'feature/CNG-7039' } } } },
    { id: '102', type: 'PullRequestReviewEvent', created_at: ago(110), repo: { name: 'IHRDC/ai-toolkit' },
      payload: { review: { state: 'approved', html_url: 'https://github.com/IHRDC/ai-toolkit/pull/12#pullrequestreview-1' }, pull_request: { number: 12 } } },
    { id: '103', type: 'PushEvent', created_at: ago(100), repo: { name: 'Notarangelo-Technical-Advisory/jax-assistant' },
      payload: { ref: 'refs/heads/main', before: 'aaa111', head: 'bbb222' } },
    { id: '104', type: 'DeleteEvent', created_at: ago(99), repo: { name: 'IHRDC/cmsonline' },
      payload: { ref: 'feature/CNG-7039', ref_type: 'branch' } },
    // Before the first run's 30 days.
    { id: '105', type: 'PushEvent', created_at: ago(60 * 24 * 40), repo: { name: 'IHRDC/cmsonline' },
      payload: { ref: 'refs/heads/develop', before: 'ccc', head: 'ddd' } },
  ],
  'repos/IHRDC/cmsonline/pulls/674': { title: 'Fix saved grid layout', html_url: 'https://github.com/IHRDC/cmsonline/pull/674', head: { ref: 'feature/CNG-7039' } },
  'repos/IHRDC/ai-toolkit/pulls/12': { title: 'Story agent: resolve the Sub-Task', html_url: 'https://github.com/IHRDC/ai-toolkit/pull/12', head: { ref: 'feature/CNG-7170' } },
  'repos/Notarangelo-Technical-Advisory/jax-assistant/compare/aaa111...bbb222': {
    html_url: 'https://github.com/Notarangelo-Technical-Advisory/jax-assistant/compare/aaa111...bbb222', total_commits: 2,
    commits: [{ commit: { message: 'Add tests' } }, { commit: { message: 'Turn certificate checks back on\n\nDetails.' } }],
  },
};

const JACK = { accountId: 'acc-jack', displayName: 'Jack Notarangelo' };
const AMY = { accountId: 'acc-amy', displayName: 'Amy Lee' };
const JIRA = {
  '/rest/api/3/myself': JACK,
  '/rest/api/3/search/jql': { issues: [
    { key: 'CNG-7039', fields: { summary: 'Saved grid layout drops columns', created: ago(60 * 24 * 60), creator: AMY, issuetype: { name: 'Bug' } } },
    { key: 'CNG-7186', fields: { summary: 'Story agent: tell the engineer', created: ago(95), creator: JACK, issuetype: { name: 'Story' } } },
  ] },
  '/rest/api/3/issue/CNG-7039/changelog': { isLast: true, values: [
    { id: '1', created: ago(90), author: JACK, items: [{ field: 'status', fromString: 'In Progress', toString: 'Code Review' }] },
    { id: '2', created: ago(89), author: AMY, items: [{ field: 'status', fromString: 'Code Review', toString: 'Done' }] },
    { id: '3', created: ago(60 * 24 * 45), author: JACK, items: [{ field: 'summary' }] },
  ] },
  '/rest/api/3/issue/CNG-7039/comment': { comments: [
    { id: '10', created: ago(88), author: JACK },
    { id: '11', created: ago(87), author: AMY },
  ] },
  '/rest/api/3/issue/CNG-7186/changelog': { isLast: true, values: [
    { id: '20', created: ago(94), author: JACK, items: [{ field: 'assignee', toString: 'Jack Notarangelo' }] },
  ] },
  '/rest/api/3/issue/CNG-7186/comment': { comments: [] },
};

// What the EventKit script in apple-meetings.ts prints. Times are seconds since 1970.
const seconds = (minutesAgo) => Math.round((NOW - minutesAgo * 60_000) / 1000);
const event = (fields) => ({
  uid: 'uid-x', title: 'x', start: seconds(300), end: seconds(240), allDay: false, free: false, declined: false,
  calendar: 'Calendar', people: [], ...fields,
});
const MEETINGS = {
  ok: true,
  missing: [],
  events: [
    event({ uid: 'uid-review', title: 'Product Review Meeting', people: ['brad@ihrdc.com', 'gabor@ihrdc.com'] }),
    event({ uid: 'uid-cox', title: 'Cox discovery', calendar: 'Jax', start: seconds(200), end: seconds(140) }),
    event({ uid: 'uid-officers', title: 'Officer Meeting', calendar: 'Jax', start: seconds(130), end: seconds(125), people: ['elder@example.com'] }),
    // Left out: a personal block on the IHRDC calendar, a personal event, a reminder marked Free,
    // a declined meeting, an all-day event, and a meeting still going on.
    event({ uid: 'uid-doctor', title: 'Norma Dr Appt' }),
    event({ uid: 'uid-driveway', title: 'Edge the driveway', calendar: 'Jax' }),
    event({ uid: 'uid-reminder', title: 'Request demo for Friday', free: true }),
    event({ uid: 'uid-declined', title: 'Bug tickets - Product management', declined: true, people: ['amy@ihrdc.com'] }),
    event({ uid: 'uid-delivery', title: 'Walden Local delivery', calendar: 'Jax', allDay: true }),
    event({ uid: 'uid-sync', title: 'Claude Code - Weekly Sync', start: seconds(10), end: seconds(-50), people: ['brad@ihrdc.com'] }),
  ],
};

// What sqlite3 -json prints for the query in wispr-recordings.ts. Wispr Flow
// keeps the start as text in UTC and the end in milliseconds.
const sqliteTime = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString().replace('T', ' ').replace('Z', ' +00:00');
const WISPR = [
  // During the Product Review meeting (5 to 4 hours ago).
  { id: 'rec-review', title: 'Production Deployment and Webinar Scheduling', createdAt: sqliteTime(290), endedAt: NOW - 250 * 60_000, shareSlug: 'slug-review' },
  // An IHRDC Jira key in the title, and no meeting at the time.
  { id: 'rec-cng', title: 'Approving CNG-6882 Map', createdAt: sqliteTime(30), endedAt: NOW - 27 * 60_000, shareSlug: null },
  // Left out: no meeting at the time and nothing in the title, and one still recording.
  { id: 'rec-unknown', title: 'Legacy vs Next-Gen Comparison', createdAt: sqliteTime(100), endedAt: NOW - 80 * 60_000, shareSlug: 'slug-unknown' },
  { id: 'rec-live', title: '', createdAt: sqliteTime(5), endedAt: null, shareSlug: null },
];

/** One line of a Claude Code session file. */
const line = (minutesAgo, type, content, extra = {}) => JSON.stringify({
  type, timestamp: ago(minutesAgo), cwd: CHECKOUT, gitBranch: 'feature/CNG-7039', sessionId: 'sess-1', isSidechain: false,
  entrypoint: 'claude-vscode', message: { role: type, content }, ...extra,
});
const SESSION = [
  line(80, 'user', [{ type: 'text', text: 'Fix the saved grid layout' }]),
  line(78, 'assistant', [{ type: 'text', text: 'Looking.' }]),
  line(70, 'user', [{ type: 'tool_result', content: 'ok' }]),
  line(60, 'assistant', [{ type: 'text', text: 'Done.' }]),
  // A background task finishing 40 minutes later, with no prompt from Jack.
  line(20, 'user', '<task-notification>finished</task-notification>'),
  line(19, 'assistant', [{ type: 'text', text: 'The tests passed.' }]),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Fix saved grid layout columns', sessionId: 'sess-1' }),
].join('\n');

const write = (file, value) => writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));

let db;

before(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
  db = admin.firestore();
});

beforeEach(async () => {
  await fetch(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: 'DELETE' });
  write(GITHUB_FIXTURE, GITHUB);
  write(JIRA_FIXTURE, JIRA);
  write(MEETINGS_FIXTURE, MEETINGS);
  write(WISPR_FIXTURE, WISPR);
  rmSync(SESSIONS, { recursive: true, force: true });
  mkdirSync(join(SESSIONS, '-cmsonline'), { recursive: true });
  write(join(SESSIONS, '-cmsonline', 'sess-1.jsonl'), SESSION);
});

/** Runs the job as launchd does, or another script with `script`. Returns its output and exit code. */
function runJob(...args) {
  return runScript('src/mcp/collect-journal.ts', ...args);
}

function runScript(script, ...args) {
  try {
    const output = execFileSync(`${functionsDir}node_modules/.bin/tsx`, [script, ...args], {
      cwd: functionsDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST, GCLOUD_PROJECT: PROJECT_ID,
        MAISIE_GITHUB_FIXTURE: GITHUB_FIXTURE, MAISIE_JIRA_FIXTURE: JIRA_FIXTURE, MAISIE_CLAUDE_PROJECTS_DIR: SESSIONS,
        MAISIE_MEETINGS_FIXTURE: MEETINGS_FIXTURE, MAISIE_WISPR_FIXTURE: WISPR_FIXTURE,
        TZ: 'America/New_York',
      },
    });
    return { output, code: 0 };
  } catch (err) {
    return { output: `${err.stdout}${err.stderr}`, code: err.status };
  }
}

const items = async () => (await db.collection('journal').get()).docs.map(d => d.data());
const state = async () => (await db.doc('metadata/journal').get()).data();
const bySource = async (source) => (await items()).filter(i => i.source === source).sort((a, b) => a.at.localeCompare(b.at));

describe('work journal job', () => {
  it('journals pull requests, reviews and pushes, with their titles and commit messages, under the right client', async () => {
    const { output, code } = await runJob();
    assert.equal(code, 0, output);

    const github = (await bySource('github')).map(i => [i.client, i.action, i.subject, i.detail, i.ticket]);
    assert.deepEqual(github, [
      ['ihrdc', 'Opened PR #674', 'Fix saved grid layout', 'feature/CNG-7039', 'CNG-7039'],
      ['ihrdc', 'Approved PR #12', 'Story agent: resolve the Sub-Task', null, 'CNG-7170'],
      ['executive_assistant', 'Pushed to main', 'Turn certificate checks back on', '2 commits', null],
    ]);
    assert.match(output, /GitHub since .*: 3 read, 3 new.*as jacknota; events left out: 1\)/);
  });

  it("journals only Jack's own Jira changes, comments and new issues, each at its own time", async () => {
    const { output, code } = await runJob();
    assert.equal(code, 0, output);

    const jira = (await bySource('jira')).map(i => [i.client, i.ticket, i.action, i.detail]);
    assert.deepEqual(jira, [
      ['ihrdc', 'CNG-7186', 'Created Story CNG-7186', null],
      ['ihrdc', 'CNG-7186', 'Took CNG-7186', null],
      ['ihrdc', 'CNG-7039', 'Moved CNG-7039 to Code Review', 'In Progress → Code Review'],
      ['ihrdc', 'CNG-7039', 'Commented on CNG-7039', null],
    ]);
    const comment = (await bySource('jira')).find(i => i.action.startsWith('Commented'));
    assert.equal(comment.url, 'https://ihrdcdev.atlassian.net/browse/CNG-7039?focusedCommentId=10');
  });

  it('journals the Claude Code work Jack prompted, with its repo, branch and title, but not his prompts', async () => {
    const { output, code } = await runJob();
    assert.equal(code, 0, output);

    const claude = await bySource('claude');
    assert.equal(claude.length, 1, 'the background task with no prompt from Jack is left out');
    const [s] = claude;
    assert.deepEqual([s.client, s.repo, s.ticket, s.action, s.subject, s.detail],
      ['ihrdc', 'IHRDC/cmsonline', 'CNG-7039', 'Claude Code in cmsonline', 'Fix saved grid layout columns', 'feature/CNG-7039 · 1 prompt']);
    assert.deepEqual([s.at, s.endAt], [ago(80), ago(60)]);
    assert.doesNotMatch(JSON.stringify(claude), /Fix the saved grid layout"/);
  });

  it('journals ended meetings on the Jax and IHRDC calendars under their client, and leaves out personal events', async () => {
    const { output, code } = await runJob();
    assert.equal(code, 0, output);

    const meetings = (await bySource('meeting')).map(i => [i.client, i.subject, i.action, i.detail]);
    assert.deepEqual(meetings, [
      ['ihrdc', 'Product Review Meeting', 'Meeting with 2 others', 'IHRDC calendar'],
      ['cox', 'Cox discovery', 'Meeting', 'Jax calendar'],
      ['church', 'Officer Meeting', 'Meeting with 1 other person', 'Jax calendar'],
    ]);
    const [review] = await bySource('meeting');
    assert.deepEqual([review.at, review.endAt], [seconds(300), seconds(240)].map(t => new Date(t * 1000).toISOString()));
    assert.match(output, /Calendar since .*: 3 read, 3 new.*meetings on the calendars: 9; left out: 2 with no client, 1 all-day, 1 marked Free, 1 declined, 1 not ended yet\)/);
    assert.match(output, /By client: IHRDC 1, Cox Engineering 1, Church 1/);
  });

  it('journals Wispr Flow recordings under the client of the meeting they overlap or of their title, and leaves out the rest', async () => {
    const { output, code } = await runJob();
    assert.equal(code, 0, output);

    const recordings = (await bySource('recording')).map(i => [i.client, i.subject, i.detail, i.url, i.ticket]);
    assert.deepEqual(recordings, [
      ['ihrdc', 'Production Deployment and Webinar Scheduling', 'During Product Review Meeting', 'https://notes.wisprflow.ai/shared/slug-review', null],
      ['ihrdc', 'Approving CNG-6882 Map', 'CNG-6882 in the title', null, 'CNG-6882'],
    ]);
    const [review] = await bySource('recording');
    assert.deepEqual([review.at, review.endAt], [ago(290), ago(250)]);
    assert.match(output, /Wispr Flow since .*: 2 read, 2 new.*recordings: 4; left out: 1 with no client, 1 not ended yet\)/);
  });

  it("when Wispr Flow's database cannot be read, still journals the other sources, and says why", async () => {
    write(WISPR_FIXTURE, 'Error: unable to open database file');
    const { output, code } = await runJob();

    assert.equal(code, 1);
    assert.match(output, /Wispr Flow: Wispr Flow returned unreadable output/);
    assert.equal((await bySource('meeting')).length, 3);
    assert.equal((await bySource('recording')).length, 0);
    assert.equal((await state()).recordingsCheckedThrough, undefined, 'Wispr Flow starts from the same place next time');
  });

  it('when the calendar cannot be read, still journals the other sources, and says why', async () => {
    write(MEETINGS_FIXTURE, { ok: false, error: 'no_calendar_access', status: 2 });
    const { output, code } = await runJob();

    assert.equal(code, 1);
    assert.match(output, /Calendar: Not allowed to read Calendars/);
    assert.equal((await bySource('github')).length, 3);
    assert.equal((await bySource('meeting')).length, 0);
    assert.equal((await state()).meetingsCheckedThrough, undefined, 'the calendar starts from the same place next time');
  });

  it("counts Claude Code work that moves to another folder or branch after Jack's prompt, with no pause", async () => {
    const subfolder = join(CHECKOUT, 'functions');
    mkdirSync(subfolder, { recursive: true });
    const at = (minutesAgo, type, content, extra) => line(minutesAgo, type, content, { sessionId: 'sess-2', ...extra });
    write(join(SESSIONS, '-cmsonline', 'sess-2.jsonl'), [
      at(50, 'user', [{ type: 'text', text: 'Run the tests' }], { gitBranch: 'main' }),
      at(45, 'assistant', [{ type: 'text', text: 'Running.' }], { gitBranch: 'main' }),
      // No prompt from Jack here, but no pause either: still his work.
      at(40, 'assistant', [{ type: 'text', text: 'On the branch now.' }], { cwd: subfolder, gitBranch: 'feature/CNG-7200' }),
      at(30, 'assistant', [{ type: 'text', text: 'Done.' }], { cwd: subfolder, gitBranch: 'feature/CNG-7200' }),
    ].join('\n'));
    const { output, code } = await runJob();
    assert.equal(code, 0, output);

    const spans = (await bySource('claude')).filter(i => i.sourceId.startsWith('sess-2')).map(i => [i.detail, i.ticket, i.at, i.endAt]);
    assert.deepEqual(spans, [
      ['main · 1 prompt', null, ago(50), ago(45)],
      ['feature/CNG-7200', 'CNG-7200', ago(40), ago(30)],
    ]);
  });

  it("builds each day's summary and records how far each source was read", async () => {
    const { output, code } = await runJob();
    assert.equal(code, 0, output);

    const days = (await db.collection('journalDays').get()).docs.map(d => d.data());
    const all = await items();
    assert.deepEqual(days.map(d => d.day).sort(), [...new Set(all.map(i => i.day))].sort());
    assert.equal(days.reduce((n, d) => n + d.itemCount, 0), all.length);
    assert.ok(days.every(d => d.day === etDay(d.clients[0].sessions[0].start)));

    const s = await state();
    for (const source of ['github', 'jira', 'claude', 'meetings', 'recordings']) assert.ok(s[`${source}CheckedThrough`].toMillis() >= NOW - 60_000, source);
    assert.deepEqual(s.lastErrors, []);
  });

  it('a later run reads only from an hour before the last one, and reading the same work again adds nothing', async () => {
    await runJob();
    const before = (await items()).length;

    const next = runJob();
    assert.equal(next.code, 0, next.output);
    assert.match(next.output, /GitHub since .*: 0 read/);

    // Forget how far it read, so the whole 30 days are read again.
    await db.doc('metadata/journal').delete();
    const again = runJob();
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /GitHub since .*: 3 read, 0 new, 0 changed, 3 already in the journal/);
    assert.equal((await items()).length, before);
  });

  it('a dry run prints what it would add and writes nothing, not even its progress', async () => {
    const { output, code } = await runJob('--dry-run');

    assert.equal(code, 0, output);
    assert.match(output, /Dry run: nothing was written/);
    assert.match(output, /Jira since .*: 4 read, 4 new.*from 2 issues/);
    assert.match(output, /By client: IHRDC 4/);
    assert.deepEqual(await items(), []);
    assert.equal(await state(), undefined);
  });

  it('when Jira fails, still journals the other sources, and says why Jira failed', async () => {
    write(JIRA_FIXTURE, {});
    const { output, code } = await runJob();

    assert.equal(code, 1);
    assert.match(output, /Jira: Jira answered 404 for \/rest\/api\/3\/myself/);
    assert.equal((await bySource('github')).length, 3);
    assert.equal((await bySource('claude')).length, 1);
    assert.equal((await bySource('meeting')).length, 3);
    const s = await state();
    assert.equal(s.jiraCheckedThrough, undefined, 'Jira starts from the same place next time');
    assert.match(s.lastErrors[0], /^Jira:/);
  });
});

describe('journal:reclassify', () => {
  it("can be run from a terminal: a dry run says what would move, then a run moves it and names the client", async () => {
    await db.collection('taskCategories').add({ key: 'executive_assistant', label: 'Executive Assistant', order: 101 });
    await runJob();
    // As stored before Maisie's repo had its own client.
    const [push] = (await db.collection('journal').where('repo', '==', 'Notarangelo-Technical-Advisory/jax-assistant').get()).docs;
    await push.ref.update({ client: 'general' });

    const dry = runScript('src/mcp/reclassify-journal.ts', '--dry-run');
    assert.equal(dry.code, 0, dry.output);
    assert.match(dry.output, /Dry run: nothing was written/);
    assert.match(dry.output, /1 would move to another client\.\n  General → Executive Assistant: 1/);
    assert.equal((await push.ref.get()).get('client'), 'general');

    const run = runScript('src/mcp/reclassify-journal.ts');
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /1 moved to another client/);
    assert.equal((await push.ref.get()).get('client'), 'executive_assistant');
    const day = (await db.doc(`journalDays/${(await push.ref.get()).get('day')}`).get()).data();
    assert.ok(day.clients.some(c => c.label === 'Executive Assistant'));
  });
});

describe('Jira sign-in', () => {
  // src/mcp is run with tsx and never compiled, so tsx loads it here too.
  const { require: tsxRequire } = createRequire(`${functionsDir}package.json`)('tsx/cjs/api');
  const { httpJiraApi, JIRA_CLOUD_ID } = tsxRequire(`${functionsDir}src/mcp/jira-activity.ts`, import.meta.url);
  const GATEWAY = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}`;
  const SITE = 'https://ihrdcdev.atlassian.net';

  /** A stand-in for fetch that accepts the token at the addresses given, and records every address asked. */
  function fakeJira(accepts) {
    const asked = [];
    const fetchJira = async (url, init) => {
      asked.push(url);
      assert.equal(init.headers.Authorization, `Basic ${Buffer.from('jack@ihrdc.com:secret').toString('base64')}`);
      const ok = accepts.some(base => url.startsWith(base));
      return new Response(ok ? JSON.stringify({ url }) : 'Unauthorized', { status: ok ? 200 : 401 });
    };
    return { asked, api: httpJiraApi('jack@ihrdc.com', 'secret', fetchJira) };
  }

  it('uses the gateway for a token with scopes, for every request', async () => {
    const { asked, api } = fakeJira([GATEWAY]);
    await api('/rest/api/3/myself');
    await api('/rest/api/3/issue/CNG-1/comment');

    assert.deepEqual(asked, [`${GATEWAY}/rest/api/3/myself`, `${GATEWAY}/rest/api/3/issue/CNG-1/comment`]);
  });

  it('falls back to the site for a token without scopes, and stays there', async () => {
    const { asked, api } = fakeJira([SITE]);
    await api('/rest/api/3/myself');
    await api('/rest/api/3/issue/CNG-1/comment');

    assert.deepEqual(asked, [`${GATEWAY}/rest/api/3/myself`, `${SITE}/rest/api/3/myself`, `${SITE}/rest/api/3/issue/CNG-1/comment`]);
  });

  it('says the token was refused, and what it needs, when neither address accepts it', async () => {
    const { api } = fakeJira([]);
    await assert.rejects(api('/rest/api/3/myself'), /refused the token .*HTTP 401.*read:jira-work and read:jira-user/);
  });
});
