// Tests for the work journal job that runs on Jack's Mac
// (functions/src/mcp/collect-journal.ts). Saved answers stand in for GitHub
// (gh api) and Jira, and a folder of session files stands in for Claude Code's,
// so nothing reaches the real services; the job then runs exactly as launchd
// runs it, against the Firestore emulator, in Jack's time zone.

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
  rmSync(SESSIONS, { recursive: true, force: true });
  mkdirSync(join(SESSIONS, '-cmsonline'), { recursive: true });
  write(join(SESSIONS, '-cmsonline', 'sess-1.jsonl'), SESSION);
});

/** Runs the job as launchd does. Returns its output and exit code. */
function runJob(...args) {
  try {
    const output = execFileSync(`${functionsDir}node_modules/.bin/tsx`, ['src/mcp/collect-journal.ts', ...args], {
      cwd: functionsDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST, GCLOUD_PROJECT: PROJECT_ID,
        MAISIE_GITHUB_FIXTURE: GITHUB_FIXTURE, MAISIE_JIRA_FIXTURE: JIRA_FIXTURE, MAISIE_CLAUDE_PROJECTS_DIR: SESSIONS,
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
      ['general', 'Pushed to main', 'Turn certificate checks back on', '2 commits', null],
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

  it("builds each day's summary and records how far each source was read", async () => {
    const { output, code } = await runJob();
    assert.equal(code, 0, output);

    const days = (await db.collection('journalDays').get()).docs.map(d => d.data());
    const all = await items();
    assert.deepEqual(days.map(d => d.day).sort(), [...new Set(all.map(i => i.day))].sort());
    assert.equal(days.reduce((n, d) => n + d.itemCount, 0), all.length);
    assert.ok(days.every(d => d.day === etDay(d.clients[0].sessions[0].start)));

    const s = await state();
    for (const source of ['github', 'jira', 'claude']) assert.ok(s[`${source}CheckedThrough`].toMillis() >= NOW - 60_000, source);
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

  it('when Jira fails, still journals GitHub and Claude Code, and says why Jira failed', async () => {
    write(JIRA_FIXTURE, {});
    const { output, code } = await runJob();

    assert.equal(code, 1);
    assert.match(output, /Jira: Jira answered 404 for \/rest\/api\/3\/myself/);
    assert.equal((await bySource('github')).length, 3);
    assert.equal((await bySource('claude')).length, 1);
    const s = await state();
    assert.equal(s.jiraCheckedThrough, undefined, 'Jira starts from the same place next time');
    assert.match(s.lastErrors[0], /^Jira:/);
  });
});
