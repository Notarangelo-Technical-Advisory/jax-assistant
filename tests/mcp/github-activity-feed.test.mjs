// How readGitHubActivity (functions/src/mcp/github-activity.ts) reads the events
// feed: ordering, the start date, duplicates, issue, comment and push events, and
// the events it leaves out. Run with `npm run test:mcp`. The GitHub calls are a
// fake `api` function, so no test calls GitHub.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// src/mcp is run with tsx and never compiled, so tsx loads it here too.
const functionsDir = new URL('../../functions/', import.meta.url).pathname;
const { require: tsxRequire } = createRequire(`${functionsDir}package.json`)('tsx/cjs/api');
const { readGitHubActivity, GitHubActivityError } = tsxRequire(`${functionsDir}src/mcp/github-activity.ts`, import.meta.url);

const SINCE = new Date('2026-01-01T00:00:00Z');
const HEAD = 'abc123';

/** One event, with any field replaced. */
const event = (id, type, payload, over = {}) => ({
  id, type, created_at: '2026-02-01T10:00:00Z', repo: { name: 'o/r' }, payload, ...over,
});

/** Run the reader with a fake api. `extra` answers other paths, by path. */
function run(events, extra = {}, user = { login: 'jack' }) {
  const calls = [];
  const api = (path) => {
    calls.push(path);
    if (path === 'user') return user;
    if (path === 'users/jack/events?per_page=100&page=1') return events;
    if (path in extra) return extra[path];
    throw new Error(`unexpected path ${path}`);
  };
  return { result: readGitHubActivity(SINCE, api), calls };
}

describe('reading the feed', () => {
  it('throws a GitHubActivityError when GitHub does not say who is signed in', () => {
    assert.throws(() => run([], {}, {}), GitHubActivityError);
  });

  it('returns the items oldest first, although the feed is newest first', () => {
    const { result } = run([
      event('new', 'IssuesEvent', { action: 'opened', issue: { number: 2, title: 'B' } }, { created_at: '2026-02-02T10:00:00Z' }),
      event('old', 'IssuesEvent', { action: 'opened', issue: { number: 1, title: 'A' } }, { created_at: '2026-02-01T10:00:00Z' }),
    ]);
    assert.deepEqual(result.items.map((i) => i.sourceId), ['old', 'new']);
  });

  it('gives no item for an event before the start date, and does not count it as skipped', () => {
    const { result } = run([
      event('1', 'IssuesEvent', { action: 'opened', issue: { number: 1, title: 'A' } }, { created_at: '2025-12-31T23:59:59Z' }),
    ]);
    assert.equal(result.items.length, 0);
    assert.equal(result.skipped, 0);
  });

  it('gives one item for two events with the same id', () => {
    const e = event('1', 'IssuesEvent', { action: 'opened', issue: { number: 1, title: 'A' } });
    const { result } = run([e, e]);
    assert.equal(result.items.length, 1);
  });

  it('counts an event of a type it does not keep as skipped', () => {
    const { result } = run([event('1', 'WatchEvent', { action: 'started' })]);
    assert.equal(result.items.length, 0);
    assert.equal(result.skipped, 1);
  });
});

describe('issue and comment events', () => {
  it('journals an opened issue as Opened issue #5', () => {
    const { result } = run([event('1', 'IssuesEvent', { action: 'opened', issue: { number: 5, title: 'Fix it' } })]);
    assert.equal(result.items[0].action, 'Opened issue #5');
    assert.equal(result.items[0].subject, 'Fix it');
  });

  it('journals a comment on an issue that is a pull request as Commented on PR', () => {
    const { result } = run(
      [event('1', 'IssueCommentEvent', { issue: { number: 7, title: 'T', pull_request: { url: 'x' } } })],
      { 'repos/o/r/pulls/7': { title: 'T', html_url: 'https://github.com/o/r/pull/7', head: { ref: 'main' } } },
    );
    assert.equal(result.items[0].action, 'Commented on PR #7');
  });

  it('journals a comment on a plain issue as Commented on issue', () => {
    const { result } = run([event('1', 'IssueCommentEvent', { issue: { number: 8, title: 'T' } })]);
    assert.equal(result.items[0].action, 'Commented on issue #8');
  });
});

describe('push events', () => {
  it('journals a first push to a new branch from the one commit it reads', () => {
    const { result, calls } = run(
      [event('1', 'PushEvent', { ref: 'refs/heads/feature/CNG-1234-x', before: '0'.repeat(40), head: HEAD })],
      { [`repos/o/r/commits/${HEAD}`]: { commit: { message: 'Add the thing\n\nLonger body' } } },
    );
    assert.ok(calls.includes(`repos/o/r/commits/${HEAD}`));
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.action, 'Pushed to feature/CNG-1234-x');
    assert.equal(item.subject, 'Add the thing');
    assert.equal(item.detail, '1 commit');
    assert.equal(item.ticket, 'CNG-1234');
  });
});
